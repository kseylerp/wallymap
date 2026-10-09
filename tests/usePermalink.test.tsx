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
});
