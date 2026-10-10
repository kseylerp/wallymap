// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/EmptyState";
import { MapPills } from "@/components/MapPills";
import { SUGGESTIONS_SEEN_KEY, useSuggestionsCard } from "@/components/useSuggestionsCard";

/** The pill and the card wired the way App wires them. */
function Harness() {
  const s = useSuggestionsCard();
  return (
    <>
      <MapPills basemap="outdoors" onBasemapChange={() => {}} suggestionsOpen={s.open} onToggleSuggestions={s.toggle} />
      {s.open && <EmptyState onPick={() => {}} onClose={s.close} />}
      <button type="button" onClick={s.markSeen}>
        send
      </button>
    </>
  );
}

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("suggestions card, first visit only", () => {
  it("opens on the first visit", () => {
    render(<Harness />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
  });

  it("closes with the × and stays closed after a remount", () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Close suggestions" }));
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(store.get(SUGGESTIONS_SEEN_KEY)).toBeTruthy();
    first.unmount();
    render(<Harness />);
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("the Suggestions pill reopens it and toggles it closed", () => {
    store.set(SUGGESTIONS_SEEN_KEY, "1");
    render(<Harness />);
    expect(screen.queryByTestId("empty-state")).toBeNull();
    const pill = screen.getByRole("button", { name: "Suggestions" });
    expect(pill.textContent).toBe("i");
    expect(pill.getAttribute("title")).toBe("Suggestions");
    fireEvent.click(pill);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    fireEvent.click(pill);
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("counts a sent question as seen", () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    first.unmount();
    render(<Harness />);
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("a pill-opened card closes when the first question is sent", () => {
    store.set(SUGGESTIONS_SEEN_KEY, "1");
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Suggestions" }));
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("still opens, and closes, when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    render(<Harness />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole("button", { name: "Close suggestions" })));
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });
});
