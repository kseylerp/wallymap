// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayerStack } from "@/components/LayerStack";
import { reduce } from "@/lib/render/reducer";
import { initialMapState, type LoadedLayer, type MapAction, type MapState } from "@/lib/render/state";

afterEach(cleanup);

const citation = { source: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright", retrieved: "2026-10-09" };
const trails: LoadedLayer = {
  id: "osm-trails",
  title: "OSM trails",
  style: { geometry: "line", color: "#2F3A44" },
  result: { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation, coverageNote: "Zoom in for more" },
  receivedAt: "2026-10-09T00:00:00Z",
};
const lands: LoadedLayer = {
  id: "public-lands",
  title: "Public lands",
  style: { geometry: "polygon", color: "#B9A6FF" },
  result: {
    kind: "tiles",
    data: { url: "https://example.test/{z}/{x}/{y}.pbf", minzoom: 0, maxzoom: 12, format: "vector", sourceLayer: "padus" },
    citation,
  },
  receivedAt: "2026-10-09T00:00:00Z",
};
const start: MapState = {
  ...initialMapState,
  layers: { "osm-trails": trails, "public-lands": lands },
  renderOps: [
    { layerId: "public-lands", mode: "polygons", visible: true },
    { layerId: "osm-trails", mode: "lines", visible: true },
  ],
};

/** The panel wired to the real reducer, with every dispatched action recorded. */
function Harness({ spy }: { spy: (a: MapAction) => void }) {
  const [state, dispatch] = useReducer(reduce, start);
  return (
    <LayerStack
      layers={state.layers}
      renderOps={state.renderOps}
      catalog={{ "osm-trails": { title: "OSM trails", style: trails.style, license: "ODbL" } }}
      dispatch={(a) => {
        spy(a);
        dispatch(a);
      }}
      open
      onOpenChange={() => {}}
    />
  );
}

describe("LayerStack", () => {
  it("lists layers top first with count or tiles, coverage note, license and source", () => {
    render(<Harness spy={vi.fn()} />);
    const cards = screen.getAllByTestId("layer-card");
    expect(cards.map((c) => c.getAttribute("data-layer-id"))).toEqual(["osm-trails", "public-lands"]);
    expect(within(cards[0]).getByText("0")).toBeTruthy();
    expect(within(cards[0]).getByText("Zoom in for more")).toBeTruthy();
    expect(within(cards[0]).getByText(/ODbL/)).toBeTruthy();
    expect(within(cards[0]).getByRole("link", { name: "openstreetmap.org" }).getAttribute("href")).toBe(citation.url);
    expect(within(cards[1]).getByText("tiles")).toBeTruthy();
    // Mode select only for geojson layers.
    expect(within(cards[0]).queryByRole("combobox")).toBeTruthy();
    expect(within(cards[1]).queryByRole("combobox")).toBeNull();
  });

  it("toggles visibility through dispatch", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const eye = screen.getByRole("button", { name: "Show OSM trails" });
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(eye);
    expect(spy).toHaveBeenCalledWith({ type: "toggle_layer", layerId: "osm-trails" });
    expect(screen.getByRole("button", { name: "Show OSM trails" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("changes opacity through dispatch", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const slider = within(screen.getAllByTestId("layer-card")[0]).getByRole("slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.35" } });
    expect(spy).toHaveBeenCalledWith({ type: "set_opacity", layerId: "osm-trails", opacity: 0.35 });
    expect(slider.value).toBe("0.35");
    expect(within(screen.getAllByTestId("layer-card")[0]).getByText("35%")).toBeTruthy();
  });

  it("changes mode, disables columns and hexbin, and picks a preset color", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const card = screen.getAllByTestId("layer-card")[0];
    const select = within(card).getByRole("combobox") as HTMLSelectElement;
    expect((within(select).getByRole("option", { name: /Columns/ }) as HTMLOptionElement).disabled).toBe(true);
    expect((within(select).getByRole("option", { name: /Hexbin/ }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "heat" } });
    expect(spy).toHaveBeenCalledWith({ type: "set_style", layerId: "osm-trails", mode: "heat" });
    fireEvent.click(within(card).getByRole("button", { name: "Color for OSM trails" }));
    fireEvent.click(screen.getByRole("button", { name: "Use #5E7D5A" }));
    expect(spy).toHaveBeenCalledWith({ type: "set_style", layerId: "osm-trails", color: "#5E7D5A" });
  });

  it("reorders with the arrow keys on the grip, and removes and clears layers", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Reorder OSM trails/ }), { key: "ArrowDown" });
    expect(spy).toHaveBeenCalledWith({ type: "reorder", layerId: "osm-trails", toIndex: 0 });
    expect(screen.getAllByTestId("layer-card").map((c) => c.getAttribute("data-layer-id"))).toEqual([
      "public-lands",
      "osm-trails",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove OSM trails" }));
    expect(screen.getAllByTestId("layer-card")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByTestId("layer-stack")).toBeNull();
  });

  it("collapses to a Layers pill with the count", () => {
    const onOpenChange = vi.fn();
    render(
      <LayerStack
        layers={start.layers}
        renderOps={start.renderOps}
        catalog={null}
        dispatch={() => {}}
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    expect(screen.queryByTestId("layer-stack")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Layers, 2 loaded" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
