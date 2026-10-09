// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRail } from "@/components/ChatRail";

type ChatStub = {
  messages: UIMessage[];
  status: "ready" | "submitted" | "streaming" | "error";
  error: Error | undefined;
  sendMessage: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

const chat: ChatStub = { messages: [], status: "ready", error: undefined, sendMessage: vi.fn(), stop: vi.fn() };

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
    expect(pills.map((b) => b.textContent)).toEqual([
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
    expect(line.textContent).toBe("Sources: OpenStreetMap · NIFC");
    const links = Array.from(line.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://www.openstreetmap.org/copyright",
      "https://data-nifc.opendata.arcgis.com",
    ]);
    expect(links.every((a) => a.classList.contains("source-link"))).toBe(true);
  });

  it("shows no sources line when no tool cited anything", () => {
    chat.messages = [user("Hi"), assistant("Hello.", "done")];
    render(rail());
    expect(screen.queryByTestId("sources-line")).toBeNull();
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
