"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { EmptyState } from "@/components/EmptyState";
import { ArrowUpIcon, ChevronDownIcon, ChevronUpIcon, StopIcon } from "@/components/icons";
import { ToolTrace } from "@/components/ToolTrace";
import { toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { onChatSend } from "@/lib/agent/chatBus";
import { compactMessages } from "@/lib/agent/compactMessages";
import { dedupeNoteAndText } from "@/lib/agent/dedupe";
import { extractFollowUps } from "@/lib/agent/followups";
import type { MapAction, RenderOp } from "@/lib/render/state";
import { visibleMapPadding } from "@/lib/render/viewportPadding";

type ChatRailProps = {
  /** Null until `/api/layers` answers; tool results wait for it so layers get their real styles. */
  catalog: LayerCatalog | null;
  renderOps: RenderOp[];
  getCanvasSize: () => { width: number; height: number };
  onActions: (actions: MapAction[]) => void;
  collapsed: boolean;
  onToggle: () => void;
  /** The layer panel is open on the right, so fitted results must stay left of it. */
  layerPanelOpen?: boolean;
};

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

/** The chat route answers failures with `{ error }` JSON; show that sentence rather than raw JSON. */
function readableError(error: Error): string {
  try {
    const parsed: unknown = JSON.parse(error.message);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Not JSON: the message is already prose.
  }
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

/** An assistant answer on a white card; a finished answer's closing follow-up questions become tappable pills. */
const AnswerCard = memo(function AnswerCard({ text, done, onFollowUp }: AnswerCardProps) {
  const { body, followUps } = useMemo(
    () => (done ? extractFollowUps(text) : { body: text, followUps: [] as string[] }),
    [text, done],
  );
  return (
    <div className="rounded-[20px] border border-line bg-paper px-4 py-3 shadow-hair">
      {body.trim() && <Markdown text={body} />}
      {followUps.length > 0 && (
        <ul aria-label="Follow-up questions" className={`flex flex-col items-start gap-1.5 ${body.trim() ? "mt-3" : ""}`}>
          {followUps.map((q) => (
            <li key={q}>
              <button
                type="button"
                disabled={!onFollowUp}
                onClick={() => onFollowUp?.(q)}
                className="rounded-[16px] border border-line bg-paper px-3 py-1.5 text-left text-[13px] leading-snug text-ink transition-colors hover:bg-mist disabled:opacity-50 disabled:hover:bg-paper"
              >
                {q}
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
    return (
      <div className="max-w-[85%] self-end rounded-[20px] rounded-br-md bg-mist px-4 py-2.5 text-[15px] text-ink">
        {text}
      </div>
    );
  }
  // Consecutive tool calls share one wrapping row of chips; text, notes and errors break the row.
  const blocks: ReactNode[] = [];
  let chips: ReactNode[] = [];
  const flushChips = () => {
    if (chips.length === 0) return;
    blocks.push(
      <div key={`chips-${blocks.length}`} className="flex flex-wrap gap-1.5">
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
  return <div className="flex flex-col gap-2">{blocks}</div>;
});

/** Three soft dots while the model has not answered yet. */
function Thinking() {
  return (
    <div aria-label="Thinking" role="status" className="flex w-fit items-center gap-1 rounded-pill bg-paper px-3 py-2.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-ink-muted"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </div>
  );
}

export function ChatRail({
  catalog,
  renderOps,
  getCanvasSize,
  onActions,
  collapsed,
  onToggle,
  layerPanelOpen = false,
}: ChatRailProps) {
  // Resend query results as summaries: the map already has the full data, and the route caps request size.
  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ id, messages, body, trigger, messageId }) => ({
          body: { ...body, id, messages: compactMessages(messages), trigger, messageId },
        }),
      }),
  );
  // A fixed id: without one the SDK picks a random id during render, which Cache Components rejects at prerender.
  const { messages, sendMessage, status, error, stop } = useChat({ id: "wildmap", transport });
  const [draft, setDraft] = useState("");
  const appliedRef = useRef<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const hasMessages = messages.length > 0;
  const open = hasMessages && !collapsed;
  const state = !hasMessages ? "empty" : open ? "open" : "collapsed";

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

  const lastId = messages.at(-1)?.id;

  return (
    <>
      {!hasMessages && (
        // Leaves room at the bottom for the input pill.
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4 pt-16 pb-24 md:pb-20">
          <EmptyState onPick={send} />
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
        className={[
          "chat-surface absolute z-20 flex flex-col",
          open
            ? [
                "glass-strong rise-in overflow-hidden",
                // Phones: a bottom sheet.
                "inset-x-0 bottom-0 h-[46vh] rounded-t-panel",
                // md and up: a floating panel in the bottom-left corner.
                "md:inset-x-auto md:bottom-4 md:left-4 md:h-auto md:max-h-[72vh] md:w-[420px] md:rounded-panel",
              ].join(" ")
            : "inset-x-3 bottom-3 items-start gap-2 md:inset-x-auto md:bottom-4 md:left-4 md:w-[420px]",
        ].join(" ")}
      >
        {hasMessages && (
          // One toggle in every state, so focus survives collapse/expand: the grab handle (phones) or chevron
          // (desktop) at the top of the open panel, and the small WildMap tag above the input when collapsed.
          <button
            type="button"
            onClick={onToggle}
            aria-label="WildMap chat"
            aria-expanded={open}
            title={open ? "Collapse" : "Expand"}
            className={
              open
                ? "absolute inset-x-0 top-0 z-10 flex h-5 items-end justify-center md:inset-x-auto md:top-3.5 md:right-3.5 md:size-8 md:items-center md:rounded-full md:text-ink-muted md:transition-colors md:hover:bg-mist md:hover:text-ink"
                : "glass-strong rise-in flex h-8 items-center gap-1.5 rounded-pill pr-2.5 pl-3 text-xs font-medium text-ink"
            }
          >
            {open ? (
              <>
                <span aria-hidden className="h-1 w-10 rounded-full bg-ink/20 md:hidden" />
                <ChevronDownIcon aria-hidden className="hidden md:block" />
              </>
            ) : (
              <>
                <span className="font-serif text-[13px] font-semibold">WildMap</span>
                {busy && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-ink-muted" />}
                <ChevronUpIcon aria-hidden width={14} height={14} className="text-ink-muted" />
              </>
            )}
          </button>
        )}

        {hasMessages && (
          // Stays mounted while collapsed so tool-trace timings and scroll position survive.
          <div className={open ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <header className="flex shrink-0 items-center gap-2 pt-5 pr-14 pb-2 pl-5 md:pt-4">
              <h2 className="font-serif text-[1.2rem] font-semibold text-ink">Ask the map</h2>
              {busy && (
                <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                  <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-ink-muted" />
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
              {status === "submitted" && <Thinking />}
              {error && <ErrorCard title="Something went wrong">{readableError(error)}</ErrorCard>}
              <div ref={bottomRef} />
            </div>
          </div>
        )}

        {/* rise-in stays on in every state so it plays once, on mount, and never replays on collapse. */}
        <div className={`rise-in w-full ${open ? "shrink-0 px-3 pt-1 pb-3" : ""}`} style={{ animationDelay: "240ms" }}>
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
              className="h-10 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-muted"
            />
            {busy ? (
              <button
                type="button"
                onClick={() => void stop()}
                aria-label="Stop"
                title="Stop"
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-paper transition-colors hover:bg-ink/85"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!draft.trim()}
                aria-label="Send"
                title="Send"
                // Amber only once there is something to send. Ink arrow on amber: 6.5:1 (white would be 2.7:1).
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-ink transition-colors hover:bg-accent-deep disabled:bg-mist disabled:text-ink-muted"
              >
                <ArrowUpIcon />
              </button>
            )}
          </form>
        </div>
      </section>
    </>
  );
}
