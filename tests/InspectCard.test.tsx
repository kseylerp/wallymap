// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InspectCard, place } from "@/components/InspectCard";
import type { LoadedLayer, Selection } from "@/lib/render/state";
import type { LegendSymbol } from "@/lib/render/wally/legend";

afterEach(cleanup);

const view = { width: 1440, height: 900 };
const card = { width: 340, height: 300 };

describe("place", () => {
  it("sits above the point with the pointer aimed at it", () => {
    const p = place({ x: 700, y: 600 }, card, view);
    expect(p).toMatchObject({ below: false, top: 600 - 14 - 300, pointer: true, offscreen: false });
    expect(p.left + p.pointerX).toBe(700);
  });

  it("flips below when there is more room there", () => {
    expect(place({ x: 700, y: 150 }, card, view)).toMatchObject({ below: true, top: 164, pointer: true });
  });

  it("clamps a tall card inside the window and hides the pointer when it can no longer touch the point", () => {
    const tall = { width: 340, height: 700 };
    const p = place({ x: 700, y: 420 }, tall, view);
    expect(p.top).toBeGreaterThanOrEqual(64);
    expect(p.top + tall.height).toBeLessThanOrEqual(900 - 12);
    expect(p.pointer).toBe(false);
  });

  it("hides the pointer when the card slid sideways past the point", () => {
    expect(place({ x: 2, y: 600 }, card, view).pointer).toBe(false);
    expect(place({ x: 2, y: 600 }, card, view).left).toBe(12);
  });
});

const SWATCH: LegendSymbol = { kind: "line", color: "#3A3A3C", dash: [0, 0], casing: "#FFFFFF", width: 2.5, casingWidth: 4.5 };

