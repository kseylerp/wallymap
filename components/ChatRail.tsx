"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { EmptyState } from "@/components/EmptyState";
import { ToolTrace } from "@/components/ToolTrace";
import { toolResultToActions, type LayerCatalog } from "@/lib/agent/applyToolResult";
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

function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown text-sm leading-6 text-neutral-800">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}

function ToolPartView({ part }: { part: ToolPart }) {
  const name = getToolName(part);
  const output = part.state === "output-available" ? part.output : undefined;
  const note = name === "note" ? noteMarkdown(output) : null;
  const layerError = layerErrorText(name, output);
  return (
    <div className="flex flex-col gap-1">
      <ToolTrace
        name={name}
        state={part.state}
        input={part.input}
        output={output}
        errorText={part.state === "output-error" ? part.errorText : undefined}
      />
      {note !== null && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
          <Markdown text={note} />
        </div>
      )}
      {layerError !== null && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {layerError}
        </div>
      )}
    </div>
  );
}

function MessageView({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="ml-8 self-end rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white">{text}</div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) => {
        if (part.type === "text") return <Markdown key={i} text={part.text} />;
        if (isToolUIPart(part)) return <ToolPartView key={part.toolCallId} part={part} />;
        return null;
      })}
    </div>
  );
}

export function ChatRail({ catalog, renderOps, getCanvasSize, onActions, collapsed, onToggle }: ChatRailProps) {
  const [transport] = useState(() => new DefaultChatTransport({ api: "/api/chat" }));
  // A fixed id: without one the SDK picks a random id during render, which Cache Components rejects at prerender.
  const { messages, sendMessage, status, error, stop } = useChat({ id: "mapagent", transport });
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

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-white" aria-label="Chat">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 px-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand chat" : "Collapse chat"}
          aria-expanded={!collapsed}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-100"
        >
          <span aria-hidden className="md:hidden">{collapsed ? "▴" : "▾"}</span>
          <span aria-hidden className="hidden md:inline">{collapsed ? "»" : "«"}</span>
        </button>
        <h1 className={`text-sm font-semibold text-neutral-900 ${collapsed ? "md:hidden" : ""}`}>MapAgent</h1>
        {busy && !collapsed && <span className="ml-auto text-xs text-neutral-500">Thinking…</span>}
      </header>

      <div className={`flex min-h-0 flex-1 flex-col ${collapsed ? "hidden" : ""}`}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
          {messages.length === 0 && <EmptyState onPick={send} />}
          {messages.map((m) => (
            <MessageView key={m.id} message={m} />
          ))}
          {error && (
            <div role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              {readableError(error)}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={onSubmit} className="flex shrink-0 gap-2 border-t border-neutral-200 p-3">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about trails, places, data…"
            aria-label="Message"
            className="min-w-0 flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => void stop()}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              Send
            </button>
          )}
        </form>
      </div>
    </section>
  );
}
