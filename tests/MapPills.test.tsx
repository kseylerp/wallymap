// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapPills } from "@/components/MapPills";

afterEach(cleanup);

describe("MapPills", () => {
  it("renders the wordmark, basemap switch and layers toggle, and no Export (it is in the Layers console)", () => {
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
    expect(screen.getByRole("button", { name: "Reset map" }).textContent).toBe("");
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

    // Export moved off the top bar to the foot of the Layers console (components/ExportControl.tsx).
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
  });

  it("labels Layers in text, with no icons; only the logo pill draws", () => {
    render(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={3} onLayersOpenChange={() => {}} />);
    const layers = screen.getByRole("button", { name: "Layers, 3 loaded" });
    expect(layers.textContent).toBe("Layers·3");
    expect(layers.querySelector("svg")).toBeNull();
    // The Wally logo is the one drawing among the pills.
    const svgs = Array.from(screen.getByTestId("map-pills").querySelectorAll("svg"));
    expect(svgs.every((svg) => screen.getByRole("button", { name: "Reset map" }).contains(svg))).toBe(true);
  });

  it("makes the logo a Reset map button that calls the handler", () => {
    const onResetMap = vi.fn();
    render(<MapPills basemap="outdoors" onBasemapChange={() => {}} onResetMap={onResetMap} />);
    const logo = screen.getByRole("button", { name: "Reset map" });
    expect(logo.tagName).toBe("BUTTON");
    expect(logo.getAttribute("type")).toBe("button");
    expect(logo.getAttribute("title")).toBe("Reset map");
    expect(logo.textContent).toBe("");
    expect(logo.querySelector('[data-testid="wally-mark"]')).toBeTruthy();
    fireEvent.click(logo);
    expect(onResetMap).toHaveBeenCalledTimes(1);
  });

  it("has a hidden page heading", () => {
    render(<MapPills basemap="outdoors" onBasemapChange={() => {}} layerCount={1} />);
    expect(screen.getByRole("heading", { level: 1, name: "WallyMap" }).className).toContain("sr-only");
  });

  it("shows the restore status after the pills", () => {
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
