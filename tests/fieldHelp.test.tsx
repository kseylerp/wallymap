// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InspectCard } from "@/components/InspectCard";
import { AttributeControls } from "@/components/AttributeControls";
import { getLayer } from "@/layers";
import { cardContent, humanKey } from "@/lib/render/card";
import type { LoadedLayer, Selection } from "@/lib/render/state";
import type { LegendSymbol } from "@/lib/render/wally/legend";

afterEach(cleanup);

const SWATCH: LegendSymbol = { kind: "tiles", color: "#3A3A3C" };
const citation = { source: "Navajo Nation EPA / US EPA", url: "https://example.com", retrieved: "2026-10-14" };

function loaded(id: string, features: GeoJSON.Feature[]): LoadedLayer {
  const layer = getLayer(id)!;
  return {
    id,
    title: layer.title,
    style: layer.style,
    result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation },
    receivedAt: "",
    ...(layer.fieldHelp && { fieldHelp: layer.fieldHelp }),
    ...(layer.card && { card: layer.card }),
  };
}

const mine: GeoJSON.Feature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-109.7, 36.6] },
  properties: { name: "Tract 15", kind: "abandoned mine", v: 170, hazardScore: 170, chapter: "Oljato", groundwaterScore: 40, mineId: 12 },
};
const crag: GeoJSON.Feature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-83.68, 37.78] },
  properties: {
    name: "Muir Valley",
    kind: "crag",
    v: 5,
    grades: "4- to 5+ (UIAA)",
    disciplines: "trad, sport",
    trad: 1,
    sport: 4,
    maxLengthM: 46,
    source: "osm+openbeta",
    url: "https://openbeta.io/areas/abc",
    osmId: "node/1",
    climbing_rock: "sandstone",
  },
};

function card(layer: LoadedLayer, feature: GeoJSON.Feature) {
  const selection: Selection = { layerId: layer.id, feature, lngLat: [0, 0] };
  return render(
    <InspectCard
      selection={selection}
      layer={layer}
      swatch={SWATCH}
      project={() => ({ x: 500, y: 500 })}
      onCameraChange={() => () => {}}
      onClose={() => {}}
      onAsk={() => true}
      onPreviewRoute={() => {}}
    />,
  );
}

describe("field help on the inspect card (spec §12b)", () => {
  it("names the uranium score and puts the serif i beside it; its popover has the text, the scale and the source link", () => {
    card(loaded("uranium", [mine]), mine);
    const measure = screen.getByTestId("inspect-measure");
    expect(measure.textContent).not.toMatch(/^Score/);
    expect(measure.textContent).not.toContain("/ 100");
    expect(measure.textContent).toContain("Hazard score");
    const mark = within(measure).getByTestId("info-mark");
    expect(mark.textContent).toBe("i");
    fireEvent.click(mark);
    const popover = screen.getByTestId("info-popover");
    expect(popover.textContent).toMatch(/Navajo/);
    expect(popover.textContent).toContain("Scale:");
    expect(within(popover).getByRole("link").getAttribute("href")).toMatch(/^https:\/\//);
    // Escape closes the popover, not the card.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("info-popover")).toBeNull();
    expect(screen.getByTestId("inspect-card")).toBeTruthy();
  });

  it("lays out the climbing card from its schema: Routes 5, plain facts, spelled-out source, a named link, the rest under Details", () => {
    card(loaded("climbing", [crag]), crag);
    expect(screen.getByTestId("inspect-measure").textContent).toMatch(/^Routes.*5$/);
    expect(screen.queryByText(/^value$/i)).toBeNull();
    const text = screen.getByTestId("inspect-card").textContent ?? "";
    expect(text).toMatch(/Longest routei?46 m/);
    expect(text).toContain("Trad · Sport");
    expect(text).toContain("trad 1 · sport 4");
    expect(text).toContain("OpenStreetMap + OpenBeta");
    expect(screen.getByRole("link", { name: "Open on OpenBeta" }).getAttribute("href")).toBe("https://openbeta.io/areas/abc");
    // Properties the schema does not name go under Details, humanised.
    const details = screen.getByText(/Details/).closest("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Climbing rock");
  });

  it("humanises keys and their units", () => {
    expect(humanKey("maxLengthM")).toEqual({ label: "Max length", unit: "m" });
    expect(humanKey("areaKm2")).toEqual({ label: "Area", unit: "km²" });
    expect(humanKey("climbing_rock")).toEqual({ label: "Climbing rock" });
  });

  it("never shows a bare score: without a schema the score row takes its property's name and its help", () => {
    const layer = { ...loaded("uranium", [mine]), card: undefined };
    const content = cardContent(mine, { unit: "score", fieldHelp: layer.fieldHelp });
    expect(content.measure?.label).toBe("Hazard score");
    expect(content.measure?.help).toBeTruthy();
  });
});

describe("attribute chips and the legend carry the same help on hover", () => {
  it("renders chips with labels, counts, line keys and aria-pressed, and writes the filters", () => {
    const mtb = getLayer("mtb-trails")!;
    const lines = [0, 1, 3, 3, 5].map((v, i): GeoJSON.Feature => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[0, i], [1, i]] },
      properties: { name: `t${i}`, v, kind: "mtb" },
    }));
    const data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: lines };
    const dispatch = vi.fn();
    const layer: LoadedLayer = {
      id: "mtb-trails",
      title: "Mountain bike trails",
      style: mtb.style,
      fieldHelp: mtb.fieldHelp,
      attributes: mtb.attributes,
      result: { kind: "geojson", data, citation },
      receivedAt: "2026-10-14",
    };
    render(<AttributeControls layer={layer} op={{ layerId: "mtb-trails", mode: "lines", visible: true }} data={data} shown={data} fields={[]} dispatch={dispatch} />);
    const hard = screen.getAllByTestId("attribute-chip").find((c) => c.textContent?.startsWith("Hard"))!;
    expect(hard.getAttribute("aria-pressed")).toBe("false");
    expect(hard.textContent).toContain("2");
    expect(hard.getAttribute("title")).toMatch(/Hard: 2 · .+/);
    expect(hard.querySelector("svg")).toBeTruthy();
    fireEvent.click(hard);
    expect(dispatch).toHaveBeenCalledWith({ type: "set_filters", layerId: "mtb-trails", filters: { v: { include: ["3"] } } });
  });
});
