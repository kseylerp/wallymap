// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapPills } from "@/components/MapPills";
import * as exportView from "@/lib/export/exportView";
import { initialMapState } from "@/lib/render/state";

afterEach(cleanup);

describe("MapPills", () => {
  it("renders the wordmark, basemap switch, layers toggle and the export pill", () => {
    const onBasemapChange = vi.fn();
    const onLayersOpenChange = vi.fn();
    render(
      <MapPills
        basemap="outdoors-satellite"
        onBasemapChange={onBasemapChange}
        layerCount={2}
        layersOpen={false}
        onLayersOpenChange={onLayersOpenChange}
      />,
    );
    expect(screen.getByTestId("wally-mark")).toBeTruthy();
    expect(screen.getByRole("img", { name: "WallyMap" }).textContent).toBe("");
    expect(screen.queryByTestId("theme-toggle")).toBeNull();

    const hybrid = screen.getByRole("button", { name: "Topographical + Satellite" });
    expect(hybrid.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Satellite" }));
    expect(onBasemapChange).toHaveBeenCalledWith("satellite");
    // Text only, no icons; the short label is for phones.
    const topo = screen.getByRole("button", { name: "Topographical" });
    expect(topo.querySelector("svg")).toBeNull();
    expect(Array.from(topo.querySelectorAll("span")).map((s) => s.textContent)).toEqual(["Topo", "Topographical"]);
    fireEvent.click(topo);
    expect(onBasemapChange).toHaveBeenCalledWith("outdoors");

    const layers = screen.getByRole("button", { name: "Layers, 2 loaded" });
    expect(layers.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(layers);
    expect(onLayersOpenChange).toHaveBeenCalledWith(true);

    // Without map state to pack, Export stays off.
    expect(screen.getByRole("button", { name: "Export view" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("labels Layers and Export in text, with no icons; only the logo pill draws", () => {
    render(
      <MapPills
        basemap="outdoors"
        onBasemapChange={() => {}}
        layerCount={3}
        onLayersOpenChange={() => {}}
        mapState={initialMapState}
      />,
    );
    const layers = screen.getByRole("button", { name: "Layers, 3 loaded" });
    expect(layers.textContent).toBe("Layers·3");
    expect(layers.querySelector("svg")).toBeNull();
    const exportPill = screen.getByRole("button", { name: "Export view" });
    expect(exportPill.textContent).toBe("Export");
    expect(exportPill.querySelector("svg")).toBeNull();
    // The Wally logo is the one drawing among the pills.
    const svgs = Array.from(screen.getByTestId("map-pills").querySelectorAll("svg"));
    expect(svgs.every((svg) => screen.getByRole("img", { name: "WallyMap" }).contains(svg))).toBe(true);
  });

  it("keeps Export off until a layer is loaded, then downloads the bundle", async () => {
    const download = vi.spyOn(exportView, "downloadBundle").mockResolvedValue(["citations.md"]);
    const { rerender } = render(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={0} mapState={initialMapState} />);
    const off = screen.getByRole("button", { name: "Export view" });
    expect(off.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(off);
    expect(download).not.toHaveBeenCalled();

    rerender(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={1} mapState={initialMapState} />);
    const on = screen.getByRole("button", { name: "Export view" });
    expect(on.getAttribute("aria-disabled")).toBe("false");

    // The pill only asks; nothing downloads until the confirm's Export button is pressed.
    fireEvent.click(on);
    const dialog = screen.getByRole("dialog", { name: "Confirm export" });
    expect(dialog.textContent).toMatch(/Export 1 file \(\d+ B\)\?/);
    expect(dialog.textContent).toContain("citations.md");
    expect(download).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(download).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Export view" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const bundle = download.mock.calls[0][0];
    expect(bundle.files.map((f) => f.name)).toEqual(["citations.md"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    download.mockRestore();
  });

  it("has a hidden page heading, and drops an open confirm when the last layer goes", () => {
    const { rerender } = render(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={1} mapState={initialMapState} />);
    expect(screen.getByRole("heading", { level: 1, name: "WallyMap" }).className).toContain("sr-only");
    fireEvent.click(screen.getByRole("button", { name: "Export view" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    rerender(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={0} mapState={initialMapState} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={1} mapState={initialMapState} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the restore status next to Export", () => {
    render(<MapPills basemap="outdoors" onBasemapChange={() => {}} restoreStatus="Restoring 3 layers…" />);
    expect(screen.getByRole("status").textContent).toBe("Restoring 3 layers…");
  });

  it("hides the layers toggle until a layer is loaded, and presses nothing for the agent-only basemap", () => {
    render(<MapPills basemap="natural-earth-2" onBasemapChange={() => {}} layerCount={0} onLayersOpenChange={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Layers/ })).toBeNull();
    const group = screen.getByRole("group", { name: "Basemap" });
    expect(group.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it("shows a Compare pill only when given one, pressed while comparing", () => {
    const onCompare = vi.fn();
    const { rerender } = render(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={1} />);
    expect(screen.queryByTestId("compare-pill")).toBeNull();
    rerender(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={1} onCompare={onCompare} />);
    const pill = screen.getByTestId("compare-pill");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pill);
    expect(onCompare).toHaveBeenCalledTimes(1);
    rerender(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={1} onCompare={onCompare} comparing />);
    expect(screen.getByTestId("compare-pill").getAttribute("aria-pressed")).toBe("true");
  });
});
