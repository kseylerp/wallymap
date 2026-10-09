// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drawnColor, LayerStack } from "@/components/LayerStack";
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

  it("changes mode and disables columns and hexbin", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const card = screen.getAllByTestId("layer-card")[0];
    const select = within(card).getByRole("combobox") as HTMLSelectElement;
    expect((within(select).getByRole("option", { name: /Columns/ }) as HTMLOptionElement).disabled).toBe(true);
    expect((within(select).getByRole("option", { name: /Hexbin/ }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "heat" } });
    expect(spy).toHaveBeenCalledWith({ type: "set_style", layerId: "osm-trails", mode: "heat" });
  });

  it("renders a monochrome legend row: key, title, count, and no color picker", () => {
    render(<Harness spy={vi.fn()} />);
    const stack = screen.getByTestId("layer-stack");
    expect(within(stack).getByText("Layers")).toBeTruthy();
    // The time scrubber's slot sits at the top, empty until Task 7 mounts it.
    const slot = stack.querySelector('[data-slot="time-scrubber"]');
    expect(slot).toBeTruthy();
    expect(stack.firstElementChild).toBe(slot);
    expect(slot?.childElementCount).toBe(0);

    const [trailsRow, landsRow] = screen.getAllByTestId("layer-card");
    // Trails draw as lines: a solid line sample, white over ink.
    const trailsKey = trailsRow.querySelector("svg.legend-key")!;
    expect(trailsKey.getAttribute("data-kind")).toBe("line");
    expect(trailsKey.querySelectorAll("line")).toHaveLength(2);
    expect(trailsKey.querySelector("line[stroke-dasharray]")).toBeNull();
    // Public lands are vector polygons: an outlined square with a 10% wash.
    const landsKey = landsRow.querySelector("svg.legend-key")!;
    expect(landsKey.getAttribute("data-kind")).toBe("polygon");
    expect(landsKey.querySelector("rect")?.getAttribute("fill-opacity")).toBe("0.1");

    // No swatches, no color popover, no inline colors.
    expect(screen.queryByRole("button", { name: /Color for/ })).toBeNull();
    expect(stack.querySelector("[style*='background-color']")).toBeNull();
    for (const el of stack.querySelectorAll("svg *")) {
      for (const attr of ["fill", "stroke"]) {
        const value = el.getAttribute(attr);
        if (value) expect(["currentColor", "white", "none"].includes(value) || value.startsWith("url(#")).toBe(true);
      }
    }
    // The source is a dashed link.
    expect(within(trailsRow).getByRole("link", { name: "openstreetmap.org" }).className).toContain("dashed-link");
  });

  it("keys points with the layer's symbol sprite, dashes forest roads, and hatches raster tiles", () => {
    const camps: LoadedLayer = { ...trails, id: "campsites", title: "Campsites", style: { geometry: "point", color: "#F2A33A" } };
    const roads: LoadedLayer = { ...trails, id: "forest-roads", title: "Forest roads" };
    const lights: LoadedLayer = {
      ...lands,
      id: "night-lights",
      title: "Night lights",
      result: { kind: "tiles", data: { url: "https://example.test/{z}/{x}/{y}.png", minzoom: 0, maxzoom: 8, format: "raster" }, citation },
    };
    render(
      <LayerStack
        layers={{ campsites: camps, "forest-roads": roads, "night-lights": lights }}
        renderOps={[
          { layerId: "night-lights", mode: "polygons", visible: true },
          { layerId: "forest-roads", mode: "lines", visible: true },
          { layerId: "campsites", mode: "points", visible: false },
        ]}
        catalog={null}
        dispatch={() => {}}
        open
        onOpenChange={() => {}}
      />,
    );
    const [campRow, roadRow, lightsRow] = screen.getAllByTestId("layer-card");
    expect(campRow.querySelector("image")?.getAttribute("href")).toBe("/pins/camp.svg");
    // Hidden layers say so on the row (the key fades) and in the visibility box.
    expect(campRow.getAttribute("data-hidden")).toBe("true");
    expect(within(campRow).getByRole("button", { name: "Show Campsites" }).getAttribute("aria-pressed")).toBe("false");
    expect(roadRow.querySelector("line[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toBe("6 4.5");
    expect(lightsRow.querySelector("svg.legend-key")?.getAttribute("data-kind")).toBe("tiles");
    expect(lightsRow.querySelector("pattern")).toBeTruthy();
    expect(within(lightsRow).getByText("tiles")).toBeTruthy();
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

  it("keeps focus on the grip after an arrow-key reorder", async () => {
    render(<Harness spy={vi.fn()} />);
    const grip = screen.getByRole("button", { name: /Reorder OSM trails/ });
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Reorder OSM trails/ }));
  });

  it("renders nothing while closed (the layers map pill reopens it)", () => {
    render(
      <LayerStack
        layers={start.layers}
        renderOps={start.renderOps}
        catalog={null}
        dispatch={() => {}}
        open={false}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByTestId("layer-stack")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("marks the row whose layer holds the selected feature", () => {
    render(
      <LayerStack
        layers={start.layers}
        renderOps={start.renderOps}
        catalog={null}
        dispatch={() => {}}
        open
        onOpenChange={() => {}}
        selectedLayerId="public-lands"
      />,
    );
    const [top, bottom] = screen.getAllByTestId("layer-card");
    expect(top.getAttribute("data-selected")).toBeNull();
    expect(bottom.getAttribute("data-layer-id")).toBe("public-lands");
    expect(bottom.getAttribute("data-selected")).toBe("true");
    expect(bottom.className).not.toMatch(/sage/);
  });
});

describe("drawnColor", () => {
  const nightLights: LoadedLayer = {
    ...lands,
    id: "night-lights",
    style: { geometry: "polygon", color: "#F2C14E" },
    result: { kind: "tiles", data: { url: "https://example.test/{z}/{x}/{y}.png", minzoom: 0, maxzoom: 8, format: "raster" }, citation },
  };

  it("shows the layer color for points too (the map fills them in it)", () => {
    const species: LoadedLayer = { ...trails, id: "species", style: { geometry: "point", color: "#E24BB1" } };
    expect(drawnColor(species, { layerId: "species", mode: "points", visible: true })).toBe("#E24BB1");
  });

  it("shows a neutral gray for raster tiles, which draw their own colors", () => {
    expect(drawnColor(nightLights, { layerId: "night-lights", mode: "polygons", visible: true })).toBe("#9A9A96");
  });

  it("prefers a color picked in the panel", () => {
    expect(drawnColor(trails, { layerId: "osm-trails", mode: "lines", color: "#FF5A36", visible: true })).toBe("#FF5A36");
  });
});
