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
    // Trails draw as TRAIL_LINE: a white casing, a sage core and dark grey 8px dashes.
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
    // The row controls keep their padding inside the collapsing track, so a collapsed row has no dead space.
    const track = trailsRow.querySelector(".legend-controls")!;
    expect(track.firstElementChild?.className).toBe("");
    expect(track.querySelector(".pt-2")).toBeTruthy();

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
    // Hidden layers say so on the row (the key fades) and in the visibility box.
    expect(campRow.getAttribute("data-hidden")).toBe("true");
    expect(within(campRow).getByRole("button", { name: "Show Campsites" }).getAttribute("aria-pressed")).toBe("false");
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

  it("shows shown / total once the window narrows a layer", () => {
    render(<Console />);
    expect(screen.getByTestId("layer-count").textContent).toBe("12");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Window start" }), { key: "End" });
    expect(screen.getByTestId("layer-count").textContent).toBe("1 / 12");
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

  it("opens a Filters disclosure with category chips (with counts) and a range per numeric field", () => {
    render(<Filtered spy={() => {}} />);
    const toggle = screen.getByRole("button", { name: "Filters" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const panel = screen.getByTestId("layer-filters");
    const chips = within(within(panel).getByRole("group", { name: "Difficulty (sac_scale)" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["all", "hiking 4", "alpine hiking 2", "mountain hiking 2"]);
    expect(within(panel).getByRole("slider", { name: "Length km from" })).toBeTruthy();
  });

  it("a chip dispatches set_filters, the count becomes shown / total and the summary shows; Reset clears", () => {
    const spy = vi.fn();
    render(<Filtered spy={spy} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: /^alpine hiking/ }));
    expect(spy).toHaveBeenCalledWith({
      type: "set_filters",
      layerId: "osm-trails",
      filters: { sac_scale: { include: ["alpine_hiking"] } },
    });
    expect(screen.getByTestId("layer-count").textContent).toBe("2 / 8");
    expect(screen.getByTestId("filter-summary").textContent).toBe("Filtered: sac_scale: alpine_hiking");
    expect(screen.getByRole("button", { name: /^Filters/ }).textContent).toBe("Filters · 1");

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(spy).toHaveBeenLastCalledWith({ type: "set_filters", layerId: "osm-trails", filters: {} });
    expect(screen.getByTestId("layer-count").textContent).toBe("8");
    expect(screen.queryByTestId("filter-summary")).toBeNull();
  });

  it("the range's lower thumb narrows by number, and all clears the chips", () => {
    const spy = vi.fn();
    render(<Filtered spy={spy} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByRole("slider", { name: "Length km from" }), { target: { value: "6" } });
    expect(spy).toHaveBeenLastCalledWith({ type: "set_filters", layerId: "osm-trails", filters: { length_km: { range: [6, 8] } } });
    expect(screen.getByTestId("layer-count").textContent).toBe("3 / 8");
    fireEvent.click(screen.getByRole("button", { name: /^hiking/ }));
    expect(screen.getByTestId("layer-count").textContent).toBe("1 / 8");
    fireEvent.click(screen.getByRole("button", { name: "all" }));
    expect(screen.getByTestId("layer-count").textContent).toBe("3 / 8");
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
