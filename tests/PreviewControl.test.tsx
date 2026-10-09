// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewControl } from "@/components/PreviewControl";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type MapAction, type MapState } from "@/lib/render/state";
import { elevationStore, mapStateStore } from "@/lib/render/wally/playback";

afterEach(() => {
  cleanup();
  act(() => {
    mapStateStore.set(null);
    elevationStore.set(null);
  });
});

const withRoute: MapState = {
  ...initialMapState,
  routes: {
    r: {
      id: "r",
      name: "Tahoe City to Emerald Bay",
      line: { type: "LineString", coordinates: [[-120.14, 39.17], [-120.12, 39.1], [-120.1, 38.95]] },
      source: "tool",
      distanceKm: 25,
      waypoints: [],
    },
  },
};

/** Renders the control against a live reducer, as the app wires it. */
function mount(initial: MapState) {
  let state = initial;
  const onActions = vi.fn((actions: MapAction[]) => {
    for (const a of actions) state = reduce(state, a);
    act(() => mapStateStore.set(state));
  });
  act(() => mapStateStore.set(state));
  render(<PreviewControl onActions={onActions} />);
  return { onActions, get state() { return state; } };
}

describe("PreviewControl", () => {
  it("renders nothing without a route", () => {
    act(() => mapStateStore.set(initialMapState));
    const { container } = render(<PreviewControl onActions={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("offers a preview pill for the newest route and starts it", () => {
    const app = mount(withRoute);
    fireEvent.click(screen.getByRole("button", { name: /Preview route Tahoe City/ }));
    expect(app.onActions).toHaveBeenCalledWith([{ type: "preview_start", routeId: "r" }]);
    expect(screen.getByRole("region", { name: "Route preview" })).toBeTruthy();
  });

  it("toggles play with the button and Space, changes speed, and exits with Escape", () => {
    const app = mount(reduce(withRoute, { type: "preview_start", routeId: "r" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause preview" }));
    expect(app.state.playback?.playing).toBe(false);
    expect(screen.getByRole("button", { name: "Play preview" })).toBeTruthy();

    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(app.state.playback?.playing).toBe(true);
    expect(screen.getByRole("button", { name: "Pause preview" })).toBeTruthy();

    // Typing in the composer is left alone.
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: " ", code: "Space" });
    expect(app.state.playback?.playing).toBe(true);
    input.remove();

    fireEvent.click(screen.getByRole("button", { name: "Speed 2×" }));
    expect(app.state.playback?.speed).toBe(2);
    expect(screen.getByRole("button", { name: "Speed 2×" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByRole("slider", { name: "Preview position" }), { target: { value: "500" } });
    expect(app.state.playback?.fraction).toBe(0.5);

    // Space and Escape still work with the slider focused (it is an input, but not a text field).
    fireEvent.keyDown(screen.getByRole("slider", { name: "Preview position" }), { key: " ", code: "Space" });
    expect(app.state.playback?.playing).toBe(false);

    fireEvent.keyDown(screen.getByRole("slider", { name: "Preview position" }), { key: "Escape" });
    expect(app.state.playback).toBeUndefined();
  });

  it("shows the climb once heights arrive", () => {
    mount(reduce(withRoute, { type: "preview_start", routeId: "r" }));
    expect(screen.getByText("Reading terrain…")).toBeTruthy();
    act(() => elevationStore.set({ routeId: "r", values: [1900, 1950, 2000, 1980] }));
    expect(screen.getByLabelText(/Climb .* ft, descent .* ft/)).toBeTruthy();
  });
});