describe("InspectCard Escape", () => {
  const layer: LoadedLayer = {
    id: "osm-trails",
    title: "OSM trails",
    style: { geometry: "line", color: "#3A3A3C" },
    result: {
      kind: "geojson",
      data: { type: "FeatureCollection", features: [] },
      citation: { source: "OSM", url: "https://osm.org", retrieved: "2026-10-09" },
    },
    receivedAt: "",
  };
  const selection: Selection = {
    layerId: "osm-trails",
    feature: { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { name: "Trail" } },
    lngLat: [0, 0],
  };

  it("closes on Escape, but not when Escape comes from a form field", () => {
    const onClose = vi.fn();
    render(
      <>
        <input aria-label="Message" />
        <InspectCard
          selection={selection}
          layer={layer}
          swatch={SWATCH}
          project={() => ({ x: 500, y: 500 })}
          onCameraChange={() => () => {}}
          onClose={onClose}
          onAsk={() => true}
          onPreviewRoute={() => {}}
        />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  const renderCard = (sel: Selection) => (
    <InspectCard
      selection={sel}
      layer={layer}
      swatch={SWATCH}
      project={() => ({ x: 500, y: 500 })}
      onCameraChange={() => () => {}}
      onClose={() => {}}
      onAsk={() => true}
      onPreviewRoute={() => {}}
    />
  );

  it("takes focus when it opens and hands it back when it closes", () => {
    const { rerender } = render(
      <>
        <button type="button">Map</button>
        {renderCard(selection)}
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    rerender(<button type="button">Map</button>);
    expect(document.activeElement).toBe(document.body);
  });

  it("returns focus to the control that had it before the card opened", () => {
    const { rerender } = render(<button type="button">Map</button>);
    screen.getByRole("button", { name: "Map" }).focus();
    rerender(
      <>
        <button type="button">Map</button>
        {renderCard(selection)}
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    rerender(<button type="button">Map</button>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Map" }));
  });

  it("marks a feature picked on a compare's side B", () => {
    render(renderCard({ ...selection, side: "b" }));
    expect(screen.getByTestId("inspect-side").textContent).toBe("B");
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toContain("compare side B");
  });

  it("shows no side marker outside a compare's side B", () => {
    render(renderCard(selection));
    expect(screen.queryByTestId("inspect-side")).toBeNull();
  });
});

describe("the hex cell card (spec §12d)", () => {
  const plant = (lng: number, kind: string, v: number, name: string, t: string): GeoJSON.Feature => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, 32.47] },
    properties: { name, kind, v, t },
  });
  const features = [
    plant(-100.4, "wind", 300, "Roscoe Wind", "2009-01-01"),
    plant(-100.401, "wind", 780, "Horse Hollow", "2006-01-01"),
    plant(-100.399, "solar", 50, "Sweetwater Solar", "2021-01-01"),
    plant(-102.5, "gas", 900, "Permian Gas", "2001-01-01"),
  ];
  const layer: LoadedLayer = {
    id: "power-plants",
    title: "Power plants",
    style: { geometry: "point", color: "#3A3A3C", unit: "MW" },
    attributes: [
      { key: "kind", label: "Fuel", type: "category", levels: [{ value: "wind", label: "Wind" }, { value: "solar", label: "Solar" }, { value: "gas", label: "Natural gas" }] },
      { key: "v", label: "Capacity", type: "measure", unit: "MW", encode: "size" },
    ],
    result: { kind: "geojson", data: { type: "FeatureCollection", features }, citation: { source: "EIA", url: "https://www.eia.gov", retrieved: "2026-10-15" } },
    receivedAt: "",
  };

  it("summarises the cell, opens a named feature's own card, zooms to the cell and prefills the chat", async () => {
    const { buildDeckLayers } = await import("@/lib/render/deck");
    const { initialMapState } = await import("@/lib/render/state");
    const { H3HexagonLayer } = await import("@deck.gl/geo-layers");
    const layers = buildDeckLayers({
      ...initialMapState,
      viewport: { ...initialMapState.viewport, zoom: 7 },
      layers: { "power-plants": layer },
      renderOps: [{ layerId: "power-plants", mode: "hexbin", visible: true, hexBasis: "sum" }],
    });
    const tiles = layers.find((l) => l instanceof H3HexagonLayer)!;
    const busy = (tiles.props as { data: GeoJSON.Feature[] }).data.find((h) => h.properties?.count === 3)!;
    const onOpenFeature = vi.fn();
    const onZoomTo = vi.fn();
    const onAskCell = vi.fn();
    render(
      <InspectCard
        selection={{ layerId: "power-plants", feature: busy, lngLat: [-100.4, 32.47], screen: { x: 500, y: 400 } }}
        layer={layer}
        swatch={SWATCH}
        project={() => ({ x: 500, y: 400 })}
        onCameraChange={() => () => {}}
        onClose={() => {}}
        onAsk={() => true}
        onPreviewRoute={() => {}}
        onOpenFeature={onOpenFeature}
        onZoomTo={onZoomTo}
        onAskCell={onAskCell}
      />,
    );
    const card = screen.getByTestId("hex-card");
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("3 power plants in this cell");
    expect(screen.getByTestId("hex-rank").textContent).toMatch(/^1st by capacity, of 2 cells · ≈ [\d,]+ km²$/);
    expect(card.textContent).toContain("per 1,000 km²");
    expect(card.textContent).toContain("Total capacity1,130 MW");
    expect(card.textContent).toContain("Median capacity300 MW");
    expect(card.textContent).toContain("DatesJan 1, 2006 – Jan 1, 2021");
    expect(screen.getByTestId("hex-shares").textContent).toContain("Wind 67%");
    expect(screen.queryByText("Copy GeoJSON")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Horse Hollow" }));
    expect(onOpenFeature).toHaveBeenCalledWith(features[1]);
    fireEvent.click(screen.getByRole("button", { name: /Zoom to this cell/ }));
    expect(onZoomTo.mock.calls[0][0]).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /Ask about this cell/ }));
    expect(onAskCell.mock.calls[0][0]).toMatch(/^In Power plants \(power-plants\) inside the hex cell bbox/);
  });
});
