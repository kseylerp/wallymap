// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayerFilters } from "@/components/LayerFilters";
import { applyFilters, filterSummary, type FilterField, type LayerFilters as Filters } from "@/lib/render/filters";
import type { MapAction } from "@/lib/render/state";

afterEach(cleanup);

/** Fire sizes in acres, decimals included: the smallest 4164.94, the largest 221,400.5 (step 1000). */
const acres: FilterField = { key: "acres", label: "Acres", kind: "range", min: 4164.94, max: 221400.5, integer: false };
const fires: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [4164.94, 12000.25, 50000, 221400.5].map((a) => ({
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [0, 0] },
    properties: { acres: a },
  })),
};

function Harness({ spy }: { spy: (a: MapAction) => void }) {
  const [filters, setFilters] = useState<Filters>({});
  return (
    <LayerFilters
      id="f"
      layerId="fire-perimeters"
      title="Fires"
      fields={[acres]}
      filters={filters}
      dispatch={(a) => {
        spy(a);
        if (a.type === "set_filters") setFilters(a.filters);
      }}
    />
  );
}

const lower = () => screen.getByRole("slider", { name: "Acres from" });
const upper = () => screen.getByRole("slider", { name: "Acres to" });
const lastRange = (spy: ReturnType<typeof vi.fn>) => {
  const action = spy.mock.lastCall?.[0] as Extract<MapAction, { type: "set_filters" }>;
  return action.filters.acres?.range;
};

describe("LayerFilters range", () => {
  it("rounds only the thumb that moved; the untouched end keeps the real max, so the largest feature stays", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.change(lower(), { target: { value: "5000" } });
    const range = lastRange(spy);
    expect(range).toEqual([5000, 221400.5]);
    const kept = applyFilters(fires, { acres: { range: range! } }).features.map((f) => f.properties?.acres);
    expect(kept).toEqual([12000.25, 50000, 221400.5]);
    // At the real max the upper thumb is unbounded, so the summary reads as a floor.
    expect(filterSummary([acres], { acres: { range: range! } })).toBe("acres ≥ 5000");
  });

  it("a thumb dragged to the end of the data clears that side's bound", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.change(upper(), { target: { value: "100000" } });
    expect(lastRange(spy)).toEqual([4164.94, 100000]);
    expect(filterSummary([acres], { acres: { range: lastRange(spy)! } })).toBe("acres ≤ 100000");
    fireEvent.change(upper(), { target: { value: "222000" } });
    // Both ends unbounded: no filter at all.
    expect(spy).toHaveBeenLastCalledWith({ type: "set_filters", layerId: "fire-perimeters", filters: {} });
  });

  it("a thumb dragged past the other pushes it, and the lower thumb sits on top in the upper half", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.change(lower(), { target: { value: "222000" } });
    expect(lastRange(spy)).toEqual([221400.5, 221400.5]);
    // Both thumbs at the max: the lower one is on top, so it can be pulled back down.
    expect(lower().style.zIndex).toBe("1");
    fireEvent.change(lower(), { target: { value: "100000" } });
    expect(lastRange(spy)).toEqual([100000, 221400.5]);
    fireEvent.change(upper(), { target: { value: "50000" } });
    expect(lastRange(spy)).toEqual([50000, 50000]);
  });

  it("the thumbs announce their value, and say when they are at the end of the data", () => {
    render(<Harness spy={() => {}} />);
    expect(lower().getAttribute("aria-valuetext")).toBe("4,165, lowest");
    expect(upper().getAttribute("aria-valuetext")).toBe("221,401, highest");
    fireEvent.change(lower(), { target: { value: "5000" } });
    expect(lower().getAttribute("aria-valuetext")).toBe("5,000");
  });
});
