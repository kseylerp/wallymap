// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/EmptyState";
import { MapPills } from "@/components/MapPills";
import { SUGGESTIONS_SEEN_KEY, SUGGESTIONS_SET_KEY, useSuggestionsCard } from "@/components/useSuggestionsCard";
import { FIRST_VISIT, SUGGESTION_POOL } from "@/lib/suggestions";

/** The pill and the card wired the way App wires them. */
function Harness() {
  const s = useSuggestionsCard();
  return (
    <>
      <MapPills basemap="outdoors" onBasemapChange={() => {}} suggestionsOpen={s.open} onToggleSuggestions={s.toggle} />
      {s.open && <EmptyState onPick={() => {}} onClose={s.close} questions={s.questions} onMore={s.more} />}
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

/** The questions on the card now, read from its buttons (the × and More are not questions). */
function shown(): string[] {
  const card = screen.getByTestId("empty-state");
  return Array.from(card.querySelectorAll("li button")).map((b) => b.textContent ?? "");
}
const themeOf = (q: string) => SUGGESTION_POOL.find((s) => s.q === q)?.theme;

describe("suggestions card, rotation", () => {
  it("the first automatic open shows the six starters", () => {
    render(<Harness />);
    expect(shown()).toEqual([...FIRST_VISIT]);
  });

  it("a later open shows a different set that spans themes", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Close suggestions" }));
    fireEvent.click(screen.getByRole("button", { name: "Suggestions" }));
    const second = shown();
    expect(second).toHaveLength(6);
    expect(second.filter((q) => FIRST_VISIT.includes(q as (typeof FIRST_VISIT)[number]))).toEqual([]);
    expect(new Set(second.map(themeOf)).size).toBe(6);
    expect(store.get(SUGGESTIONS_SET_KEY)).toBe("1");
  });

  it("More swaps in a set that shares no question with the one it replaces", () => {
    render(<Harness />);
    let previous = shown();
    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      const next = shown();
      expect(next).toHaveLength(6);
      expect(next.filter((q) => previous.includes(q))).toEqual([]);
      previous = next;
    }
  });

  it("keeps rotating after a reload", () => {
    store.set(SUGGESTIONS_SEEN_KEY, "1");
    store.set(SUGGESTIONS_SET_KEY, "4");
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Suggestions" }));
    const afterReload = shown();
    expect(store.get(SUGGESTIONS_SET_KEY)).toBe("5");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(shown()).not.toEqual(afterReload);
    expect(store.get(SUGGESTIONS_SET_KEY)).toBe("6");
  });

  it("still rotates, and does not throw, when storage fails", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    render(<Harness />);
    expect(shown()).toEqual([...FIRST_VISIT]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const second = shown();
    expect(second).not.toEqual([...FIRST_VISIT]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(shown()).not.toEqual(second);
  });
});
