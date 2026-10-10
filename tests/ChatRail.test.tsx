// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRail, readableError } from "@/components/ChatRail";

type ChatStub = {
  messages: UIMessage[];
  status: "ready" | "submitted" | "streaming" | "error";
  error: Error | undefined;
  sendMessage: ReturnType<typeof vi.fn>;
  setMessages: ReturnType<typeof vi.fn>;
  clearError: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

const chat: ChatStub = {
  messages: [],
  status: "ready",
  error: undefined,
  sendMessage: vi.fn(),
  setMessages: vi.fn(),
  clearError: vi.fn(),
  stop: vi.fn(),
};

vi.mock("@ai-sdk/react", () => ({ useChat: () => chat }));

// jsdom has no layout; the rail scrolls its last message into view after every update.
Element.prototype.scrollIntoView = vi.fn();

const noop = () => {};
const canvas = () => ({ width: 1440, height: 900 });

function rail(collapsed = false) {
  return (
    <ChatRail
      catalog={{}}
      renderOps={[]}
      getCanvasSize={canvas}
      onActions={noop}
      collapsed={collapsed}
      onToggle={noop}
    />
  );
}

const user = (text: string): UIMessage => ({ id: "u1", role: "user", parts: [{ type: "text", text }] });
const assistant = (text: string, state: "streaming" | "done"): UIMessage => ({
  id: "a1",
  role: "assistant",
  parts: [{ type: "text", text, state }],
});

const ANSWER = [
  "Trails mapped around the lake.",
  "",
  "- Which trails are good for a day hike?",
  "- Are there fire perimeters nearby?",
  "- Where can I camp near the lake?",
].join("\n");

beforeEach(() => {
  chat.messages = [];
  chat.status = "ready";
  chat.error = undefined;
  chat.sendMessage = vi.fn();
});
afterEach(cleanup);

describe("ChatRail composer", () => {
  it("keeps the same input element through the first send and collapse/expand", () => {
    const { rerender } = render(rail());
    const input = screen.getByRole("textbox", { name: "Message" });

    fireEvent.change(input, { target: { value: "Show hiking trails around Lake Tahoe" } });
    fireEvent.submit(input.closest("form")!);
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: "Show hiking trails around Lake Tahoe" });

    // The reply arrives: the empty state gives way to the open panel.
    chat.messages = [user("Show hiking trails around Lake Tahoe")];
    chat.status = "submitted";
    rerender(rail());
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);

    rerender(rail(true));
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
    rerender(rail(false));
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
  });
});

describe("ChatRail follow-ups", () => {
  it("shows a streaming answer's closing questions as a plain list, then as pills once done", () => {
    chat.messages = [user("Trails?"), assistant(ANSWER, "streaming")];
    chat.status = "streaming";
    const { rerender } = render(rail());
    expect(screen.queryByRole("button", { name: "Which trails are good for a day hike?" })).toBeNull();
    const item = screen.getByText("Which trails are good for a day hike?").closest("li");
    expect(item).not.toBeNull();
    expect(item!.querySelector("button")).toBeNull();
    expect(screen.queryByRole("list", { name: "Follow-up questions" })).toBeNull();

    chat.messages = [user("Trails?"), assistant(ANSWER, "done")];
    chat.status = "ready";
    rerender(rail());
    const pills = screen.getAllByRole("button", { name: /\?$/ });
    expect(pills.map((b) => b.textContent?.replace(/→$/, ""))).toEqual([
      "Which trails are good for a day hike?",
      "Are there fire perimeters nearby?",
      "Where can I camp near the lake?",
    ]);
  });
  it("shows an answer once when the model repeats its note as closing text", () => {
    const body = "Trails mapped around the lake, mostly on the west shore with a few gaps near the south end.";
    chat.messages = [
      user("Trails?"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-note",
            toolCallId: "n1",
            state: "output-available",
            input: { markdown: body },
            output: { markdown: body },
          },
          { type: "text", text: `${body}\n\n- Which trails are good for a day hike?`, state: "done" },
        ],
      } as UIMessage,
    ];
    render(rail());
    expect(screen.getAllByText(body)).toHaveLength(1);
  });
});

const layerOutput = (source: string, url: string) => ({
  kind: "geojson",
  data: { type: "FeatureCollection", features: [] },
  citation: { source, url, retrieved: "2026-10-09" },
});

