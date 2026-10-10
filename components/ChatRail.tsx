"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { ArrowUp, ChevronDown, ChevronUp, Square } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { WallyMark } from "@/components/Brand";
import { DotSpinner } from "@/components/DotSpinner";
import { EmptyState } from "@/components/EmptyState";
import { PreviewControl } from "@/components/PreviewControl";
import { ToolTrace } from "@/components/ToolTrace";
import { TopoHeartbeat } from "@/components/TopoHeartbeat";
import { toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { onChatSend } from "@/lib/agent/chatBus";
import { dedupeNoteAndText } from "@/lib/agent/dedupe";
import { extractFollowUps } from "@/lib/agent/followups";
import { buildChatBody, type MapView } from "@/lib/agent/view";
import type { Padding } from "@/lib/render/deck";
import type { MapAction, RenderOp } from "@/lib/render/state";
import { visibleMapPadding } from "@/lib/render/viewportPadding";

type ChatRailProps = {
  /** Null until `/api/layers` answers; tool results wait for it so layers get their real styles. */
  catalog: LayerCatalog | null;
  renderOps: RenderOp[];
  getCanvasSize: () => { width: number; height: number };
  /** The live map's view inside the given padding, read when a message is sent so the agent knows what "here" is. */
  getView?: (padding: Padding) => MapView | null;
  onActions: (actions: MapAction[]) => void;
  collapsed: boolean;
  onToggle: () => void;
  /** The layer panel is open on the right, so fitted results must stay left of it. */
  layerPanelOpen?: boolean;
  /** Whether the suggestions card may show (App: first visit, or the "i" pill), also mid-conversation. Unset: shows while the chat is empty. */
  suggestionsOpen?: boolean;
  /** The card's × was pressed. */
  onSuggestionsClose?: () => void;
  /** The first message went out, so the card counts as seen. */
  onSuggestionsSeen?: () => void;
};

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

function parsedError(error: Error): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(error.message);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Not JSON: the message is already prose.
    return null;
  }
}

/** True when the chat route refused the history as too big (413), so only a new chat can go on. */
export function isConversationTooLong(error: Error): boolean {
  return parsedError(error)?.error === "Request too large";
}

/** The chat route answers failures with `{ error }` JSON; show that sentence rather than raw JSON. */
export function readableError(error: Error): string {
  const parsed = parsedError(error);
  if (parsed?.scope === "daily") return "The map has reached today's request limit; try again tomorrow.";
  if (typeof parsed?.retryAfterSeconds === "number") {
    return `Too many requests, try again in ${Math.max(1, Math.ceil(parsed.retryAfterSeconds / 60))} min.`;
  }
  if (parsed?.error === "Request too large") return "This conversation is too long; start a new chat.";
  if (typeof parsed?.error === "string") return parsed.error;
  return error.message || "Something went wrong.";
}

function noteMarkdown(output: unknown): string | null {
  if (typeof output !== "object" || output === null || !("markdown" in output)) return null;
  return typeof output.markdown === "string" ? output.markdown : null;
}

function layerErrorText(name: string, output: unknown): string | null {
  if (!name.startsWith("query_") || typeof output !== "object" || output === null || !("error" in output)) return null;
  return typeof output.error === "string" ? output.error : null;
}

type Source = { source: string; url: string; retrieved?: string };

/** The citations a message's finished tool calls carry (`citation.source` + url), one per url, in call order. */
export function messageSources(message: UIMessage): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const part of message.parts) {
    if (!isToolUIPart(part) || part.state !== "output-available") continue;
    const output: unknown = part.output;
    if (typeof output !== "object" || output === null || !("citation" in output)) continue;
    const citation: unknown = output.citation;
    if (typeof citation !== "object" || citation === null || !("source" in citation) || !("url" in citation)) continue;
    const { source, url } = citation;
    if (typeof source !== "string" || typeof url !== "string" || !source || seen.has(url)) continue;
    seen.add(url);
    const retrieved = "retrieved" in citation && typeof citation.retrieved === "string" ? citation.retrieved : undefined;
    sources.push({ source, url, retrieved });
  }
  return sources;
}

