// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRail } from "@/components/ChatRail";
import { ToolTrace } from "@/components/ToolTrace";
import { formatDuration, observeToolTimings, stampTimingMetadata } from "@/lib/trace-timing";

type ChatStub = {
  messages: UIMessage[];
  status: "ready" | "streaming";
  setMessages: ReturnType<typeof vi.fn>;
};
const chat: ChatStub = { messages: [], status: "streaming", setMessages: vi.fn() };

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    ...chat,
    error: undefined,
    sendMessage: vi.fn(),
    clearError: vi.fn(),
    stop: vi.fn(),
  }),
}));

Element.prototype.scrollIntoView = vi.fn();

const rail = () => (
  <ChatRail catalog={{}} renderOps={[]} getCanvasSize={() => ({ width: 1440, height: 900 })} onActions={() => {}} collapsed={false} onToggle={() => {}} />
);

const STEPS = ["geocode", "set_view", "query_osm-trails"] as const;
type Step = (typeof STEPS)[number];
const part = (name: Step, state: "input-available" | "output-available") =>
  state === "output-available"
    ? { type: `tool-${name}` as const, toolCallId: name, state, input: {}, output: {} }
    : { type: `tool-${name}` as const, toolCallId: name, state, input: {} };

const assistant = (states: Partial<Record<Step, "input-available" | "output-available">>): UIMessage =>
  ({
    id: "a1",
    role: "assistant",
    parts: STEPS.filter((s) => states[s]).map((s) => part(s, states[s]!)),
  }) as UIMessage;

const times = () => screen.getAllByTestId("tool-trace").map((row) => row.querySelector("button > span:last-child")?.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  chat.messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "q" }] }];
  chat.status = "streaming";
  chat.setMessages = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("formatDuration", () => {
  it("reads in milliseconds under a second, then seconds with one decimal", () => {
    expect(formatDuration(840)).toBe("840 ms");
    expect(formatDuration(999.6)).toBe("1.0 s");
    expect(formatDuration(1359)).toBe("1.4 s");
    expect(formatDuration(12_400)).toBe("12 s");
    expect(formatDuration(102_000)).toBe("1 m 42 s");
  });
});

describe("tool trace durations", () => {
  it("shows the step's own duration from the recorded start and end", () => {
    render(<ToolTrace name="geocode" state="output-available" input={{}} output={{}} timing={{ startedAt: 1000, endedAt: 2359 }} />);
    expect(screen.getByTestId("tool-trace").textContent).toContain("1.4 s");
  });

  it("shows nothing for a running step or one that was never timed", () => {
    const { rerender } = render(<ToolTrace name="geocode" state="input-available" input={{}} output={undefined} timing={{ startedAt: 0 }} />);
    expect(times()).toEqual([""]);
    rerender(<ToolTrace name="geocode" state="output-available" input={{}} output={{}} />);
    expect(times()).toEqual([""]);
  });

  it("gives three sequential steps three independent durations", () => {
    const { rerender } = render(rail());
    const advance = (ms: number, states: Parameters<typeof assistant>[0]) => {
      vi.setSystemTime(Date.now() + ms);
      chat.messages = [chat.messages[0], assistant(states)];
      rerender(rail());
    };
    advance(0, { geocode: "input-available" });
    advance(1_200, { geocode: "output-available", set_view: "input-available" });
    advance(300, { geocode: "output-available", set_view: "output-available", "query_osm-trails": "input-available" });
    advance(4_500, { geocode: "output-available", set_view: "output-available", "query_osm-trails": "output-available" });
    expect(times()).toEqual(["1.2 s", "300 ms", "4.5 s"]);
  });

  it("freezes a finished row and shows small numbers after a 100 s stream with fast steps", () => {
    const { rerender } = render(rail());
    const at = (ms: number, states: Parameters<typeof assistant>[0]) => {
      vi.setSystemTime(ms);
      chat.messages = [chat.messages[0], assistant(states)];
      rerender(rail());
    };
    at(0, { geocode: "input-available" });
    at(900, { geocode: "output-available", set_view: "input-available" });
    at(1_100, { geocode: "output-available", set_view: "output-available" });
    const done = { geocode: "output-available", set_view: "output-available" } as const;
    expect(times()).toEqual(["900 ms", "200 ms"]);
    // The model keeps writing for 100 s and the rail re-renders many times; nothing already finished moves.
    for (let t = 10_000; t <= 100_000; t += 10_000) at(t, done);
    at(100_000, { ...done, "query_osm-trails": "input-available" });
    at(100_800, { ...done, "query_osm-trails": "output-available" });
    expect(times()).toEqual(["900 ms", "200 ms", "800 ms"]);
  });
});

describe("timing bookkeeping", () => {
  it("does not time a call first seen already finished", () => {
    const msgs = [assistant({ geocode: "output-available" })];
    expect(observeToolTimings(msgs, {}, 5000)).toEqual({});
  });

  it("copies finished timings onto message metadata once, and reads them back", () => {
    const msgs = [assistant({ geocode: "output-available" })];
    const stamped = stampTimingMetadata(msgs, { geocode: { startedAt: 10, endedAt: 1410 } });
    expect(stamped?.[0].metadata).toEqual({ toolTimings: { geocode: { startedAt: 10, endedAt: 1410 } } });
    expect(stampTimingMetadata(stamped!, { geocode: { startedAt: 10, endedAt: 1410 } })).toBeNull();
  });
});
