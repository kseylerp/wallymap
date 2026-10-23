import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedFetch } from "@/lib/fetch";
import { clearMapCache } from "@/lib/ee/client";
import { clearTokenCache } from "@/lib/ee/auth";
import { parseTileQuery, UNCHANGED_COLOR } from "@/lib/ee/forestTypes";
import { fakeEeFetch, functionNames, testEnv } from "@/lib/ee/__fixtures__/fakeEe";
import recorded from "@/lib/ee/__fixtures__/forest-types.json";
import { scenarioText, scenarioTileUrl } from "@/lib/render/scenario";
import { hexToRgb } from "@/lib/render/ramp";
import layer, { CONFIDENT_PCT, LEGEND, sharesSentence, sureWords } from "./forest-types";
import { contractProblems, legendOf, timeShapeOf } from "./contract";
import type { IdentifyPoint, LayerResult } from "./types";

const SABAH: [number, number, number, number] = [117.6, 4.8, 118.0, 5.1];

/** Answers value:compute from the recorded answers, by what the expression asks. */
function recordedCompute(expression: unknown): unknown {
  const names = functionNames(expression);
  const text = JSON.stringify(expression);
  if (names.includes("Image.pixelArea")) return recorded.areasKalimantanSince2017;
  if (text.includes("frequencyHistogram")) return text.includes('"constantValue":175') ? recorded.sharesSabahConfident : recorded.sharesSabahAll;
  if (text.includes("v2_beta/2017")) return recorded.pointSabah2017;
  if (text.includes("v2_beta/2025")) return recorded.pointSabah2025;
  return recorded.pointDanumBaseline;
}

function ctx(env: Record<string, string> = testEnv()) {
  return { bbox: SABAH, zoom: 10, env, fetch: vi.fn() as unknown as CachedFetch };
}

async function tiles(input: Record<string, unknown>): Promise<Extract<LayerResult, { kind: "tiles" }>> {
  const r = await layer.query(ctx(), layer.input.parse(input));
  if (!("kind" in r) || r.kind !== "tiles") throw new Error(`expected tiles, got ${JSON.stringify(r)}`);
  return r;
}

