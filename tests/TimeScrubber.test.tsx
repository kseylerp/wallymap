// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayerStack } from "@/components/LayerStack";
import { TimeScrubber } from "@/components/TimeScrubber";
import { reduce } from "@/lib/render/reducer";
import { PLAY_STEP_MS, useTimePlay } from "@/lib/render/useTimePlay";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const fires: LoadedLayer = {
  id: "fire-perimeters",
  title: "Fire perimeters",
  style: { geometry: "polygon", color: "#000000" },
  result: {
    kind: "geojson",
    data: {
      type: "FeatureCollection",
      features: Array.from({ length: 10 }, (_, k) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [0, 0] },
        properties: { t: `${2016 + k}-07-01T00:00:00.000Z` },
      })),
    },
    citation: { source: "s", url: "u", retrieved: "r" },
  },
  receivedAt: "now",
};
const start = reduce(initialMapState, { type: "layer_loaded", layer: fires });

function Harness({ spy, initial = start }: { spy: (a: MapAction) => void; initial?: MapState }) {
  const [state, dispatch] = useReducer(reduce, initial);
  // As in App: the play timer runs outside the scrubber.
  useTimePlay(state.time?.playing ?? false, dispatch);
  if (!state.time) return <p>no scrubber</p>;
  return (
    <TimeScrubber
      time={state.time}
      dispatch={(a) => {
        spy(a);
        dispatch(a);
      }}
    />
  );
}

const label = () => screen.getByTestId("time-window-label").textContent;

