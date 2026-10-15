// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layerLegend, LayerStack } from "@/components/LayerStack";
import { DARK_GREY, PALETTE, PINK, PURPLE, SAGE } from "@/lib/render/palette";
import { pinIconFor } from "@/lib/render/wally/pins";
import { reduce } from "@/lib/render/reducer";
import { visibleState } from "@/lib/render/view";
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
  it("lists layers top first with count or tiles, and one line of source and coverage with the licence behind the i", () => {
    render(<Harness spy={vi.fn()} />);
    const cards = screen.getAllByTestId("layer-card");
    expect(cards.map((c) => c.getAttribute("data-layer-id"))).toEqual(["osm-trails", "public-lands"]);
    expect(within(cards[0]).getByTestId("layer-count").textContent).toBe("0");
    const source = within(cards[0]).getByTestId("layer-source");
    expect(source.textContent).toContain("Zoom in for more");
    expect(source.querySelector(".truncate")).toBeTruthy();
    expect(within(source).getByRole("link", { name: "openstreetmap.org" }).getAttribute("href")).toBe(citation.url);
    // The licence is not on the line; it is one press away, with the full note and the source.
    expect(source.textContent).not.toContain("ODbL");
    fireEvent.click(within(source).getByRole("button", { name: "About the source of OSM trails" }));
    const popover = screen.getByTestId("info-popover");
    expect(popover.textContent).toContain("Zoom in for more");
    expect(popover.textContent).toContain("Licence: ODbL");
    expect(popover.textContent).toContain("OpenStreetMap");
    expect(within(cards[1]).getByText("tiles")).toBeTruthy();
    // No mode control for lines, areas or tiles: Show as is for point layers only.
    for (const card of cards) {
      expect(within(card).queryByRole("combobox")).toBeNull();
      expect(within(card).queryByTestId("mode-control")).toBeNull();
    }
  });

  it("toggles visibility through dispatch", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const toggle = screen.getByRole("button", { name: "Hide OSM trails" });
    expect(toggle.textContent).toBe("Hide");
    fireEvent.click(toggle);
    expect(spy).toHaveBeenCalledWith({ type: "toggle_layer", layerId: "osm-trails" });
    expect(screen.getByRole("button", { name: "Show OSM trails" }).textContent).toBe("Show");
    // No unlabeled box: the old square visibility toggle is gone.
    expect(document.querySelector(".legend-check")).toBeNull();
  });

  it("changes opacity through dispatch", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const card = screen.getAllByTestId("layer-card")[0];
    const slider = within(card).getByRole("slider", { name: "Opacity for OSM trails" }) as HTMLInputElement;
    // A labelled row with the value inline, never a tooltip.
    expect(slider.closest("[title]")).toBeNull();
    expect(slider.parentElement?.textContent).toBe("Opacity for OSM trails100%");
    fireEvent.change(slider, { target: { value: "0.35" } });
    expect(spy).toHaveBeenCalledWith({ type: "set_opacity", layerId: "osm-trails", opacity: 0.35 });
    expect(slider.value).toBe("0.35");
    expect(slider.getAttribute("aria-valuetext")).toBe("35%");
    expect(slider.parentElement?.textContent).toContain("35%");
  });

  it("gives the opacity slider a visible keyboard focus ring on its thumb", () => {
    render(<Harness spy={vi.fn()} />);
    const slider = within(screen.getAllByTestId("layer-card")[0]).getByRole("slider");
    expect(slider.classList.contains("layer-opacity")).toBe(true);
    const css = readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
    for (const thumb of ["::-webkit-slider-thumb", "::-moz-range-thumb"]) {
      const rule = css.match(new RegExp(`\\.layer-opacity:focus-visible${thumb} \\{([^}]*)\\}`));
      expect(rule?.[1]).toMatch(/box-shadow:[\s\S]*var\(--slate\)/);
    }
  });

  it("gives point layers a Show as section: four equal segments (Points · Clusters · Heat · Hex), a select for narrow panels", () => {
    const species: LoadedLayer = {
      ...trails,
      id: "species",
      title: "Wildlife sightings",
      style: { geometry: "point", color: DARK_GREY, cluster: true, heat: true, extrude: "count" },
      result: { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation },
    };
    const spy = vi.fn();
    function Points() {
      const [state, dispatch] = useReducer(reduce, {
        ...initialMapState,
        layers: { species },
        renderOps: [{ layerId: "species", mode: "points", visible: true }],
      });
      return (
        <LayerStack
          layers={state.layers}
          renderOps={state.renderOps}
          catalog={null}
          dispatch={(a) => {
            spy(a);
            dispatch(a);
          }}
          open
          onOpenChange={() => {}}
        />
      );
    }
    render(<Points />);
    const card = screen.getAllByTestId("layer-card")[0];
    expect(card.textContent).toContain("Show as");
    const control = within(card).getByTestId("mode-control");
    expect(control.className).toBe("mode-segments");
    const buttons = within(control).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Points", "Clusters", "Heat", "Hex"]);
    expect(control.querySelector("svg, img")).toBeNull();
    expect(within(control).getByRole("button", { name: "Points" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(control).getByRole("button", { name: "Clusters" }));
    expect(spy).toHaveBeenCalledWith({ type: "set_style", layerId: "species", mode: "clusters" });
    expect(within(control).getByRole("button", { name: "Clusters" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(control).getByRole("button", { name: "Hex" }));
    expect(spy).toHaveBeenLastCalledWith({ type: "set_style", layerId: "species", mode: "columns" });
    // Pressing the pressed segment dispatches nothing.
    fireEvent.click(within(control).getByRole("button", { name: "Hex" }));
    expect(spy).toHaveBeenCalledTimes(2);
    // The same four as a native select (shown by the panel's container query under 280px).
    const select = within(within(card).getByTestId("mode-select")).getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Points", "Clusters", "Heat", "Hex"]);
    expect(select.value).toBe("columns");
    fireEvent.change(select, { target: { value: "heat" } });
    expect(spy).toHaveBeenLastCalledWith({ type: "set_style", layerId: "species", mode: "heat" });
  });

  it("renders a legend row: key, title, count, and no color picker", () => {
    render(<Harness spy={vi.fn()} />);
    const stack = screen.getByTestId("layer-stack");
    expect(within(stack).getByText("Layers")).toBeTruthy();
    // The time scrubber's slot sits at the top, empty until Task 7 mounts it.
    const slot = stack.querySelector('[data-slot="time-scrubber"]');
    expect(slot).toBeTruthy();
    expect(stack.firstElementChild).toBe(slot);
    expect(slot?.childElementCount).toBe(0);

    const [trailsRow, landsRow] = screen.getAllByTestId("layer-card");
    // Trails draw as TRAIL_LINE (T1): a white casing, a sage core and dark grey 8px dashes.
    const trailsKey = trailsRow.querySelector("svg.legend-key")!;
    expect(trailsKey.getAttribute("data-kind")).toBe("line");
    expect([...trailsKey.querySelectorAll("line")].map((l) => l.getAttribute("stroke"))).toEqual(["#FFFFFF", "#9FB693", "#3A3A3C"]);
    expect(trailsKey.querySelector("line[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toBe("8 8");
    // Public lands are vector tile areas, which Mapbox draws as protected land: a sage tint under a sage hatch.
    const landsKey = landsRow.querySelector("svg.legend-key")!;
    expect(landsKey.getAttribute("data-kind")).toBe("area");
    expect(landsKey.querySelector("rect")?.getAttribute("fill")).toBe("#9FB693");
    expect(landsKey.querySelector("rect")?.getAttribute("fill-opacity")).toBe("0.12");
    expect(landsKey.querySelector("pattern line")?.getAttribute("stroke")).toBe("#9FB693");
    // Every control shows: no hover-collapsing track, and no tooltips on the row's own controls.
    expect(trailsRow.querySelector(".legend-controls")).toBeNull();
    expect(trailsRow.querySelector("[title]:not(.info-mark)")).toBeNull();

    // No color popover and no inline colors; keys draw in palette colors only.
    expect(screen.queryByRole("button", { name: /Color for/ })).toBeNull();
    expect(stack.querySelector("[style*='background-color']")).toBeNull();
    for (const el of stack.querySelectorAll("svg *")) {
      for (const attr of ["fill", "stroke"]) {
        const value = el.getAttribute(attr);
        if (value) expect(["currentColor", "none"].includes(value) || value.startsWith("url(#") || PALETTE.has(value)).toBe(true);
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
    expect(campRow.querySelector("image")?.getAttribute("href")).toBe(
      pinIconFor("campsites", { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} }).url,
    );
    // Hidden layers say so on the row (the key fades) and in the text toggle.
    expect(campRow.getAttribute("data-hidden")).toBe("true");
    expect(within(campRow).getByRole("button", { name: "Show Campsites" }).textContent).toBe("Show");
    expect(roadRow.querySelector("line[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toBe("10 7.5");
    expect(lightsRow.querySelector("svg.legend-key")?.getAttribute("data-kind")).toBe("tiles");
    expect(lightsRow.querySelector("pattern")).toBeTruthy();
    expect(within(lightsRow).getByText("tiles")).toBeTruthy();
  });

  it("keys protected land (wilderness) as a sage tint and hatch under a dark grey outline", () => {
    const wild: LoadedLayer = { ...trails, id: "wilderness", title: "Wilderness", style: { geometry: "polygon", color: "#B9A6FF" } };
    render(
      <LayerStack
        layers={{ wilderness: wild }}
        renderOps={[{ layerId: "wilderness", mode: "polygons", visible: true }]}
        catalog={null}
        dispatch={() => {}}
        open
        onOpenChange={() => {}}
      />,
    );
    const rects = [...screen.getByTestId("layer-card").querySelectorAll("svg.legend-key rect")];
    expect(rects[0].getAttribute("fill")).toBe("#9FB693");
    expect(rects[1].getAttribute("fill")).toMatch(/^url\(#hatch-/);
    expect(rects.at(-1)?.getAttribute("stroke")).toBe("#3A3A3C");
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

describe("LayerStack data console", () => {
  const fires: LoadedLayer = {
    ...trails,
    id: "fire-perimeters",
    title: "Fire perimeters",
    style: { geometry: "polygon", color: "#000000" },
    result: {
      kind: "geojson",
      citation,
      data: {
        type: "FeatureCollection",
        features: Array.from({ length: 12 }, (_, k) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [0, 0] },
          properties: { t: `${2014 + k}-07-01T00:00:00.000Z` },
        })),
      },
    },
  };

  /** The panel as App mounts it: the scrubber from `state.time`, counts from the visible view. */
  function Console() {
    const [state, dispatch] = useReducer(reduce, reduce(initialMapState, { type: "layer_loaded", layer: fires }));
    return (
      <LayerStack
        layers={state.layers}
        renderOps={state.renderOps}
        catalog={null}
        dispatch={dispatch}
        open
        onOpenChange={() => {}}
        time={state.time}
        shownLayers={visibleState(state).layers}
      />
    );
  }

  it("docks the time scrubber in the top slot, above the layers label", () => {
    render(<Console />);
    const slot = document.querySelector('[data-slot="time-scrubber"]');
    expect(slot?.querySelector('[data-testid="time-scrubber"]')).toBeTruthy();
    // The compare slot (empty here, so hidden) sits between the scrubber and the layers.
    expect(slot?.nextElementSibling?.getAttribute("data-slot")).toBe("compare");
    expect(slot?.nextElementSibling?.nextElementSibling?.textContent).toContain("Layers");
  });

  it("shows \"1 of 12\" once the window narrows a layer", () => {
    render(<Console />);
    expect(screen.getByTestId("layer-count").textContent).toBe("12");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Window start" }), { key: "End" });
    expect(screen.getByTestId("layer-count").textContent).toBe("1 of 12");
  });
});

describe("LayerStack filters", () => {
  const scales = ["hiking", "mountain_hiking", "alpine_hiking", "hiking"];
  const rich: LoadedLayer = {
    ...trails,
    result: {
      kind: "geojson",
      citation,
      data: {
        type: "FeatureCollection",
        features: Array.from({ length: 8 }, (_, k) => ({
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: [[0, 0], [1, 1]] },
          properties: { name: `T${k}`, sac_scale: scales[k % 4], length_km: k + 1 },
        })),
      },
    },
  };

  function Filtered({ spy }: { spy: (a: MapAction) => void }) {
    const [state, dispatch] = useReducer(reduce, {
      ...initialMapState,
      layers: { "osm-trails": rich },
      renderOps: [{ layerId: "osm-trails", mode: "lines", visible: true }],
    } satisfies MapState);
    return (
      <LayerStack
        layers={state.layers}
        renderOps={state.renderOps}
        catalog={null}
        dispatch={(a) => {
          spy(a);
          dispatch(a);
        }}
        open
        onOpenChange={() => {}}
        shownLayers={visibleState(state).layers}
      />
    );
  }

  it("opens More filters (no attributes on this layer) with category chips (with counts) and a mini histogram per number, no sliders", () => {
    render(<Filtered spy={() => {}} />);
    const toggle = screen.getByRole("button", { name: "More filters" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const panel = screen.getByTestId("layer-filters");
    const chips = within(within(panel).getByRole("group", { name: "Difficulty (sac_scale)" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["All", "hiking 4", "alpine hiking 2", "mountain hiking 2"]);
    expect(within(panel).getByTestId("measure-histogram").getAttribute("data-key")).toBe("length_km");
    expect(within(panel).queryByRole("slider")).toBeNull();
  });

  it("a chip dispatches set_filters, the count reads \"2 of 8\" and the summary shows; Reset clears", () => {
    const spy = vi.fn();
    render(<Filtered spy={spy} />);
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(screen.getByRole("button", { name: /^alpine hiking/ }));
    expect(spy).toHaveBeenCalledWith({
      type: "set_filters",
      layerId: "osm-trails",
      filters: { sac_scale: { include: ["alpine_hiking"] } },
    });
    expect(screen.getByTestId("layer-count").textContent).toBe("2 of 8");
    expect(screen.getByTestId("filter-summary").textContent).toBe("Filtered: Difficulty (sac_scale): alpine_hiking");
    expect(screen.getByRole("button", { name: /^Fewer filters/ }).textContent).toBe("Fewer filters (1 active)");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(spy).toHaveBeenLastCalledWith({ type: "set_filters", layerId: "osm-trails", filters: {} });
    expect(screen.getByTestId("layer-count").textContent).toBe("8");
    expect(screen.queryByTestId("filter-summary")).toBeNull();
  });

  it("a histogram bar narrows by number (its band), and All clears the chips", () => {
    const spy = vi.fn();
    render(<Filtered spy={spy} />);
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    const bars = within(screen.getByRole("group", { name: "Length km: pick a band" })).getAllByRole("button");
    expect(bars).toHaveLength(12);
    fireEvent.click(bars[11]);
    const range = (spy.mock.lastCall?.[0] as Extract<MapAction, { type: "set_filters" }>).filters.length_km?.range;
    expect(range?.[1]).toBe(8);
    expect(range?.[0]).toBeGreaterThan(7);
    expect(bars[11].getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("layer-count").textContent).toBe("1 of 8");
    // A bar further down grows the band to reach it.
    fireEvent.click(bars[6]);
    expect(screen.getByTestId("layer-count").textContent).toBe("4 of 8");
    fireEvent.click(screen.getByRole("button", { name: /^hiking/ }));
    expect(screen.getByTestId("layer-count").textContent).toBe("2 of 8");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByTestId("layer-count").textContent).toBe("4 of 8");
  });
});

describe("layerLegend (what the map draws, for the panel and the inspect card)", () => {
  const nightLights: LoadedLayer = {
    ...lands,
    id: "night-lights",
    style: { geometry: "polygon", color: "#3A3A3C" },
    result: { kind: "tiles", data: { url: "https://example.test/{z}/{x}/{y}.png", minzoom: 0, maxzoom: 8, format: "raster" }, citation },
  };
  const fires: LoadedLayer = { ...trails, id: "fire-perimeters", style: { geometry: "polygon", color: "#F57272" } };
  const big: GeoJSON.Feature = { type: "Feature", geometry: null as never, properties: { acres: 200_000 } };

  it("keys a fire perimeter as pink tint and hatch at its own density", () => {
    const op = { layerId: "fire-perimeters", mode: "polygons" as const, visible: true };
    expect(layerLegend(fires, op)).toMatchObject({ kind: "area", tint: PINK, hatch: PINK, outline: PINK });
    expect(layerLegend(fires, op, big)).toMatchObject({ spacing: 3 });
    expect(layerLegend(fires, op, big, PURPLE)).toMatchObject({ tint: PURPLE });
  });

  it("keys points by their sprite, and dense point layers by the hex tile ramp", () => {
    const species: LoadedLayer = { ...trails, id: "species", style: { geometry: "point", color: "#3A3A3C" } };
    expect(layerLegend(species, { layerId: "species", mode: "points", visible: true }).kind).toBe("symbol");
    const many: LoadedLayer = {
      ...species,
      result: {
        ...species.result,
        data: {
          type: "FeatureCollection",
          features: Array.from({ length: 2001 }, () => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [0, 0] }, properties: {} })),
        },
      } as LoadedLayer["result"],
    };
    expect(layerLegend(many, { layerId: "species", mode: "points", visible: true }).kind).toBe("ramp");
  });

  it("keys a line layer of only routes (or one filtered down to routes) with the Wally gradient", () => {
    const line = (kind: string, route?: boolean): GeoJSON.Feature => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      properties: { kind, ...(route && { route }) },
    });
    const ski = (features: GeoJSON.Feature[]): LoadedLayer => ({
      ...trails,
      id: "ski-routes",
      style: { geometry: "line", color: "#3A3A3C" },
      result: { ...trails.result, data: { type: "FeatureCollection", features } } as LoadedLayer["result"],
    });
    const op = { layerId: "ski-routes", mode: "lines" as const, visible: true };
    expect(layerLegend(ski([line("nordic", true), line("route", true)]), op)).toMatchObject({ kind: "gradient" });
    // A mix keeps the key of its plain segments; a filter down to the routes brings the gradient.
    const mixed = ski([line("nordic"), line("nordic", true)]);
    expect(layerLegend(mixed, op)).toMatchObject({ kind: "line", color: SAGE });
    expect(layerLegend(mixed, { ...op, filters: { route: { include: ["true"] } } })).toMatchObject({ kind: "gradient" });
    expect(layerLegend(mixed, op, line("nordic", true))).toMatchObject({ kind: "gradient" });
    expect(layerLegend(mixed, op, line("nordic", true), PINK)).toMatchObject({ kind: "line", color: PINK });
    expect(layerLegend(ski([]), op)).toMatchObject({ kind: "line" });
  });

  it("keys raster tiles as a dark grey hatch", () => {
    expect(layerLegend(nightLights, { layerId: "night-lights", mode: "polygons", visible: true })).toEqual({ kind: "tiles", color: DARK_GREY });
  });

  it("keys vector tile areas (public lands) as sage protected land", () => {
    expect(layerLegend(lands, undefined)).toMatchObject({ kind: "area", tint: SAGE });
  });

  it("docks the compare slot under the time scrubber, above the layers", () => {
    render(
      <LayerStack
        layers={start.layers}
        renderOps={start.renderOps}
        catalog={null}
        dispatch={() => {}}
        open
        onOpenChange={() => {}}
        compareSlot={<p data-testid="compare-slot-content">compare</p>}
      />,
    );
    const panel = screen.getByTestId("layer-stack");
    const slots = Array.from(panel.querySelectorAll("[data-slot]")).map((el) => el.getAttribute("data-slot"));
    expect(slots).toEqual(["time-scrubber", "compare"]);
    const content = screen.getByTestId("compare-slot-content");
    const header = within(panel).getByRole("heading", { name: /Layers/ });
    expect(content.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("scrolls as one column on phones (scrubber, compare and layers together)", () => {
    render(<LayerStack layers={start.layers} renderOps={start.renderOps} catalog={null} dispatch={() => {}} open onOpenChange={() => {}} />);
    const panel = screen.getByTestId("layer-stack");
    expect(panel.className).toContain("max-md:overflow-y-auto");
    // On phones the list grows with its rows instead of scrolling inside a squeezed box.
    const list = panel.querySelector("ul.legend-table");
    expect(list?.className).toContain("max-md:overflow-visible");
    expect(list?.className).toContain("max-md:shrink-0");
  });
});

describe("LayerStack: closing layers and the measure threshold (owner feedback)", () => {
  const fireCitation = { source: "NIFC", url: "https://data-nifc.opendata.arcgis.com", retrieved: "2026-10-09" };
  const acres = [50, 120, 900, 4_000, 12_000, 60_000, 380_000];
  const fires: LoadedLayer = {
    id: "fire-perimeters",
    title: "Wildfire perimeters",
    style: { geometry: "polygon", color: PINK, unit: "acres" },
    result: {
      kind: "geojson",
      data: {
        type: "FeatureCollection",
        features: acres.map((v, i) => ({
          type: "Feature" as const,
          geometry: { type: "Polygon" as const, coordinates: [[[i, 0], [i + 0.5, 0], [i + 0.5, 0.5], [i, 0]]] },
          properties: { name: `Fire ${i}`, v, acres: v },
        })),
      },
      citation: fireCitation,
    },
    receivedAt: "2026-10-09T00:00:00Z",
  };

  function Panel({ spy, layers }: { spy: (a: MapAction) => void; layers: LoadedLayer[] }) {
    const [state, dispatch] = useReducer(reduce, {
      ...initialMapState,
      layers: Object.fromEntries(layers.map((l) => [l.id, l])),
      renderOps: layers.map((l) => ({ layerId: l.id, mode: l.style.geometry === "polygon" ? ("polygons" as const) : ("lines" as const), visible: true })),
    } satisfies MapState);
    return (
      <LayerStack
        layers={state.layers}
        renderOps={state.renderOps}
        catalog={null}
        dispatch={(a) => {
          spy(a);
          dispatch(a);
        }}
        open
        onOpenChange={() => {}}
        shownLayers={visibleState(state).layers}
      />
    );
  }

  it("shows a remove × on every row", () => {
    const spy = vi.fn();
    render(<Panel spy={spy} layers={[fires, trails]} />);
    for (const title of ["Wildfire perimeters", "OSM trails"]) {
      const remove = screen.getByRole("button", { name: `Remove ${title}` });
      expect(remove.textContent).toBe("×");
      // A 28px+ hit area from an invisible ::after 8px past the glyph, without growing the ×.
      expect(remove.className).toContain("after:-inset-2");
      expect(remove.className).toContain("text-[15px]");
    }
    fireEvent.click(screen.getByRole("button", { name: "Remove OSM trails" }));
    expect(spy).toHaveBeenCalledWith({ type: "remove_layer", layerId: "osm-trails" });
    expect(screen.getAllByTestId("layer-card")).toHaveLength(1);
  });

  it("has no generic Value slider: a measure ranks (Rank by, top 10) and its presets filter under More; opacity stays (owner, Moab)", () => {
    const spy = vi.fn();
    const sized: LoadedLayer = {
      ...fires,
      attributes: [{ key: "acres", label: "Burned area", type: "measure", unit: "acres", encode: "size", presets: [{ label: "Class G: 5,000 acres and up", min: 5_000 }] }],
    };
    render(<Panel spy={spy} layers={[sized, trails]} />);
    const card = screen.getAllByTestId("layer-card").find((c) => c.getAttribute("data-layer-id") === "fire-perimeters")!;
    expect(within(card).queryByTestId("measure-slider")).toBeNull();
    expect(card.textContent).not.toMatch(/Value ≥/);
    const controls = within(card).getByTestId("attribute-controls");
    // Rank by is visible and defaults to the layer's measure, listing the top features by it, largest first; None clears it.
    const rankBy = within(controls).getByLabelText("Rank by") as HTMLSelectElement;
    expect(rankBy.value).toBe("acres");
    expect([...rankBy.options].map((o) => o.textContent)).toEqual(["None", "Burned area"]);
    fireEvent.change(rankBy, { target: { value: "" } });
    expect(spy).toHaveBeenLastCalledWith({ type: "set_rank_by", layerId: "fire-perimeters", key: "" });
    expect(within(controls).queryByTestId("top-list")).toBeNull();
    fireEvent.change(rankBy, { target: { value: "acres" } });
    expect(spy).toHaveBeenLastCalledWith({ type: "set_rank_by", layerId: "fire-perimeters", key: "acres" });
    const top = within(controls).getByTestId("top-list");
    expect(within(top).getAllByRole("button")[0].textContent).toBe("1Fire 6380,000 acres");
    fireEvent.mouseEnter(within(top).getAllByRole("button")[0]);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ type: "set_hover", hover: { layerId: "fire-perimeters" } });
    fireEvent.click(within(top).getAllByRole("button")[1]);
    expect(spy.mock.lastCall?.[0]).toMatchObject({ type: "fly_to", select: { layerId: "fire-perimeters" } });
    // The preset is under More, in the source's words; no two-handle slider.
    fireEvent.click(within(controls).getByRole("button", { name: "More filters" }));
    expect(within(controls).queryByRole("slider")).toBeNull();
    fireEvent.click(within(controls).getByRole("button", { name: /^Class G/ }));
    const last = spy.mock.calls.at(-1)?.[0] as MapAction & { type: "set_filters" };
    expect(last).toMatchObject({ type: "set_filters", layerId: "fire-perimeters", filters: { acres: { range: [5_000, 380_000] } } });
    expect(within(card).getByTestId("layer-count").textContent).toBe("3 of 7");
    expect(within(card).getByTestId("filter-summary").textContent).toBe("Filtered: Class G: 5,000 acres and up");
    // Opacity: a labelled row on every layer.
    const opacity = within(card).getByRole("slider", { name: "Opacity for Wildfire perimeters" });
    fireEvent.change(opacity, { target: { value: "0.5" } });
    expect(spy).toHaveBeenLastCalledWith({ type: "set_opacity", layerId: "fire-perimeters", opacity: 0.5 });
  });
});
