import { describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { CachedFetch } from "@/lib/fetch";
import { runLayer } from "@/lib/layers/run";
import { contractProblems, labelsOf, legendOf, timeShapeOf } from "./contract";
import layer, { SERVICES, isoDay, normalizeLeases, plainWords, producingOf } from "./mineral-leases";
import oilGasRaw from "./__fixtures__/mineral-leases.oil-gas-chaco.json";
import mineralsRaw from "./__fixtures__/mineral-leases.minerals-ely.json";

/** Live BLM MLRS answers recorded 2026-10-23: the 4 largest oil and gas leases around Chaco Canyon, the 3 largest mineral leases near Ely. */
const oilGas = oilGasRaw as unknown as FeatureCollection;
const minerals = mineralsRaw as unknown as FeatureCollection;
const CHACO: [number, number, number, number] = [-108.3, 35.9, -107.6, 36.3];
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** One answer per service: features for a query, a count for returnCountOnly. */
function upstream(answers: Partial<Record<keyof typeof SERVICES, () => Response>> = {}) {
  return vi.fn(async (url: string) => {
    for (const [kind, base] of Object.entries(SERVICES) as [keyof typeof SERVICES, string][]) {
      if (!url.startsWith(base)) continue;
      const answer = answers[kind];
      if (answer) return answer();
      const fc = kind === "oil-gas" ? oilGas : kind === "minerals" ? minerals : EMPTY;
      return url.includes("returnCountOnly=true") ? json({ count: fc.features.length }) : json(fc);
    }
    return new Response("not found", { status: 404 });
  });
}

function ctx(stub: ReturnType<typeof vi.fn>, bbox = CHACO) {
  return { bbox, zoom: 10, env: {}, fetch: stub as unknown as CachedFetch };
}

function geojson(r: Awaited<ReturnType<typeof layer.query>>) {
  if (!("kind" in r) || r.kind !== "geojson") throw new Error(`expected geojson, got ${JSON.stringify(r)}`);
  return r;
}

describe("mineral-leases normalizing", () => {
  it("reads BLM's product codes as words", () => {
    expect(plainWords("O&G COMPETITIVE PUBLIC DOMAIN LEASE POST 1987")).toBe("Oil and gas competitive public domain lease post 1987");
    expect(plainWords("HDR PREF RGT LEASE-ACQ")).toBe("Hardrock preference right lease on acquired land");
    expect(plainWords("PD-NF MINNESOTA")).toBe("Public domain-national forest Minnesota");
    expect(plainWords("NON-REG COMP COAL LEASE-LBA")).toBe("Non-regulated competitive coal lease-lease by application");
    expect(plainWords("Oil & Gas")).toBe("Oil and gas");
    expect(plainWords("  ")).toBeUndefined();
  });

  it("calls a lease producing only when it is held by production", () => {
    expect(producingOf("Held by Actual Production")).toBe("producing");
    expect(producingOf("Held by Allocated Production")).toBe("producing");
    expect(producingOf("Non-Producing")).toBe("not producing");
    expect(producingOf("AGRMT PRODUCING")).toBe("not producing");
    expect(producingOf(null)).toBe("not producing");
  });

  it("keeps each lease as a shape with its case, type, commodity, acres in v, dates and production", () => {
    const leases = normalizeLeases(oilGas.features, "oil-gas");
    expect(leases).toHaveLength(4);
    expect(leases[0].properties).toMatchObject({
      name: "Oil and gas lease NMNM105453503",
      kind: "oil-gas",
      caseNumber: "NMNM105453503",
      leaseType: "Oil and gas competitive public domain lease post 1987",
      commodity: "Oil and gas",
      status: "Authorized",
      producing: "producing",
      acres: 2400,
      v: 2400,
      effective: "1988-09-01",
    });
    const ely = normalizeLeases(minerals.features, "minerals");
    expect(ely[0].properties).toMatchObject({ name: "Mineral lease MNES106104400", kind: "minerals", commodity: "Two or more minerals", status: "Interim" });
    expect(ely[0].properties).not.toHaveProperty("producing");
    expect(isoDay(-1e13)).toBeUndefined();
  });
});

describe("mineral-leases layer", () => {
  it("declares a US land layer with no time, a lease key, labels by acres and US units", () => {
    expect(contractProblems(layer)).toEqual([]);
    expect(layer.coverage).toBe("us");
    expect(timeShapeOf(layer)).toEqual({ shape: "none" });
    expect(legendOf(layer)).toMatchObject({ kind: "categories", field: "kind" });
    expect(labelsOf(layer)).toMatchObject({ field: "name", rankBy: "acres" });
    expect(layer.input.parse({})).toEqual({ kinds: ["oil-gas", "coal", "minerals"] });
  });

  it("asks all three services largest first and says how many leases, acres and producing", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub), layer.input.parse({})));
    expect(r.data.features).toHaveLength(7);
    const urls = stub.mock.calls.map((c) => String(c[0]));
    for (const base of Object.values(SERVICES)) expect(urls.some((u) => u.startsWith(base))).toBe(true);
    expect(urls.filter((u) => !u.includes("returnCountOnly")).every((u) => new URL(u).searchParams.get("orderByFields") === "RCRD_ACRS DESC")).toBe(true);
    expect(r.coverageNote).toMatch(/^7 federal leases in force in the box asked \(4 oil and gas, 3 other minerals\), 16,745 acres; 4 of the 4 oil and gas leases are producing/);
    expect(r.coverageNote).toMatch(/Federal minerals only/);
    expect(r.citation.source).toContain("Bureau of Land Management");
  });

  it("asks only the kinds named, says when there are none, and keeps what answered when one service fails", async () => {
    const coal = upstream();
    const none = geojson(await layer.query(ctx(coal), { kinds: ["coal"] }));
    expect(none.data.features).toHaveLength(0);
    expect(none.coverageNote).toMatch(/^No federal coal leases in force in this area/);
    expect(coal.mock.calls.every((c) => String(c[0]).startsWith(SERVICES.coal))).toBe(true);

    const broken = upstream({ minerals: () => new Response("busy", { status: 503 }) });
    const partial = geojson(await layer.query(ctx(broken), { kinds: ["oil-gas", "minerals"] }));
    expect(partial.data.features).toHaveLength(4);
    expect(partial.coverageNote).toMatch(/Missing the other minerals leases/);

    const down = upstream({ "oil-gas": () => new Response("busy", { status: 503 }) });
    expect(await layer.query(ctx(down), { kinds: ["oil-gas"] })).toMatchObject({ error: expect.stringMatching(/^Mineral leases unavailable/), hint: "upstream" });
  });

  it("answers nothing outside the US without calling out, and refuses a box over its hard cap through runLayer", async () => {
    const stub = upstream();
    const r = geojson(await layer.query(ctx(stub, [10, 45, 11, 46]), layer.input.parse({})));
    expect(r.data.features).toHaveLength(0);
    expect(stub).not.toHaveBeenCalled();
    const huge = await runLayer("mineral-leases", { bbox: [-115, 33, -105, 43] });
    expect(huge.status).toBe(422);
  });
});