describe("TimeScrubber", () => {
  it("shows a bar per bucket, the window's dates and counts", () => {
    render(<Harness spy={() => {}} />);
    expect(label()).toBe("2016 – 2025");
    expect(document.querySelectorAll(".time-bar")).toHaveLength(10);
    expect(screen.getByText("features per year")).toBeTruthy();
  });

  it("names the cadence and counts images for a dated tile layer alone", () => {
    const greenness: LoadedLayer = {
      id: "greenness",
      title: "Vegetation greenness",
      style: { geometry: "polygon", color: "#000000" },
      result: {
        kind: "tiles",
        data: {
          url: "https://g/ndvi/2026-09-14/{z}/{x}/{y}.png",
          minzoom: 0,
          maxzoom: 9,
          format: "raster",
          time: { template: "https://g/ndvi/{date}/{z}/{x}/{y}.png", cadence: "16day", from: "2000-03-05", daysBack: 25 },
        },
        citation: { source: "s", url: "u", retrieved: "r" },
      },
      receivedAt: "now",
    };
    render(<Harness spy={() => {}} initial={reduce(initialMapState, { type: "layer_loaded", layer: greenness })} />);
    expect(screen.getByTestId("time-step-label").textContent).toBe("one image per 16 days");
    expect(document.querySelectorAll(".time-bar").length).toBeGreaterThan(2);
  });

  it("play steps one bucket every 600 ms; pause stops it", () => {
    vi.useFakeTimers();
    render(<Harness spy={() => {}} />);
    fireEvent.click(screen.getByTestId("time-play"));
    expect(screen.getByTestId("time-play").textContent).toBe("Pause");
    // Playing the whole span starts over at the first year.
    expect(label()).toBe("2016");
    act(() => {
      vi.advanceTimersByTime(PLAY_STEP_MS);
    });
    expect(label()).toBe("2017");
    fireEvent.click(screen.getByTestId("time-play"));
    expect(screen.getByTestId("time-play").textContent).toBe("Play");
    act(() => {
      vi.advanceTimersByTime(PLAY_STEP_MS * 3);
    });
    expect(label()).toBe("2017");
  });

  it("play keeps stepping while the layer panel (and the scrubber in it) is closed", () => {
    vi.useFakeTimers();
    function ClosedPanel() {
      const [state, dispatch] = useReducer(reduce, start);
      useTimePlay(state.time?.playing ?? false, dispatch);
      return (
        <>
          <button type="button" onClick={() => dispatch({ type: "set_time_playing", playing: true })}>
            agent play
          </button>
          <p data-testid="window">{state.time?.window.join(" ")}</p>
          <LayerStack
            layers={state.layers}
            renderOps={state.renderOps}
            catalog={null}
            dispatch={dispatch}
            open={false}
            onOpenChange={() => {}}
            time={state.time}
            shownLayers={state.layers}
          />
        </>
      );
    }
    render(<ClosedPanel />);
    expect(screen.queryByTestId("time-scrubber")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "agent play" }));
    expect(screen.getByTestId("window").textContent).toBe("2016-01-01T00:00:00.000Z 2016-12-31T23:59:59.999Z");
    act(() => {
      vi.advanceTimersByTime(PLAY_STEP_MS * 2);
    });
    expect(screen.getByTestId("window").textContent).toBe("2018-01-01T00:00:00.000Z 2018-12-31T23:59:59.999Z");
  });

  it("says when a dated tile layer has no image for the window's date", () => {
    const { rerender } = render(<TimeScrubber time={start.time!} dispatch={() => {}} />);
    expect(screen.queryByTestId("time-missing-image")).toBeNull();
    rerender(<TimeScrubber time={start.time!} dispatch={() => {}} missingImage />);
    expect(screen.getByTestId("time-missing-image").textContent).toBe("No image for 2025");
  });

  it("the scrubber alone runs no timer", () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const playing = reduce(start, { type: "set_time_playing", playing: true });
    render(<TimeScrubber time={playing.time!} dispatch={spy} />);
    act(() => {
      vi.advanceTimersByTime(PLAY_STEP_MS * 3);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("space plays and pauses from inside the scrubber", () => {
    render(<Harness spy={() => {}} />);
    fireEvent.keyDown(screen.getByTestId("time-window"), { key: " " });
    expect(screen.getByTestId("time-play").getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(screen.getByTestId("time-window"), { key: " " });
    expect(screen.getByTestId("time-play").getAttribute("aria-pressed")).toBe("false");
  });

  it("arrow keys move the window, and each handle moves its own end", () => {
    const initial = reduce(start, { type: "set_time_window", window: ["2018-01-01T00:00:00.000Z", "2019-12-31T23:59:59.999Z"] });
    render(<Harness spy={() => {}} initial={initial} />);
    expect(label()).toBe("2018 – 2019");
    fireEvent.keyDown(screen.getByTestId("time-window"), { key: "ArrowRight" });
    expect(label()).toBe("2019 – 2020");
    fireEvent.keyDown(screen.getByTestId("time-window"), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByTestId("time-window"), { key: "ArrowLeft" });
    expect(label()).toBe("2017 – 2018");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Window end" }), { key: "ArrowRight" });
    expect(label()).toBe("2017 – 2019");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Window start" }), { key: "Home" });
    expect(label()).toBe("2016 – 2019");
  });

  it("pressing a handle focuses it, so the keys that follow move that end", () => {
    render(<Harness spy={() => {}} />);
    const end = screen.getByRole("slider", { name: "Window end" });
    fireEvent.pointerDown(end, { button: 0, clientX: 0, pointerId: 1 });
    expect(document.activeElement).toBe(end);
  });

  it("cumulative mode grows from the first year", () => {
    const initial = reduce(start, { type: "set_time_window", window: ["2018-01-01T00:00:00.000Z", "2019-12-31T23:59:59.999Z"] });
    render(<Harness spy={() => {}} initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Cumulative" }));
    expect(label()).toBe("2016 – 2019");
    expect(screen.queryByRole("slider", { name: "Window start" })).toBeNull();
  });

  it("× clears the time window", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear time window" }));
    expect(spy).toHaveBeenCalledWith({ type: "clear_time" });
    expect(screen.getByText("no scrubber")).toBeTruthy();
  });
});
