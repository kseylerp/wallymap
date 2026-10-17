// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportControl } from "@/components/ExportControl";
import * as exportView from "@/lib/export/exportView";
import { initialMapState, type LoadedLayer, type MapState } from "@/lib/render/state";

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
});