/**
 * "SOURCES A · B  2026-10-09" under an answer: a small-caps label, dashed-underline links (`.dashed-link`), and the
 * latest retrieval date in tabular figures.
 */
function SourcesLine({ sources }: { sources: Source[] }) {
  const retrieved = sources.map((s) => s.retrieved).filter(Boolean).sort().at(-1);
  return (
    <p data-testid="sources-line" className="text-[12px] leading-relaxed text-ink-muted">
      <span className="small-caps">Sources</span>{" "}
      {sources.map((s, i) => (
        <span key={s.url}>
          {i > 0 && <span aria-hidden> · </span>}
          <a href={s.url} target="_blank" rel="noreferrer" className="dashed-link">
            {s.source}
          </a>
        </span>
      ))}
      {retrieved && <span className="ml-2 tabular-nums">{retrieved}</span>}
    </p>
  );
}

/** Models often title an answer with a bold-only paragraph; set it as a serif heading like a real one. */
const MARKDOWN_COMPONENTS: Components = {
  p: ({ node, children }) => {
    const only = node?.children.length === 1 ? node.children[0] : undefined;
    const isTitle = only?.type === "element" && only.tagName === "strong";
    return <p className={isTitle ? "answer-title" : undefined}>{children}</p>;
  },
};

function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
    </div>
  );
}

type FollowUpProps = {
  /** Sends a follow-up question; undefined while a reply is in flight. */
  onFollowUp?: (text: string) => void;
};

type AnswerCardProps = {
  text: string;
  /**
   * False while the text is still streaming: the closing list is shown as plain markdown until the answer is
   * finished, so pills do not flicker in and out as bullets arrive.
   */
  done: boolean;
} & FollowUpProps;

/**
 * An assistant answer: plain markdown on the panel, no bubble. A finished answer's closing follow-up questions
 * become plain text rows (full width, 44px, hairline separators, a "→" at 60% ink).
 */