describe("ChatRail sources line", () => {
  it("lists each cited source once under the answer, as dashed links", () => {
    chat.messages = [
      user("Trails and fires near Tahoe?"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-query_osm-trails",
            toolCallId: "t1",
            state: "output-available",
            input: {},
            output: layerOutput("OpenStreetMap", "https://www.openstreetmap.org/copyright"),
          },
          {
            type: "tool-query_fire-perimeters",
            toolCallId: "t2",
            state: "output-available",
            input: {},
            output: layerOutput("NIFC", "https://data-nifc.opendata.arcgis.com"),
          },
          {
            type: "tool-query_osm-trails",
            toolCallId: "t3",
            state: "output-available",
            input: {},
            output: layerOutput("OpenStreetMap", "https://www.openstreetmap.org/copyright"),
          },
          { type: "text", text: "Trails and two fires.", state: "done" },
        ],
      } as UIMessage,
    ];
    render(rail());
    const line = screen.getByTestId("sources-line");
    expect(line.textContent).toBe("Sources OpenStreetMap · NIFC2026-10-09");
    const links = Array.from(line.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://www.openstreetmap.org/copyright",
      "https://data-nifc.opendata.arcgis.com",
    ]);
    expect(links.every((a) => a.classList.contains("dashed-link"))).toBe(true);
  });

  it("shows no sources line when no tool cited anything", () => {
    chat.messages = [user("Hi"), assistant("Hello.", "done")];
    render(rail());
    expect(screen.queryByTestId("sources-line")).toBeNull();
  });
});

describe("ChatRail layer error card", () => {
  const zoomInError = (output: Record<string, unknown>): UIMessage =>
    ({
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-query_osm-trails", toolCallId: "t1", state: "output-available", input: {}, output }],
    }) as UIMessage;

  it("offers Zoom in to N when the view was too wide, and moves only the camera's zoom on click", () => {
    const onActions = vi.fn();
    chat.messages = [
      user("best hiking trails for elevation"),
      zoomInError({ error: "Area is 417205 km²; zoom in to under 2500 km²", hint: "zoom_in", suggestedZoom: 10 }),
    ];
    render(
      <ChatRail catalog={{}} renderOps={[]} getCanvasSize={canvas} onActions={onActions} collapsed={false} onToggle={noop} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("zoom in to under 2500 km²");
    onActions.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in to 10" }));
    expect(onActions).toHaveBeenCalledWith([{ type: "set_view", viewport: { zoom: 10 } }]);
  });

  it("shows no zoom action without a suggested zoom", () => {
    chat.messages = [user("trails"), zoomInError({ error: "Area is 9000 km²; zoom in to under 2500 km²", hint: "zoom_in" })];
    render(rail());
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Zoom in to/ })).toBeNull();
  });
});

