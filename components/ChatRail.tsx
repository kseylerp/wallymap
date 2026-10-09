"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { EmptyState } from "@/components/EmptyState";
import { ArrowUpIcon, ChevronDownIcon, ChevronUpIcon, StopIcon } from "@/components/icons";
import { ToolTrace } from "@/components/ToolTrace";
import { toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
import { compactMessages } from "@/lib/agent/compactMessages";
import { extractFollowUps } from "@/lib/agent/followups";
import type { MapAction, RenderOp } from "@/lib/render/state";

type ChatRailProps = {
  /** Null until `/api/layers` answers; tool results wait for it so layers get their real styles. */
  catalog: LayerCatalog | null;
  renderOps: RenderOp[];
  getCanvasSize: () => { width: number; height: number };
  onActions: (actions: MapAction[]) => void;
  collapsed: boolean;
  onToggle: () => void;
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

/** An assistant answer on a paper card; a closing list of follow-up questions becomes tappable pills. */
function AnswerCard({ text, onFollowUp }: { text: string } & FollowUpProps) {
  const { body, followUps } = extractFollowUps(text);
  return (
    <div className="rounded-[20px] border border-line bg-paper px-4 py-3 shadow-[0_1px_2px_rgba(31,30,27,0.05)]">
      {body.trim() && <Markdown text={body} />}
      {followUps.length > 0 && (
        <ul aria-label="Follow-up questions" className={`flex flex-col items-start gap-1.5 ${body.trim() ? "mt-3" : ""}`}>
          {followUps.map((q) => (
            <li key={q}>
              <button
                type="button"
                disabled={!onFollowUp}
                onClick={() => onFollowUp?.(q)}
                className="rounded-[16px] border border-accent/25 bg-accent-soft/50 px-3 py-1.5 text-left text-[13px] leading-snug text-ink transition-colors hover:border-accent/50 hover:bg-accent-soft disabled:opacity-50 disabled:hover:bg-accent-soft/50"
              >
                {q}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Paper card with a terracotta bar on the left. */
function ErrorCard({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="relative overflow-hidden rounded-2xl bg-paper py-2.5 pr-4 pl-5 text-sm text-ink">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />
      {children}
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
  if (note !== null) return <AnswerCard text={note} onFollowUp={onFollowUp} />;
  if (layerError !== null) return <ErrorCard>{layerError}</ErrorCard>;
  return null;
}

function MessageView({ message, onFollowUp }: { message: UIMessage } & FollowUpProps) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="max-w-[85%] self-end rounded-[20px] rounded-br-md bg-accent-soft px-4 py-2.5 text-[15px] text-ink">
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
  message.parts.forEach((part, i) => {
    if (part.type === "text") {
      if (!part.text.trim()) return;
      flushChips();
      blocks.push(<AnswerCard key={i} text={part.text} onFollowUp={onFollowUp} />);
    } else if (isToolUIPart(part)) {
      chips.push(<ToolTraceView key={part.toolCallId} part={part} />);
      const extras = toolExtras(part, onFollowUp);
      if (extras !== null) {
        flushChips();
        blocks.push(<div key={`${part.toolCallId}-extras`}>{extras}</div>);
      }
    }
  });
  flushChips();
  return <div className="flex flex-col gap-2">{blocks}</div>;
}

/** Three soft dots while the model has not answered yet. */
function Thinking() {
  return (
    <div aria-label="Thinking" role="status" className="flex w-fit items-center gap-1 rounded-pill bg-paper px-3 py-2.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-accent"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </div>
  );
}

export function ChatRail({ catalog, renderOps, getCanvasSize, onActions, collapsed, onToggle }: ChatRailProps) {
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
  const busy = status === "submitted" || status === "streaming";

  // Turn each finished tool call into map actions exactly once.
  useEffect(() => {
    if (catalog === null) return;
    const applied = appliedRef.current;
    // Track ops produced in this pass so a later query in the same batch sees an earlier render.
    let ops = renderOps;
    const actions: MapAction[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (!isToolUIPart(part) || part.state !== "output-available" || part.preliminary) continue;
        if (applied.has(part.toolCallId)) continue;
        applied.add(part.toolCallId);
        const next = toolResultToActions(getToolName(part), part.input, part.output, getCanvasSize(), catalog, ops);
        for (const action of next) {
          if (action.type === "render") ops = [...ops.filter((op) => op.layerId !== action.op.layerId), action.op];
        }
        actions.push(...next);
      }
    }
    if (actions.length > 0) onActions(actions);
  }, [messages, catalog, renderOps, getCanvasSize, onActions]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, error]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    void sendMessage({ text: trimmed });
    setDraft("");
  };

  // Unlike `send`, a follow-up leaves whatever the user is typing in the input.
  const followUp = (text: string) => {
    if (!busy) void sendMessage({ text });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };

  const hasMessages = messages.length > 0;
  const open = hasMessages && !collapsed;

  const composer = (
    <form
      onSubmit={onSubmit}
      className={[
        "flex w-full items-center gap-2 rounded-pill p-1.5 pl-5",
        open ? "border border-line bg-paper" : "glass",
      ].join(" ")}
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Ask about trails, terrain, anywhere…"
        aria-label="Message"
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
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-paper transition-colors hover:bg-accent-deep disabled:opacity-40 disabled:hover:bg-accent"
        >
          <ArrowUpIcon />
        </button>
      )}
    </form>
  );

  return (
    <>
      {!hasMessages && (
        // Leaves room at the bottom for the input pill.
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4 pt-16 pb-24 md:pb-20">
          <EmptyState onPick={send} />
        </div>
      )}

      {/* Stays mounted while collapsed so tool-trace timings and scroll position survive. */}
      {hasMessages && (
        <section
          aria-label="Chat"
          data-chat-open={open}
          hidden={!open}
          className={[
            "glass rise-in absolute z-20 flex-col overflow-hidden",
            open ? "flex" : "hidden",
            // Phones: a bottom sheet.
            "inset-x-0 bottom-0 h-[46vh] rounded-t-panel",
            // md and up: a floating panel in the bottom-left corner.
            "md:inset-x-auto md:bottom-4 md:left-4 md:h-auto md:max-h-[72vh] md:w-[420px] md:rounded-panel",
          ].join(" ")}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse chat"
            className="flex h-5 shrink-0 items-end justify-center md:hidden"
          >
            <span aria-hidden className="h-1 w-10 rounded-full bg-ink/20" />
          </button>
          <header className="flex shrink-0 items-center gap-2 px-5 pt-1 pb-2 md:pt-4">
            <h2 className="font-serif text-[1.2rem] font-semibold text-ink">Ask the map</h2>
            {busy && (
              <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />
                Thinking…
              </span>
            )}
            <button
              type="button"
              onClick={onToggle}
              aria-label="Collapse chat"
              aria-expanded
              title="Collapse"
              className="ml-auto hidden size-8 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-paper hover:text-ink md:flex"
            >
              <ChevronDownIcon />
            </button>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-3">
            {messages.map((m) => (
              <MessageView key={m.id} message={m} onFollowUp={busy ? undefined : followUp} />
            ))}
            {status === "submitted" && <Thinking />}
            {error && <ErrorCard>{readableError(error)}</ErrorCard>}
            <div ref={bottomRef} />
          </div>

          <div className="shrink-0 px-3 pt-1 pb-3">{open && composer}</div>
        </section>
      )}

      {!open && (
        <section
          aria-label="Chat input"
          className="absolute inset-x-3 bottom-3 z-20 flex flex-col items-start gap-2 md:inset-x-auto md:bottom-4 md:left-4 md:w-[420px]"
        >
          {hasMessages && (
            <button
              type="button"
              onClick={onToggle}
              aria-label="Expand chat"
              aria-expanded={false}
              className="glass rise-in flex h-8 items-center gap-1.5 rounded-pill pr-2.5 pl-3 text-xs font-medium text-ink"
            >
              <span className="font-serif text-[13px] font-semibold">WildMap</span>
              {busy && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />}
              <ChevronUpIcon width={14} height={14} className="text-ink-muted" />
            </button>
          )}
          <div className="rise-in w-full" style={{ animationDelay: "240ms" }}>
            {composer}
          </div>
        </section>
      )}
    </>
  );
}
