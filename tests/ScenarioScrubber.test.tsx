// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioScrubbers, useScenarioPlay } from "@/components/ScenarioScrubber";
import { SLR_SCENARIO, slrTileUrl } from "@/layers/sea-level-rise";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";
import { PLAY_STEP_MS } from "@/lib/render/useTimePlay";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const slr: LoadedLayer = {
  id: "sea-level-rise",
  title: "Sea level rise flooding",
  style: { geometry: "polygon", color: "#000000" },
  result: {
    kind: "tiles",
    data: { url: slrTileUrl(3), minzoom: 0, maxzoom: 16, format: "raster", scenario: SLR_SCENARIO },
    citation: { source: "NOAA", url: "https://coast.noaa.gov/slr/", retrieved: "r" },
  },
  receivedAt: "now",
};
const start = reduce(initialMapState, { type: "layer_loaded", layer: slr });

/** The harness's latest state, written after each render. */
const seen: { state: MapState } = { state: start };
function Harness() {
  const [state, dispatch] = useReducer(reduce, start);
  useEffect(() => {
    seen.state = state;
  }, [state]);
  useScenarioPlay(state.scenario?.playing ?? false, dispatch);
  return <ScenarioScrubbers state={state} dispatch={dispatch} />;
}

describe("ScenarioScrubber", () => {
  it("titles the strip by the label and reads out the queried amount with conversions", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Sea level rise" })).toBeTruthy();
    expect(screen.getByTestId("scenario-readout").textContent).toBe("3 ft · 0.9 m · 36 in");
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("3");
  });

  it("steps half a foot with › and ‹, and arrow keys on the handle; × goes back to the queried amount", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Step up" }));
    expect(screen.getByTestId("scenario-readout").textContent).toBe("3.5 ft · 1.1 m · 42 in");
    fireEvent.keyDown(screen.getByRole("slider"), { key: "End" });
    expect(screen.getByTestId("scenario-readout").textContent).toBe("10 ft · 3 m · 120 in");
    fireEvent.click(screen.getByRole("button", { name: "Step down" }));
    expect(seen.state.scenario?.value).toBe(9.5);
    fireEvent.click(screen.getByRole("button", { name: /Back to the queried/ }));
    expect(seen.state.scenario).toBeUndefined();
    expect(screen.getByTestId("scenario-readout").textContent).toBe("3 ft · 0.9 m · 36 in");
  });

  it("plays one amount per 600 ms", () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(screen.getByTestId("scenario-play"));
    expect(screen.getByTestId("scenario-play").textContent).toBe("Pause");
    act(() => {
      vi.advanceTimersByTime(PLAY_STEP_MS * 2);
    });
    expect(seen.state.scenario?.value).toBe(4);
    fireEvent.click(screen.getByTestId("scenario-play"));
    expect(seen.state.scenario?.playing).toBe(false);
  });

  it("renders nothing without a scenario layer", () => {
    const { container } = render(<ScenarioScrubbers state={initialMapState} dispatch={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
