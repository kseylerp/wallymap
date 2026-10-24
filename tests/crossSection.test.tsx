// @vitest-environment node
/**
 * The cross-section chart (components/CrossSection.tsx) under the map for an elevation-profile answer: the start and the
 * top labelled with their elevations, the steepest stretch in pink with its angle and grade, the vertical exaggeration
 * stated, and nothing when no cross-section is drawn.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Feature } from "geojson";
import { CrossSection } from "@/components/CrossSection";
import { crossSectionOnMap, profileOfFeature } from "@/lib/render/crossSection";
import { profileCursorLayers } from "@/lib/render/deck";
import { initialMapState, type MapState } from "@/lib/render/state";
import { getLayer } from "@/layers";

/** Yosemite Valley to Half Dome, shortened: a flat floor, then the face. */
const distancesM = Array.from({ length: 54 }, (_, i) => i * 100);
const elevationsM = distancesM.map((d) => (d < 4000 ? 1209 : 1209 + (d - 4000) * 1.14));
const feature: Feature = {
  type: "Feature",
  geometry: { type: "LineString", coordinates: [[-119.5934, 37.7456], [-119.5332, 37.7459]] },
  properties: {
    name: "Yosemite Valley to Half Dome",
    startName: "Yosemite Valley",
    endName: "Half Dome",
    highestAtM: 5300,
    steepestFromM: 5100,
    steepestToM: 5200,
    steepestGradePct: 114,
    steepestDeg: 49,
    profileDistancesM: distancesM,
    profileElevationsM: elevationsM,
  },
};

function stateWith(visible = true): MapState {
  const layer = getLayer("elevation-profile")!;
  return {
    ...initialMapState,
    layers: {
      "elevation-profile": {
        id: "elevation-profile",
        title: layer.title,
        style: layer.style,
        receivedAt: "2026-10-23T00:00:00Z",
        result: { kind: "geojson", data: { type: "FeatureCollection", features: [feature] }, citation: { source: "AWS", url: "https://registry.opendata.aws/terrain-tiles/", retrieved: "2026-10-23" } },
      },
    },
    renderOps: [{ layerId: "elevation-profile", mode: "lines", visible }],
  };
}

describe("cross-section chart", () => {
  it("reads the profile off the line drawn on the map, and nothing when it is hidden", () => {
    expect(crossSectionOnMap(stateWith())?.name).toBe("Yosemite Valley to Half Dome");
    expect(crossSectionOnMap(stateWith(false))).toBeNull();
    expect(crossSectionOnMap(initialMapState)).toBeNull();
    expect(profileOfFeature({ ...feature, properties: { name: "no profile" } })).toBeNull();
  });

  it("labels the start and the top, draws the steepest stretch in pink and states the exaggeration", () => {
    const view = crossSectionOnMap(stateWith())!;
    const html = renderToStaticMarkup(<CrossSection view={view} onClose={() => {}} />);
    expect(html).toContain("Yosemite Valley to Half Dome");
    expect(html).toContain("3,967 ft");
    expect(html).toMatch(/8,8\d\d ft Half Dome/);
    expect(html).toContain('data-testid="profile-highlight"');
    expect(html).toContain("49° · 114%");
    expect(html).toMatch(/×[\d.]+ vertical/);
    // No cursor until a pointer is over the chart.
    expect(html).not.toContain('data-testid="profile-readout"');
  });

  it("draws the chart's cursor on the map as one dot, and nothing without one", () => {
    expect(profileCursorLayers(null, false)).toEqual([]);
    expect(profileCursorLayers([-119.55, 37.74], false)).toHaveLength(1);
  });
});
