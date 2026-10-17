// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportControl } from "@/components/ExportControl";
import * as exportView from "@/lib/export/exportView";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";
import { captionOf } from "@/components/ExportControl";
import { recordingPlan, VIDEO_LIMITS } from "@/lib/export/capture";
import { reduce } from "@/lib/render/reducer";

afterEach(cleanup);

const trails: LoadedLayer = {
  id: "osm-trails",
  title: "OSM trails",
  style: { geometry: "line", color: "#2F3A44" },
  result: { kind: "geojson", data: { type: "FeatureCollection", features: [] }, citation: { source: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright", retrieved: "2026-10-17" } },
  receivedAt: "2026-10-17T00:00:00Z",
};
const withLayer = (visible: boolean): MapState => ({ ...initialMapState, layers: { "osm-trails": trails }, renderOps: [{ layerId: "osm-trails", mode: "lines", visible }] });

describe("ExportControl (the foot of the Layers console)", () => {
  it("shows Export map… only while a layer is on", () => {
    const { rerender } = render(<ExportControl mapState={initialMapState} />);
    expect(screen.queryByRole("button", { name: "Export map" })).toBeNull();
    rerender(<ExportControl mapState={withLayer(false)} />);
    expect(screen.queryByRole("button", { name: "Export map" })).toBeNull();
    rerender(<ExportControl mapState={withLayer(true)} />);
    const action = screen.getByRole("button", { name: "Export map" });
    expect(action.textContent).toBe("Export map…");
    expect(action.querySelector("svg")).toBeNull();
  });

  it("asks first, downloads only from the confirm, and drops an open confirm when no layer is on", async () => {
    const download = vi.spyOn(exportView, "downloadBundle").mockResolvedValue(["citations.md"]);
    const { rerender } = render(<ExportControl mapState={withLayer(true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Export map" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm export" });
    expect(dialog.textContent).toMatch(/Export \d+ files? \(\d+ (B|KB)\)\?/);
    expect(dialog.textContent).toContain("citations.md");
    expect(download).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Export map" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0][0].files.map((f) => f.name)).toContain("citations.md");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Export map" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    rerender(<ExportControl mapState={withLayer(false)} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<ExportControl mapState={withLayer(true)} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    download.mockRestore();
  });

  it("offers a still image always and a video only with a timeline, and saves neither without a second click", () => {
    const download = vi.spyOn(exportView, "clickDownload").mockImplementation(() => {});
    const { rerender } = render(<ExportControl mapState={withLayer(true)} dispatch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Export map" }));
    expect(screen.getByRole("button", { name: "Still image" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Video of this timeline" })).toBeNull();
    // No map to capture in this test: the still says so instead of saving anything.
    fireEvent.click(screen.getByRole("button", { name: "Still image" }));
    expect(screen.getByRole("dialog", { name: "Save export" }).textContent).toContain("not ready");
    expect(download).not.toHaveBeenCalled();
    const timeline = reduce(reduce(initialMapState, { type: "layer_loaded", layer: pulse }), { type: "render", op: { layerId: "river-pulse", mode: "lines", visible: true } });
    rerender(<ExportControl mapState={timeline} dispatch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Export map" }));
    expect(screen.getByRole("button", { name: "Video of this timeline" })).toBeTruthy();
    download.mockRestore();
  });

  it("plays a whole timeline inside 30 seconds and keeps the video under 25 MB", () => {
    for (const frames of [12, 99, 168, 400]) {
      const plan = recordingPlan(frames);
      expect(plan.seconds).toBeLessThanOrEqual(VIDEO_LIMITS.maxSeconds);
      expect((plan.bitsPerSecond / 8) * plan.seconds).toBeLessThan(VIDEO_LIMITS.maxBytes);
    }
  });

  it("captions the frame: the layer, the date, the total and what width and color mean", () => {
    const timeline = reduce(reduce(initialMapState, { type: "layer_loaded", layer: pulse }), { type: "render", op: { layerId: "river-pulse", mode: "lines", visible: true } });
    const caption = captionOf(timeline, 2);
    expect(caption.title).toBe("River pulse");
    expect(caption.date).toBe("Sat 3 Oct 2026");
    expect(caption.total).toBe("30 m³/s");
    expect(caption.legend.map((l) => l.word)).toEqual(["Width", "Color"]);
    expect(caption.source).toBe("e.org");
  });
});

const DAYS = ["2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z", "2026-10-04T00:00:00.000Z"];
const reach = (q: (number | null)[]): GeoJSON.Feature => ({ type: "Feature", geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] }, properties: { q: q[2], pct: 100, series: { q, pct: q.map(() => 100) } } });
const pulse: LoadedLayer = {
  id: "river-pulse",
  title: "River pulse (daily flow)",
  style: { geometry: "line", color: "#9FB693", encode: { size: "q", color: "pct" } },
  attributes: [
    { key: "q", type: "measure", label: "Flow", unit: "m³/s", aggregate: "max" },
    { key: "pct", type: "measure", label: "Flow vs. median", unit: "%" },
  ],
  result: {
    kind: "geojson",
    data: { type: "FeatureCollection", features: [reach([10, 20, 30, 40]), reach([5, 50, 6, 25])] },
    citation: { source: "s", url: "https://e.org/x", retrieved: "2026-10-03" },
    series: { times: DAYS, step: "day", now: 2 },
  },
  receivedAt: "2026-10-03",
};