describe("ChatRail loading", () => {
  it("shows the topo heartbeat only while the conversation's first answer is on its way", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    try {
      chat.messages = [user("Trails?")];
      chat.status = "submitted";
      const { rerender } = render(rail());
      expect(screen.getByTestId("topo-heartbeat")).toBeTruthy();

      chat.messages = [user("Trails?"), assistant("Trails mapped.", "streaming")];
      chat.status = "streaming";
      rerender(rail());
      expect(screen.getByTestId("topo-heartbeat")).toBeTruthy();

      chat.messages = [user("Trails?"), assistant("Trails mapped.", "done")];
      chat.status = "ready";
      rerender(rail());
      expect(screen.queryByTestId("topo-heartbeat")).toBeNull();

      // The second question gets the dot spinner, never the heartbeat again.
      chat.messages = [user("Trails?"), assistant("Trails mapped.", "done"), { ...user("And fires?"), id: "u2" }];
      chat.status = "submitted";
      rerender(rail());
      expect(screen.queryByTestId("topo-heartbeat")).toBeNull();
      expect(screen.getByRole("status", { name: "Thinking" })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatRail presentation", () => {
  it("marks the user's line with a chevron instead of a bubble", () => {
    chat.messages = [user("Show hiking trails around Lake Tahoe"), assistant("Done.", "done")];
    render(rail());
    const line = screen.getByTestId("user-message");
    expect(line.textContent).toBe("›Show hiking trails around Lake Tahoe");
  });
});

describe("ChatRail errors", () => {
  it("turns a 429 body into a one-line retry message in the error card", () => {
    chat.messages = [user("Trails?")];
    chat.status = "error";
    chat.error = new Error(JSON.stringify({ error: "Too many requests", retryAfterSeconds: 290 }));
    render(rail());
    expect(screen.getByText("Too many requests, try again in 5 min.")).toBeTruthy();
  });

  it("says when the shared daily cap is reached", () => {
    const daily = new Error(JSON.stringify({ error: "Too many requests", retryAfterSeconds: 86_000, scope: "daily" }));
    expect(readableError(daily)).toBe("The map has reached today's request limit; try again tomorrow.");
  });

  it("offers a new chat when the conversation is too long", () => {
    chat.messages = [user("Trails?")];
    chat.status = "error";
    chat.error = new Error(JSON.stringify({ error: "Request too large" }));
    chat.setMessages = vi.fn();
    chat.clearError = vi.fn();
    render(rail());
    expect(screen.getByRole("alert").textContent).toContain("This conversation is too long; start a new chat.");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(chat.setMessages).toHaveBeenCalledWith([]);
    expect(chat.clearError).toHaveBeenCalled();
  });

  it("shows other route errors as their sentence", () => {
    expect(readableError(new Error(JSON.stringify({ error: "Invalid request body" })))).toBe("Invalid request body");
    expect(readableError(new Error(JSON.stringify({ error: "Too many requests", retryAfterSeconds: 5 })))).toBe(
      "Too many requests, try again in 1 min.",
    );
  });
});

describe("ChatRail suggestions card and the data console", () => {
  beforeEach(() => {
    chat.messages = [];
  });
  afterEach(cleanup);

  it("sits below the console (z-20) and hides on a phone while the console is open", () => {
    const { rerender } = render(rail());
    const overlay = screen.getByTestId("empty-state-overlay");
    expect(overlay.className).toContain("z-10");
    expect(overlay.className).not.toContain("max-md:hidden");
    rerender(
      <ChatRail catalog={{}} renderOps={[]} getCanvasSize={canvas} onActions={noop} collapsed={false} onToggle={noop} layerPanelOpen />,
    );
    expect(screen.getByTestId("empty-state-overlay").className).toContain("max-md:hidden");
  });

  it("hides the card when suggestions are off, and the × and the first message report back", () => {
    const onClose = vi.fn();
    const onSeen = vi.fn();
    const { rerender } = render(
      <ChatRail catalog={{}} renderOps={[]} getCanvasSize={canvas} onActions={noop} collapsed={false} onToggle={noop} suggestionsOpen={false} />,
    );
    expect(screen.queryByTestId("empty-state-overlay")).toBeNull();
    rerender(
      <ChatRail catalog={{}} renderOps={[]} getCanvasSize={canvas} onActions={noop} collapsed={false} onToggle={noop} onSuggestionsClose={onClose} onSuggestionsSeen={onSeen} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close suggestions" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSeen).not.toHaveBeenCalled();
    chat.messages = [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    rerender(
      <ChatRail catalog={{}} renderOps={[]} getCanvasSize={canvas} onActions={noop} collapsed={false} onToggle={noop} onSuggestionsClose={onClose} onSuggestionsSeen={onSeen} />,
    );
    expect(onSeen).toHaveBeenCalled();
  });

  it("mid-conversation, opens above the chat as an overlay; picking a question sends it and closes the card", () => {
    chat.messages = [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    chat.sendMessage.mockClear();
    const onClose = vi.fn();
    const props = { catalog: {}, renderOps: [], getCanvasSize: canvas, onActions: noop, collapsed: false, onToggle: noop };
    const { rerender } = render(<ChatRail {...props} suggestionsOpen={false} />);
    expect(screen.queryByTestId("empty-state")).toBeNull();
    rerender(<ChatRail {...props} suggestionsOpen onSuggestionsClose={onClose} />);
    expect(screen.getByTestId("empty-state-overlay").className).toContain("z-30");
    fireEvent.click(screen.getByRole("button", { name: "Find campsites and forest roads open to vehicles near Moab" }));
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: "Find campsites and forest roads open to vehicles near Moab" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens a collapsed panel when a suggestion is picked mid-conversation", () => {
    chat.messages = [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    const onToggle = vi.fn();
    render(
      <ChatRail catalog={{}} renderOps={[]} getCanvasSize={canvas} onActions={noop} collapsed onToggle={onToggle} suggestionsOpen />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Lake Tahoe/ })[0]);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
