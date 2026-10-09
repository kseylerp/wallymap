// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapPills } from "@/components/MapPills";

afterEach(cleanup);

describe("MapPills", () => {
  it("renders the wordmark, basemap switch, layers toggle and the export placeholder", () => {
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
    expect(screen.getByText("WallyMap")).toBeTruthy();
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

    const exportPill = screen.getByRole("button", { name: "Export view" });
    expect(exportPill.getAttribute("aria-disabled")).toBe("true");
    expect(exportPill.getAttribute("title")).toBe("Milestone 3");
  });

  it("hides the layers toggle until a layer is loaded, and presses nothing for the agent-only basemap", () => {
    render(<MapPills basemap="natural-earth-2" onBasemapChange={() => {}} layerCount={0} onLayersOpenChange={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Layers/ })).toBeNull();
    const group = screen.getByRole("group", { name: "Basemap" });
    expect(group.querySelector('[aria-pressed="true"]')).toBeNull();
  });
});
