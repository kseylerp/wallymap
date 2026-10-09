// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeState } from "@/lib/render/permalink";
import { usePermalink } from "@/lib/render/usePermalink";
import { initialMapState, type MapState } from "@/lib/render/state";

const trails = {
  kind: "geojson",
  data: { type: "FeatureCollection", features: [] },
  citation: { source: "OSM", url: "https://osm.org", retrieved: "2026-10-09T00:00:00Z" },
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/layers"
        ? Response.json([{ id: "osm-trails", title: "Trails", style: { geometry: "line", color: "#000" } }])
        : Response.json(trails),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("usePermalink", () => {
  it("restores the camera and layers from the hash, with a status while layers load", async () => {
    window.history.replaceState(null, "", "/#v=-120.1,39.2,11,45,0&b=outdoors&l=osm-trails:lines:1");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/layers") return Response.json([{ id: "osm-trails", title: "Trails", style: { geometry: "line", color: "#000" } }]);
        await gate;
        return Response.json(trails);
      }),
    );
    const dispatch = vi.fn();
    const { result } = renderHook(() => usePermalink(initialMapState, dispatch));
    await waitFor(() => expect(result.current.status).toBe("Restoring 1 layer…"));
    release();
    await waitFor(() => expect(result.current.status).toBeNull());
    expect(dispatch.mock.calls.map(([a]) => a.type)).toEqual(["set_basemap", "set_view", "layer_loaded", "render"]);
    expect(dispatch.mock.calls[0][0]).toEqual({ type: "set_basemap", basemap: "outdoors" });
    expect(fetch).toHaveBeenCalledWith("/api/layer/osm-trails", expect.objectContaining({ method: "POST" }));
  });

  it("writes the hash 500 ms after the state settles, and leaves a fresh page's URL alone", async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ state }) => usePermalink(state, vi.fn()), { initialProps: { state: initialMapState } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(window.location.hash).toBe("");

    const moved: MapState = { ...initialMapState, viewport: { ...initialMapState.viewport, longitude: -120, latitude: 39, zoom: 9 } };
    rerender({ state: moved });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(window.location.hash).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(window.location.hash).toBe(encodeState({ ...moved, renderOps: [] }));
  });

  it("applies a share link pasted into the same tab (hash change), replacing the layers", async () => {
    const dispatch = vi.fn();
    renderHook(() => usePermalink(initialMapState, dispatch));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/layers"));
    expect(dispatch).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/#v=-120.1,39.2,11,45,0&b=outdoors&l=osm-trails:lines:1");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(dispatch.mock.calls.map(([a]) => a.type)).toEqual(["clear_layers", "set_basemap", "set_view", "layer_loaded", "render"]));
  });

  it("ignores a hash change to something that is not a share link", async () => {
    const dispatch = vi.fn();
    renderHook(() => usePermalink(initialMapState, dispatch));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/layers"));
    window.history.replaceState(null, "", "/#about");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops an older restore's layers when a newer link is pasted while it is still loading", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/layers") return Response.json([{ id: "osm-trails", title: "Trails", style: { geometry: "line", color: "#000" } }]);
        if (url === "/api/layer/osm-trails") await gate;
        return Response.json(trails);
      }),
    );
    const dispatch = vi.fn();
    const { result } = renderHook(() => usePermalink(initialMapState, dispatch));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/layers"));
    window.history.replaceState(null, "", "/#v=-120.1,39.2,11,45,0&b=outdoors&l=osm-trails:lines:1");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/layer/osm-trails", expect.anything()));
    window.history.replaceState(null, "", "/#v=-111.5,38.6,10,45,0&b=outdoors&l=campsites:points:1");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(result.current.status).toBeNull());
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const loaded = dispatch.mock.calls.filter(([a]) => a.type === "layer_loaded").map(([a]) => a.layer.id);
    expect(loaded).toEqual(["campsites"]);
  });
});
