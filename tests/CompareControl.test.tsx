// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompareControl, FLIP_MS, windowText } from "@/components/CompareControl";
import { swipeStore } from "@/lib/render/compareView";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => swipeStore.set(0.5));

const fires: LoadedLayer = {
  id: "fire-perimeters",
  title: "Fire perimeters",
  style: { geometry: "polygon", color: "#000000" },
  result: {
    kind: "geojson",
    data: {
      type: "FeatureCollection",
      features: [2017, 2018, 2022].map((year) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [-119.6, 37.8] },
        properties: { name: `F${year}`, year, t: `${year}-07-01T00:00:00.000Z` },
      })),
    },
    citation: { source: "s", url: "u", retrieved: "r" },
  },
  receivedAt: "now",
};
const trails: LoadedLayer = {
  ...fires,
  id: "osm-trails",
  title: "Trails",
  result: { ...fires.result, data: { type: "FeatureCollection", features: [] } } as LoadedLayer["result"],
};
const loaded = [
  { type: "layer_loaded", layer: fires },
  { type: "render", op: { layerId: "fire-perimeters", mode: "polygons", visible: true } },
] as MapAction[];
const withFires = loaded.reduce(reduce, initialMapState);
const spec = { layerId: "fire-perimeters", a: ["2016-01-01", "2020-12-31"] as [string, string], b: ["2021-01-01", "2026-10-09"] as [string, string] };

function Harness({ spy, initial }: { spy: (a: MapAction) => void; initial: MapState }) {
  const [state, dispatch] = useReducer(reduce, initial);
  return (
    <CompareControl
      state={state}
      dispatch={(a) => {
        spy(a);
        dispatch(a);
      }}
    />
  );
}

const comparing = (mode: "swipe" | "toggle" | "delta") => reduce(withFires, { type: "set_compare", compare: { ...spec, mode } });

describe("CompareControl", () => {
  it("shows nothing until a layer has dates", () => {
    const { container } = render(<Harness spy={() => {}} initial={reduce(initialMapState, { type: "layer_loaded", layer: trails })} />);
    expect(container.innerHTML).toBe("");
  });

  it("opens on the layer's preset from the Compare pill", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={withFires} />);
    fireEvent.click(screen.getByTestId("compare-open"));
    expect(spy).toHaveBeenCalledWith({ type: "set_compare", compare: expect.objectContaining({ layerId: "fire-perimeters", a: ["2016-01-01", "2020-12-31"], mode: "delta" }) });
    expect(screen.getByTestId("compare-layer").textContent).toBe("Fire perimeters");
    expect(screen.getByRole("button", { name: "Delta" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("switches mode from the segmented control", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={comparing("delta")} />);
    fireEvent.click(screen.getByRole("button", { name: "Swipe" }));
    expect(spy).toHaveBeenLastCalledWith({ type: "set_compare_mode", mode: "swipe" });
    expect(screen.getByRole("button", { name: "Swipe" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("compare-handle")).toBeTruthy();
  });

  it("shows the delta counts in the legend", () => {
    render(<Harness spy={() => {}} initial={comparing("delta")} />);
    expect(screen.getByRole("list", { name: "Legend" }).textContent).toBe("A only2B only1both0");
  });

  it("moves the swipe handle with the arrow keys", () => {
    render(<Harness spy={() => {}} initial={comparing("swipe")} />);
    const handle = screen.getByTestId("compare-handle");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(swipeStore.get()).toBeCloseTo(0.52);
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(swipeStore.get()).toBeCloseTo(0.42);
    fireEvent.keyDown(handle, { key: "End" });
    expect(swipeStore.get()).toBe(1);
    expect(handle.getAttribute("aria-valuenow")).toBe("100");
  });

  it("exits with × (and Escape)", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={comparing("swipe")} />);
    fireEvent.click(screen.getByTestId("compare-exit"));
    expect(spy).toHaveBeenLastCalledWith({ type: "clear_compare" });
    expect(screen.queryByTestId("compare-control")).toBeNull();
    expect(screen.queryByTestId("compare-handle")).toBeNull();
    expect(screen.getByTestId("compare-open")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={comparing("delta")} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Delta" }), { key: "Escape" });
    expect(spy).toHaveBeenLastCalledWith({ type: "clear_compare" });
  });

  it("flips A and B every second in toggle mode, and space pauses", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    render(<Harness spy={spy} initial={comparing("toggle")} />);
    expect(screen.getByTestId("compare-badge").textContent).toBe("A");
    act(() => void vi.advanceTimersByTime(FLIP_MS));
    expect(screen.getByTestId("compare-badge").textContent).toBe("B");
    fireEvent.keyDown(window, { key: " " });
    act(() => void vi.advanceTimersByTime(FLIP_MS * 3));
    expect(screen.getByTestId("compare-badge").textContent).toBe("B");
    expect(screen.getByTestId("compare-pause").textContent).toBe("Play");
  });

  it("space pauses even with the Toggle button focused", () => {
    vi.useFakeTimers();
    render(<Harness spy={() => {}} initial={comparing("toggle")} />);
    const toggle = screen.getByRole("button", { name: "Toggle" });
    toggle.focus();
    fireEvent.keyDown(toggle, { key: " " });
    act(() => void vi.advanceTimersByTime(FLIP_MS * 2));
    expect(screen.getByTestId("compare-badge").textContent).toBe("A");
    expect(screen.getByTestId("compare-pause").textContent).toBe("Play");
  });

  it("edits a side's window from its date fields", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={comparing("delta")} />);
    fireEvent.change(screen.getByLabelText("B to"), { target: { value: "2024-12-31" } });
    expect(spy).toHaveBeenLastCalledWith({
      type: "set_compare",
      compare: expect.objectContaining({ b: ["2021-01-01", "2024-12-31"], mode: "delta" }),
    });
  });

  it("offers only toggle for a tile layer", () => {
    const loss: LoadedLayer = {
      ...fires,
      id: "forest-loss",
      title: "Forest loss",
      result: { kind: "tiles", data: { url: "https://t.test/{z}/{x}/{y}.png?start_year=2001&end_year=2024", minzoom: 0, maxzoom: 12, format: "raster" }, citation: { source: "s", url: "u", retrieved: "r" } },
    } as LoadedLayer;
    const s = [
      { type: "layer_loaded", layer: loss },
      { type: "set_compare", compare: { layerId: "forest-loss", a: ["2015-01-01", "2015-12-31"], b: ["2025-01-01", "2025-12-31"], mode: "delta" } },
    ].reduce((acc, a) => reduce(acc, a as MapAction), initialMapState);
    render(<Harness spy={() => {}} initial={s} />);
    expect(screen.getByRole("button", { name: "Toggle" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Swipe" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delta" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("windowText", () => {
  it("reads whole years as years, else days", () => {
    expect(windowText(["2016-01-01", "2020-12-31"])).toBe("2016–2020");
    expect(windowText(["2015-01-01", "2015-12-31"])).toBe("2015");
    const today = new Date("2026-10-09T12:00:00Z");
    expect(windowText(["2026-10-06", "2026-10-06"], today)).toBe("2026-10-06");
    expect(windowText(["2026-10-09", "2026-10-09"], today)).toBe("today");
    expect(windowText(["2021-01-01", "2026-10-09"], today)).toBe("2021–today");
    expect(windowText(["2024-03-01", "2024-06-30"], today)).toBe("2024-03-01 – 2024-06-30");
  });
});