const AnswerCard = memo(function AnswerCard({ text, done, onFollowUp }: AnswerCardProps) {
  const { body, followUps } = useMemo(
    () => (done ? extractFollowUps(text) : { body: text, followUps: [] as string[] }),
    [text, done],
  );
  return (
    <div className="px-1">
      {body.trim() && <Markdown text={body} />}
      {followUps.length > 0 && (
        <ul
          aria-label="Follow-up questions"
          className={`divide-y divide-line border-y border-line ${body.trim() ? "mt-3" : ""}`}
        >
          {followUps.map((q) => (
            <li key={q}>
              <button
                type="button"
                disabled={!onFollowUp}
                onClick={() => onFollowUp?.(q)}
                className="group press flex min-h-11 w-full items-center gap-3 py-2 pr-1 text-left text-[14px] leading-snug text-ink transition duration-150 ease-out disabled:opacity-50"
              >
                <span className="flex-1">{q}</span>
                <span
                  aria-hidden
                  className="shrink-0 text-ink/60 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-ink"
                >
                  →
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

/** White card with a thin ink bar on the left; only the title is red. */
function ErrorCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="alert"
      className="relative overflow-hidden rounded-2xl border border-line bg-paper py-2.5 pr-4 pl-5 text-sm text-ink"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-ink" />
      <p className="font-medium text-danger">{title}</p>
      <p className="mt-0.5 text-ink">{children}</p>
    </div>
  );
}

function ToolTraceView({ part }: { part: ToolPart }) {
  return (
    <ToolTrace
      name={getToolName(part)}
      state={part.state}
      input={part.input}
      output={part.state === "output-available" ? part.output : undefined}
      errorText={part.state === "output-error" ? part.errorText : undefined}
    />
  );
}

/** What a finished tool call adds below its trace chip: the note's markdown or a layer's error. */
function toolExtras(part: ToolPart, onFollowUp: FollowUpProps["onFollowUp"]): ReactNode {
  const name = getToolName(part);
  const output = part.state === "output-available" ? part.output : undefined;
  const note = name === "note" ? noteMarkdown(output) : null;
  const layerError = layerErrorText(name, output);
  // A note arrives whole with its tool output, so it is always finished.
  if (note !== null) return <AnswerCard text={note} done onFollowUp={onFollowUp} />;
  if (layerError !== null) return <ErrorCard title="Couldn't load that layer">{layerError}</ErrorCard>;
  return null;
}

type MessageViewProps = {
  message: UIMessage;
  /** True only for the assistant message currently streaming in. */
  streaming: boolean;
} & FollowUpProps;

/** Memoized so typing in the input does not re-render (and re-parse the markdown of) the conversation. */
const MessageView = memo(function MessageView({ message, streaming, onFollowUp }: MessageViewProps) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    // No bubble: an accent chevron marks the user's line.
    return (
      <p data-testid="user-message" className="flex gap-2 px-1 text-[15px] leading-snug font-medium text-ink">
        <span aria-hidden className="font-semibold text-accent">
          ›
        </span>
        <span className="min-w-0 flex-1 break-words">{text}</span>
      </p>
    );
  }
  // Consecutive tool calls share one list of hairline rows; text, notes and errors break the row.
  const blocks: ReactNode[] = [];
  let chips: ReactNode[] = [];
  const flushChips = () => {
    if (chips.length === 0) return;
    blocks.push(
      <div key={`chips-${blocks.length}`} className="flex flex-col divide-y divide-line border-y border-line">
        {chips}
      </div>,
    );
    chips = [];
  };
  // When the model repeats its note as closing text, show only the text (it carries the follow-ups).
  const repeatedNotes = dedupeNoteAndText(message.parts);
  message.parts.forEach((part, i) => {
    if (part.type === "text") {
      if (!part.text.trim()) return;
      flushChips();
      const done = part.state === "done" || (part.state === undefined && !streaming);
      blocks.push(<AnswerCard key={i} text={part.text} done={done} onFollowUp={onFollowUp} />);
    } else if (isToolUIPart(part)) {
      chips.push(<ToolTraceView key={part.toolCallId} part={part} />);
      const extras = repeatedNotes.has(i) ? null : toolExtras(part, onFollowUp);
      if (extras !== null) {
        flushChips();
        blocks.push(<div key={`${part.toolCallId}-extras`}>{extras}</div>);
      }
    }
  });
  flushChips();
  const sources = messageSources(message);
  if (sources.length > 0) blocks.push(<SourcesLine key="sources" sources={sources} />);
  return <div className="flex flex-col gap-2">{blocks}</div>;
});

/** The dot spinner while a later answer has not started yet (the first answer gets the topo heartbeat). */
function Thinking() {
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-[13px] text-ink-muted">
      <DotSpinner label="Thinking" />
      Thinking…
    </div>
  );
}

/** A drag this far (px) on the handle snaps the sheet; anything shorter is a tap. */
const DRAG_SNAP_PX = 40;

export function ChatRail({
  catalog,
  renderOps,
  getCanvasSize,
  getView,
  onActions,
  collapsed,
  onToggle,
  layerPanelOpen = false,
  suggestionsOpen,
  onSuggestionsClose,
  onSuggestionsSeen,
}: ChatRailProps) {
  // Resend query results as summaries (the map already has the full data, and the route caps request size), and
  // send the map view as it is at send time, through a reader the effect below keeps current.
  const [{ transport, viewReader }] = useState(() => {
    let current: () => MapView | null = () => null;
    const reader = { read: () => current(), set: (next: () => MapView | null) => void (current = next) };
    return {
      viewReader: reader,
      transport: new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: (request) => ({ body: buildChatBody(request, reader.read()) }),
      }),
    };
  });
  // A fixed id: without one the SDK picks a random id during render, which Cache Components rejects at prerender.
  const { messages, sendMessage, setMessages, clearError, status, error, stop } = useChat({ id: "wildmap", transport });
  const [draft, setDraft] = useState("");
  const appliedRef = useRef<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const hasMessages = messages.length > 0;
  // The topo heartbeat plays only while the conversation's first answer is on its way; messages only grow, so
  // once a second question is asked it never shows again this session.
  const firstAnswerPending = busy && messages.filter((m) => m.role === "user").length === 1;
  const [tall, setTall] = useState(false);
  const dragStartRef = useRef<number | null>(null);
  const open = hasMessages && !collapsed;
  const state = !hasMessages ? "empty" : open ? "open" : "collapsed";

  // "Here" is the part of the map the chat panel, layer panel and header leave visible.
  useEffect(() => {
    viewReader.set(() => {
      if (!getView) return null;
      const size = getCanvasSize();
      return getView(visibleMapPadding({ ...size, panelOpen: open, isMobile: size.width < 768, layerPanelOpen }));
    });
  }, [viewReader, getView, getCanvasSize, open, layerPanelOpen]);

  // Turn each finished tool call into map actions exactly once.
  useEffect(() => {
    if (catalog === null) return;
    const applied = appliedRef.current;
    // Fit results into the map the panel leaves visible, not the whole window.
    const size = getCanvasSize();
    const padding = visibleMapPadding({ ...size, panelOpen: open, isMobile: size.width < 768, layerPanelOpen });
    const canvas = { ...size, padding };
    // Track ops produced in this pass so a later query in the same batch sees an earlier render.
    let ops = renderOps;
    const actions: MapAction[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (!isToolUIPart(part) || part.state !== "output-available" || part.preliminary) continue;
        if (applied.has(part.toolCallId)) continue;
        applied.add(part.toolCallId);
        const next = toolResultToActions(getToolName(part), part.input, part.output, canvas, catalog, ops);
        for (const action of next) {
          if (action.type === "render") ops = [...ops.filter((op) => op.layerId !== action.op.layerId), action.op];
        }
        actions.push(...next);
      }
    }
    if (actions.length > 0) onActions(actions);
  }, [messages, catalog, renderOps, getCanvasSize, onActions, open, layerPanelOpen]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, error]);

  // Any first message, however it was sent (the card, the composer, "Ask about this"), counts as having seen the card.
  useEffect(() => {
    if (hasMessages) onSuggestionsSeen?.();
  }, [hasMessages, onSuggestionsSeen]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return false;
      void sendMessage({ text: trimmed });
      setDraft("");
      return true;
    },
    [busy, sendMessage],
  );

  // Messages from outside the chat (the inspect card's "Ask about this") go out like a follow-up.
  useEffect(
    () =>
      onChatSend((text) => {
        if (busy) return false;
        void sendMessage({ text });
        return true;
      }),
    [busy, sendMessage],
  );

  // Unlike `send`, a follow-up leaves whatever the user is typing in the input. Stable while idle so the
  // memoized messages do not re-render on every keystroke.
  const followUp = useCallback(
    (text: string) => {
      if (!busy) void sendMessage({ text });
    },
    [busy, sendMessage],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Keep the caret (and a phone's keyboard) in the input after sending, even when the send button was tapped.
    if (send(draft)) inputRef.current?.focus();
  };

  // Picking a suggestion is the next question: it goes out, the card closes, and a collapsed panel opens to show the answer.
  const pickSuggestion = (question: string) => {
    if (!send(question)) return;
    onSuggestionsClose?.();
    if (hasMessages && collapsed) onToggle();
  };

  const lastId = messages.at(-1)?.id;

  // The phone sheet's handle: a tap toggles half and tall; a drag snaps up to tall, or down a step (from half,
  // down collapses the panel).
  const onHandleDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    dragStartRef.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (start === null) return;
    const dy = e.clientY - start;
    if (Math.abs(dy) < DRAG_SNAP_PX) setTall((t) => !t);
    else if (dy < 0) setTall(true);
    else if (tall) setTall(false);
    else onToggle();
  };

  return (
    <>
      {(suggestionsOpen ?? !hasMessages) && (
        // Leaves room at the bottom for the input pill. Empty chat: below the data console (z-20, components/App.tsx).
        // Mid-conversation (opened from the "i" pill): above the chat panel and the console. On a phone hidden while the
        // console is open: there the card would cover all but the console's top row.
        <div
          data-testid="empty-state-overlay"
          className={`pointer-events-none absolute inset-0 ${hasMessages ? "z-30" : "z-10"} flex items-center justify-center pt-[calc(var(--safe-top)+4rem)] pr-[calc(var(--safe-right)+1rem)] pb-[calc(var(--safe-bottom)+6rem)] pl-[calc(var(--safe-left)+1rem)] md:pb-[calc(var(--safe-bottom)+5rem)]${layerPanelOpen ? " max-md:hidden" : ""}`}
        >
          <EmptyState onPick={pickSuggestion} onClose={onSuggestionsClose} />
        </div>
      )}

      {/*
        One section and one composer for every state, so the input never remounts: it keeps focus (and a
        phone keeps its keyboard) through the first send and through collapse/expand. Only classes change.
      */}
      <section
        aria-label="Chat"
        data-chat-open={open}
        data-chat-state={state}
        data-sheet={tall ? "tall" : "half"}
        className={[
          "chat-surface absolute z-20 flex flex-col",
          open
            ? [
                "glass-strong rise-in overflow-hidden transition-[height] duration-350 ease-(--ease-out)",
                // Phones: a bottom sheet that snaps between half and tall, edge to edge (the composer keeps clear of
                // the home indicator, the content of the side insets).
                tall ? "inset-x-0 bottom-0 h-[90dvh] rounded-t-panel" : "inset-x-0 bottom-0 h-[46dvh] rounded-t-panel",
                "max-md:pr-(--safe-right) max-md:pl-(--safe-left)",
                // md and up: a floating panel in the bottom-left corner.
                "md:inset-x-auto md:bottom-[calc(var(--safe-bottom)+1rem)] md:left-[calc(var(--safe-left)+1rem)] md:h-auto md:max-h-[72dvh] md:w-[420px] md:rounded-panel",
              ].join(" ")
            : "right-[calc(var(--safe-right)+0.75rem)] bottom-[calc(var(--safe-bottom)+0.75rem)] left-[calc(var(--safe-left)+0.75rem)] items-start gap-2 md:right-auto md:bottom-[calc(var(--safe-bottom)+1rem)] md:left-[calc(var(--safe-left)+1rem)] md:w-[420px]",
        ].join(" ")}
      >
        {open && (
          <button
            type="button"
            onPointerDown={onHandleDown}
            onPointerUp={onHandleUp}
            onPointerCancel={() => (dragStartRef.current = null)}
            // Keyboard activation (no pointer) toggles too; a tap is already handled on pointer up.
            onClick={(e) => {
              if (e.detail === 0) setTall((t) => !t);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") setTall(true);
              else if (e.key === "ArrowDown") setTall(false);
            }}
            aria-label={tall ? "Shrink chat" : "Expand chat"}
            title={tall ? "Shrink" : "Expand"}
            data-testid="sheet-handle"
            className="absolute inset-x-0 top-0 z-10 mx-auto flex h-6 w-24 touch-none items-start justify-center pt-2 md:hidden"
          >
            {/* Wally's drag handle: 36×5. */}
            <span aria-hidden className="h-[5px] w-9 rounded-full bg-ink/20" />
          </button>
        )}

        {hasMessages && (
          // One toggle in every state, so focus survives collapse/expand: the chevron at the top right of the open
          // panel, and the small WallyMap tag above the input when collapsed.
          <button
            type="button"
            onClick={onToggle}
            aria-label="WallyMap chat"
            aria-expanded={open}
            title={open ? "Collapse" : "Expand"}
            className={
              open
                ? "absolute top-3.5 right-3.5 z-10 flex size-8 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-mist hover:text-ink max-md:top-4 max-md:right-[calc(var(--safe-right)+0.875rem)]"
                : "glass-strong rise-in flex h-8 items-center gap-1.5 rounded-pill pr-2.5 pl-3 text-xs font-medium text-ink"
            }
          >
            {open ? (
              <ChevronDown aria-hidden size={18} strokeWidth={2} />
            ) : (
              <>
                <WallyMark size={16} />
                <span className="text-[13px] font-semibold">WallyMap</span>
                {busy && <DotSpinner className="text-ink-muted" />}
                <ChevronUp aria-hidden size={14} strokeWidth={2} className="text-ink-muted" />
              </>
            )}
          </button>
        )}

        {hasMessages && (
          // Stays mounted while collapsed so tool-trace timings and scroll position survive.
          <div className={open ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <header className="flex shrink-0 items-center gap-2 pt-6 pr-14 pb-2 pl-5 md:pt-4">
              <h2 className="font-serif text-[1.2rem] font-semibold text-ink">Ask the map</h2>
              {busy && (
                <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <DotSpinner />
                  Thinking…
                </span>
              )}
            </header>

            <div
              role="log"
              aria-live="polite"
              aria-label="Conversation"
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-3"
            >
              {messages.map((m) => (
                <MessageView
                  key={m.id}
                  message={m}
                  streaming={status === "streaming" && m.id === lastId}
                  onFollowUp={busy ? undefined : followUp}
                />
              ))}
              {firstAnswerPending ? <TopoHeartbeat className="h-28 shrink-0" zoom={0.5} /> : status === "submitted" && <Thinking />}
              {error && (
                <ErrorCard title="Something went wrong">
                  {readableError(error)}
                  {isConversationTooLong(error) && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="font-medium underline underline-offset-2"
                        onClick={() => {
                          // The map keeps what is drawn; only the conversation starts over.
                          setMessages([]);
                          clearError();
                        }}
                      >
                        New chat
                      </button>
                    </>
                  )}
                </ErrorCard>
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        )}

        <PreviewControl onActions={onActions} />
        {/* rise-in stays on in every state so it plays once, on mount, and never replays on collapse. */}
        <div className={`rise-in w-full ${open ? "shrink-0 px-3 pt-1 pb-[calc(var(--safe-bottom)+0.75rem)] md:pb-3" : ""}`} style={{ animationDelay: "240ms" }}>
          <form
            onSubmit={onSubmit}
            className={[
              // A hairline that turns slate while the input has focus: the only focus cue a click gives.
              "flex w-full items-center gap-2 rounded-pill border border-line p-1.5 pl-5 transition-colors focus-within:border-slate",
              open ? "bg-paper" : "glass-strong",
            ].join(" ")}
          >
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask about trails, terrain, anywhere…"
              aria-label="Message"
              enterKeyHint="send"
              // 16px on phones: iOS Safari zooms the page in on any field under 16px and keeps the zoom (app/globals.css).
              className="h-10 min-w-0 flex-1 bg-transparent text-[16px] text-ink md:text-[15px] outline-none placeholder:text-ink-muted"
            />
            {busy ? (
              <button
                type="button"
                onClick={() => void stop()}
                aria-label="Stop"
                title="Stop"
                className="press flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary transition duration-150 ease-out hover:opacity-85"
              >
                <Square aria-hidden size={14} strokeWidth={2.5} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!draft.trim()}
                aria-label="Send"
                title="Send"
                // The primary (black) button only once there is something to send.
                className="press flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary transition duration-150 ease-out hover:opacity-85 disabled:bg-mist disabled:text-ink-muted disabled:hover:opacity-100"
              >
                <ArrowUp aria-hidden size={18} strokeWidth={2.25} />
              </button>
            )}
          </form>
        </div>
      </section>
    </>
  );
}