describe("forest-types layer", () => {
  let fake: ReturnType<typeof fakeEeFetch>;
  beforeEach(() => {
    clearMapCache();
    clearTokenCache();
    fake = fakeEeFetch({ compute: recordedCompute });
    vi.stubGlobal("fetch", fake.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("declares the contract: global land, no time of its own, a six-class key, needs EE_PROJECT", () => {
    expect(layer.coverage).toBe("global");
    expect(layer.surface).toBe("land");
    expect(layer.requiredEnv).toEqual(["EE_PROJECT"]);
    expect(contractProblems(layer)).toEqual([]);
    expect(timeShapeOf(layer).shape).toBe("none");
    expect(legendOf(layer).items?.map((i) => i.label)).toEqual([
      "Primary forest",
      "Naturally regenerating forest",
      "Planted forest",
      "Plantation forest",
      "Tree crops and agroforestry",
      "Other land",
    ]);
    expect(layer.license).toMatch(/CC BY 4\.0.*Google DeepMind, WRI, IIASA.*Neumann et al\., Scientific Data 2026/);
    expect(layer.description.length).toBeGreaterThan(400);
  });

  it("draws the 2020 baseline through our own tile route, with the confidence control and the shares in the note", async () => {
    const r = await tiles({});
    expect(r.data.url).toBe("/api/ee/tiles/forest-types/{z}/{x}/{y}?view=classes&src=2020v1&conf=all");
    expect(parseTileQuery(new URLSearchParams(r.data.url.split("?")[1]))).toEqual({ view: "classes", source: { kind: "baseline" }, minConfidence: 0 });
    expect(r.data).toMatchObject({ format: "raster", minzoom: 3, maxzoom: 14 });
    const scenario = r.data.scenario!;
    expect(scenario.control).toBe("toggle");
    expect(timeShapeOf(layer, r).shape).toBe("none");
    expect(r.citation).toMatchObject({ label: "Google DeepMind, WRI, IIASA (ForTy, CC BY 4.0)", url: "https://www.nature.com/articles/s41597-026-08299-5" });
    expect(scenario.values).toEqual([0, CONFIDENT_PCT]);
    expect(scenario.values.map((v) => scenarioText(scenario, v))).toEqual(["All", "Only confident pixels"]);
    expect(scenarioTileUrl(scenario, 70)).toBe("/api/ee/tiles/forest-types/{z}/{x}/{y}?view=classes&src=2020v1&conf=confident");
    expect(scenarioTileUrl(scenario, 0)).toBe(r.data.url);
    expect(r.coverageNote).toMatch(/^ForTy 2020 baseline \(v1\.0\), every pixel; share of the land in the box asked: primary forest 93%/);
    expect(r.citation.source).toMatch(/Google DeepMind.*CC BY 4\.0.*Neumann et al\., Scientific Data \(2026\)/);
    expect(r.legend).toBe(LEGEND);
    // The browser never sees a credential or a Google URL.
    expect(JSON.stringify(r)).not.toMatch(/googleapis|PRIVATE KEY|ya29/);
    const compute = fake.calls.find((c) => c.url.endsWith("value:compute"))!;
    expect(compute.headers["x-goog-user-project"]).toBe("wally-14e22");
  });

  it("keys other land and standing forest as the faint pixels they draw, clearly apart from primary forest", () => {
    const lightness = (hex: string) => hexToRgb(hex).reduce((a, b) => a + b, 0) / 3;
    const color = (label: string) => LEGEND.items!.find((i) => i.label === label)!.color!;
    expect(lightness(color("Other land"))).toBeGreaterThan(170);
    expect(lightness(color("Primary forest"))).toBeLessThan(110);
  });

  it("strict mode keeps only pixels at least 70% sure and keys the blank ones", async () => {
    const r = await tiles({ confidence: "confident" });
    expect(r.data.url).toContain("conf=confident");
    expect(r.coverageNote).toContain("only pixels at least 70% sure");
    expect(r.coverageNote).toMatch(/less than 70% sure \(not drawn\) 3%/);
    expect(r.legend?.items?.at(-1)).toMatchObject({ label: "Not drawn: less than 70% sure", value: 0 });
  });

  it("puts a year of the beta series on the time scrubber", async () => {
    const r = await tiles({ year: 2019 });
    expect(r.data.url).toContain("src=2019");
    expect(r.data.scenario).toBeUndefined();
    expect(timeShapeOf(layer, r)).toMatchObject({ shape: "continuous", step: "year", span: { start: "2017", end: "2025" } });
    expect(r.data.time).toEqual({ template: "/api/ee/tiles/forest-types/{z}/{x}/{y}?view=classes&src={year}&conf=all", cadence: "yearly", from: "2017", to: "2025" });
    expect(r.coverageNote).toMatch(/^ForTy 2019 \(yearly beta\)/);
  });

  it("states natural forest converted since a year, by target, in pink", async () => {
    const r = await tiles({ convertedSince: 2017 });
    expect(r.data.url).toBe("/api/ee/tiles/forest-types/{z}/{x}/{y}?view=change&since=2017&to=2025&conf=all");
    expect(r.coverageNote).toMatch(/Natural forest in 2017 that is something else in 2025, in the box asked: about 908 km² \(9\.8% of 9,259 km² of natural forest\): plantation or planted forest 0\.2 km², tree crops and agroforestry 176 km², other land \(cleared\) 732 km²/);
    expect(r.legend?.title).toBe("Natural forest converted since 2017");
    expect(timeShapeOf(layer, r)).toMatchObject({ shape: "snapshots", step: "year", span: { start: "2017", end: "2025" } });
    expect(timeShapeOf(layer, r).dates).toHaveLength(9);
    expect(r.data.scenario).toBeUndefined();
    expect(r.legend?.items?.map((i) => i.label)).toEqual([
      "To plantation or planted forest: 0.2 km²",
      "To tree crops and agroforestry: 176 km²",
      "To other land (cleared): 732 km²",
      "Natural forest still standing in 2025 (faint)",
    ]);
    expect(r.legend?.items?.at(-1)?.color).not.toBe(UNCHANGED_COLOR);
    expect(await layer.query(ctx(), layer.input.parse({ convertedSince: 2017, year: 2020 }))).toMatchObject({ error: expect.stringMatching(/either year or convertedSince/) });
  });

  it("opens a card with the class and the six chances in plain words", async () => {
    const at: IdentifyPoint = { lon: 117.79, lat: 4.97 };
    const f = await layer.identify!(ctx(), at, layer.input.parse({}));
    if (!f || "error" in f) throw new Error("expected a feature");
    expect(f.properties).toMatchObject({ name: "Primary forest", summary: "Almost certainly primary forest (99% sure)", map: "ForTy 2020 baseline (v1.0)" });
    expect(f.properties?.p_primary).toBeCloseTo(0.992, 3);
    const facts = layer.card!.facts!.filter((x) => x.format === "pct").map((x) => x.label);
    expect(facts).toHaveLength(6);

    const change = await layer.identify!(ctx(), { lon: 118.25, lat: 5.55 }, layer.input.parse({ convertedSince: 2017 }));
    if (!change || "error" in change) throw new Error("expected a feature");
    expect(change.properties).toMatchObject({ name: "Tree crops and agroforestry", before: "Tree crops and agroforestry in 2017 (80% sure)", map: "ForTy 2025 (yearly beta)" });
  });

  it("counts the classes in view for the legend, following the confidence shown", async () => {
    expect(await layer.viewShares!(ctx(), {}, layer.input.parse({}))).toMatchObject({ field: "class", shares: { "1": expect.any(Number) } });
    const strict = await layer.viewShares!(ctx(), { scenario: 70 }, layer.input.parse({}));
    expect(strict && !("error" in strict) && strict.shares["0"]).toBeGreaterThan(0);
    expect(await layer.viewShares!(ctx(), {}, layer.input.parse({ convertedSince: 2017 }))).toBeNull();
  });

  it("says plainly when Earth Engine is not set up or fails", async () => {
    vi.stubGlobal("fetch", fakeEeFetch({ compute: () => new Response("busy", { status: 503 }) }).fetch);
    const failed = await layer.query(ctx(), layer.input.parse({}));
    expect(failed).toMatchObject({ hint: "upstream", sourceStatus: { ok: false, reason: "server-error" } });

    const unset = await layer.query(ctx({ EE_PROJECT: "wally-14e22", GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/adc.json" }), layer.input.parse({}));
    expect(unset).toMatchObject({ hint: "unavailable", sourceStatus: { ok: false, reason: "offline" } });
    expect("error" in unset && unset.error).toMatch(/not set up on this server/);
  });

  it("words probabilities and shares plainly", () => {
    expect([0.95, 0.75, 0.55, 0.3].map(sureWords)).toEqual(["Almost certainly", "Very likely", "Likely", "Possibly"]);
    expect(sharesSentence({ "1": 0.6, "5": 0.3, "0": 0.098, "4": 0.002 })).toBe("primary forest 60%, tree crops and agroforestry 30%, less than 70% sure (not drawn) 10%");
  });
});
