import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import layer, { normalizeGrazing, simplifyOffset } from "./grazing-allotments";
import allotmentsRaw from "./__fixtures__/grazing-allotments.allotments.json";
import hmaRaw from "./__fixtures__/grazing-allotments.hma.json";
import haRaw from "./__fixtures__/grazing-allotments.ha.json";

const allotments = allotmentsRaw as unknown as FeatureCollection;
const hma = hmaRaw as unknown as FeatureCollection;
const ha = haRaw as unknown as FeatureCollection;

const NEVADA: [number, number, number, number] = [-117, 39, -116, 40];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Routes by the service path in the request URL. */
function serviceStub(overrides: Partial<Record<"allotments" | "hma" | "ha", Response>> = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes("BLM_Natl_Grazing_Allotment/MapServer/12/")) return overrides.allotments ?? json(allotments);
    if (url.includes("BLM_Natl_WHB/MapServer/0/")) return overrides.hma ?? json(hma);
    if (url.includes("BLM_Natl_WHB/MapServer/1/")) return overrides.ha ?? json(ha);
    throw new Error(`unexpected url ${url}`);
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, cacheKey?: string) {
  return { bbox: NEVADA, zoom: 9, env: {}, fetch: stub as unknown as CachedFetch, cacheKey };
}

describe("grazing-allotments layer", () => {
  it("declares US coverage, the public domain license and the default input", () => {
    expect(layer.id).toBe("grazing-allotments");
    expect(layer.coverage).toBe("us");
    expect(layer.license).toBe("Public domain (Bureau of Land Management)");
    expect(layer.requiredEnv).toEqual([]);
    expect(layer.maxAreaKm2).toBe(150_000);
    expect(layer.input.parse({})).toEqual({ show: "both" });
    expect(layer.input.safeParse({ show: "cows" }).success).toBe(false);
    expect(layer.style).toMatchObject({ geometry: "polygon", fillOpacity: 0.18 });
  });

  it("normalizes allotments with kind, name, number, acres as v and state", () => {
    const features = normalizeGrazing(allotments, "allotment");
    expect(features).toHaveLength(allotments.features.length);
    const duckwater = features.find((f) => f.properties?.name === "DUCKWATER");
    expect(duckwater?.properties).toEqual({
      kind: "allotment",
      name: "DUCKWATER",
      allotmentNumber: "00701",
      acres: 849127,
      v: 849127,
      state: "NV",
    });
  });

  it("normalizes herd management areas and herd areas with animals, agency and acres", () => {
    const hmas = normalizeGrazing(hma, "herd-management-area");
    expect(hmas.find((f) => f.properties?.name === "Callaghan")?.properties).toEqual({
      kind: "herd-management-area",
      name: "Callaghan",
      herdId: "NV0604",
      animals: "horses",
      agency: "BLM",
      acres: 157148,
      v: 157148,
      state: "NV",
    });
    const has = normalizeGrazing(ha, "herd-area");
    expect(has.find((f) => f.properties?.name === "Antelope")?.properties).toMatchObject({
      kind: "herd-area",
      herdId: "NV0613",
      animals: "horses",
    });
  });

  it("omits unknown agency and animal values and tolerates missing fields", () => {
    const square = { type: "Polygon" as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const out = normalizeGrazing(
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: square, properties: { HMA_NAME: "Mystery", ADMIN_AGCY: "UNK", HERD_TYPE: "UNK" } },
          { type: "Feature", geometry: square, properties: { HMA_NAME: "Both", HERD_TYPE: "BOTH", BLM_ACRES: 10.4 } },
          { type: "Feature", geometry: null as never, properties: { HMA_NAME: "Ghost" } },
        ],
      },
      "herd-management-area",
    );
    expect(out).toHaveLength(2);
    expect(out[0].properties).toEqual({ kind: "herd-management-area", name: "Mystery" });
    expect(out[1].properties).toMatchObject({ animals: "horses and burros", acres: 10, v: 10 });
  });

  it("queries all three services in the west with the bbox and a one day cache, then merges them", async () => {
    const stub = serviceStub();
    const r = await layer.query(ctx(stub, "grazing-allotments:k"), { show: "both" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");

    const calls = stub.mock.calls as unknown as [string, RequestInit & { cacheKey?: string; ttlSeconds?: number }][];
    expect(calls).toHaveLength(3);
    for (const [url, init] of calls) {
      const u = new URL(url);
      expect(u.searchParams.get("geometry")).toBe(NEVADA.join(","));
      expect(u.searchParams.get("maxAllowableOffset")).toBe(String(simplifyOffset(NEVADA)));
      expect(init.ttlSeconds).toBe(86_400);
    }
    expect(calls.map(([, init]) => init.cacheKey).sort()).toEqual([
      "grazing-allotments:k:blm-allotments",
      "grazing-allotments:k:blm-ha",
      "grazing-allotments:k:blm-hma",
    ]);

    const kinds = new Map<string, number>();
    for (const f of r.data.features) kinds.set(f.properties?.kind, (kinds.get(f.properties?.kind) ?? 0) + 1);
    expect(kinds.get("allotment")).toBe(allotments.features.length);
    expect(kinds.get("herd-management-area")).toBe(hma.features.length);
    expect(kinds.get("herd-area")).toBe(ha.features.length);
    expect(r.coverageNote).toBeUndefined();
    expect(r.citation.source).toContain("Bureau of Land Management");
  });

  it("queries only the requested group", async () => {
    const onlyAllotments = serviceStub();
    await layer.query(ctx(onlyAllotments), { show: "allotments" });
    expect(onlyAllotments).toHaveBeenCalledTimes(1);

    const onlyHerds = serviceStub();
    await layer.query(ctx(onlyHerds), { show: "herds" });
    expect(onlyHerds).toHaveBeenCalledTimes(2);
  });

  it("keeps what loaded and notes what did not when one service fails", async () => {
    const stub = serviceStub({ ha: new Response("down", { status: 500 }) });
    const r = await layer.query(ctx(stub), { show: "both" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features.some((f) => f.properties?.kind === "allotment")).toBe(true);
    expect(r.data.features.some((f) => f.properties?.kind === "herd-area")).toBe(false);
    expect(r.coverageNote).toMatch(/Herd areas could not be loaded/);
  });

  it("returns an upstream error when every service fails, including an ArcGIS error body", async () => {
    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    expect(await layer.query(ctx(down), { show: "both" })).toMatchObject({ hint: "upstream" });

    const arcgisError = vi.fn(async () => json({ error: { code: 400, message: "Unable to complete operation." } }));
    expect(await layer.query(ctx(arcgisError), { show: "allotments" })).toMatchObject({
      hint: "upstream",
      error: expect.stringContaining("Unable to complete operation."),
    });
  });

  it("notes when a service capped its result", async () => {
    const stub = serviceStub({ allotments: json({ ...allotments, exceededTransferLimit: true }) });
    const r = await layer.query(ctx(stub), { show: "both" });
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.coverageNote).toMatch(/zoom in/i);
  });

  it("returns a coverage note without calling upstream outside the US", async () => {
    const stub = vi.fn();
    const r = await layer.query(
      { bbox: [2, 45, 3, 46], zoom: 9, env: {}, fetch: stub as unknown as CachedFetch },
      { show: "both" },
    );
    expect(stub).not.toHaveBeenCalled();
    if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
    expect(r.data.features).toEqual([]);
    expect(r.coverageNote).toMatch(/outside the United States/i);
  });

  it("is registered and rejects a huge area or bad input through runLayer", async () => {
    expect((await runLayer("grazing-allotments", { bbox: [-120, 30, -100, 45] })).status).toBe(422);
    expect((await runLayer("grazing-allotments", { bbox: NEVADA, input: { show: "x" } })).status).toBe(400);
  });

  it("describes grazing in the words people use", () => {
    for (const word of ["cattle", "wild horses", "burros", "grazing"]) expect(layer.description).toContain(word);
  });
});
