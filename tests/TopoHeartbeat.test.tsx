// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_VERBS, TopoHeartbeat, VERB_INTERVAL_MS } from "@/components/TopoHeartbeat";

beforeEach(() => {
  vi.useFakeTimers();
  // No contours in jsdom: the fetch fails and the band keeps its plain surface.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TopoHeartbeat", () => {
  it("rotates its verb every 2.5 s and wraps around", () => {
    render(<TopoHeartbeat />);
    const verb = () => screen.getByTestId("heartbeat-verb").textContent;
    expect(verb()).toBe(`${HEARTBEAT_VERBS[0]}…`);

    act(() => vi.advanceTimersByTime(VERB_INTERVAL_MS - 1));
    expect(verb()).toBe(`${HEARTBEAT_VERBS[0]}…`);
    act(() => vi.advanceTimersByTime(1));
    expect(verb()).toBe(`${HEARTBEAT_VERBS[1]}…`);

    act(() => vi.advanceTimersByTime(VERB_INTERVAL_MS * (HEARTBEAT_VERBS.length - 1)));
    expect(verb()).toBe(`${HEARTBEAT_VERBS[0]}…`);
  });

  it("stops rotating once unmounted", () => {
    const { unmount } = render(<TopoHeartbeat />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
