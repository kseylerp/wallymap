import { describe, expect, it } from "vitest";
import { factPool, noteFeatureNames, noteNumbers, ungroundedClaims, withoutClaims } from "@/lib/agent/grounding";
import { checkNote } from "@/lib/agent/noteCheck";
import { createTurn } from "@/lib/agent/turn";

const feature = (properties: Record<string, unknown>) => ({ type: "Feature", properties, geometry: { type: "Point", coordinates: [0, 0] } });
const answer = (summary: unknown, features: Record<string, unknown>[] = []) => ({ summary, body: { kind: "geojson", data: { type: "FeatureCollection", features: features.map(feature) } } });
const texts = (claims: { text: string }[]) => claims.map((c) => c.text);

describe("noteNumbers", () => {
  it("reads numbers with their units, scales and hedges", () => {
    expect(noteNumbers("about 6.5 million km² in September")).toEqual([expect.objectContaining({ text: "6.5 million km²", value: 6.5e6, dim: "area", hedged: true })]);
    expect(noteNumbers("Ennis reads 942 cfs at 51.8 °F")).toEqual([
      expect.objectContaining({ text: "942 cfs", dim: "flow" }),
      expect.objectContaining({ text: "51.8 °F", dim: "temperature", isTemp: "F" }),
    ]);
    expect(noteNumbers("2,650 firesheds")).toEqual([expect.objectContaining({ value: 2650, dim: "count" })]);
  });

  it("leaves out years, dates, times, durations, ranks and coordinates", () => {
    expect(noteNumbers("In 2012, on 2026-10-18 at 10 am PDT, for 3 days, the top 5, at 37.71°N 123.77°W, class 4, T4, #3")).toEqual([]);
  });
});

describe("ungroundedClaims: the audit's invented numbers and names", () => {
  it("catches a sea ice extent no result holds (the record low was about 3.4 million km²)", () => {
    const pool = factPool([answer({ kind: "tiles", layer: "sea-ice", date: "2026-10-22" })], "How has Arctic sea ice changed since 2012?");
    expect(texts(ungroundedClaims("Arctic sea ice covered 6.5 million km² in 2012, the record low.", pool))).toEqual(["6.5 million km²"]);
  });

  it("accepts a drop computed from two readings, and a unit conversion, but not an invented drop", () => {
    const pool = factPool([answer({ series: [{ t: "1999", v: 3685 }, { t: "2000", v: 3678 }, { t: "2026", v: 3526 }], unit: "ft" })], "How much has Lake Powell dropped since 2000?");
    expect(ungroundedClaims("Lake Powell fell from 3,678 ft in 2000 to 3,526 ft, a drop of about 152 ft (46 m).", pool)).toEqual([]);
    expect(texts(ungroundedClaims("Lake Powell dropped about 200 ft since 2000.", pool))).toEqual(["200 ft"]);
  });

  it("holds a length said of a named feature to that feature's own values", () => {
    const pool = factPool(
      [answer({ featureCount: 2 }, [{ name: "Johnny Tiller Falls", kind: "waterfall", ele: 900 }, { name: "Glassmine Falls", kind: "waterfall" }]), answer({ totalLengthKm: 412.3 }, [{ name: "Mountains-to-Sea Trail", lengthKm: 0.52 }])],
      "Easy hikes with a waterfall near Asheville",
    );
    expect(texts(ungroundedClaims("- **Johnny Tiller Falls**: an easy loop of about 0.5 km.", pool))).toEqual(["0.5 km"]);
    expect(ungroundedClaims("- **Mountains-to-Sea Trail**: about 0.5 km here.", pool)).toEqual([]);
  });

  it("catches feature names no result holds", () => {
    const pool = factPool([answer({ featureCount: 2 }, [{ name: "Royal Arch Trail", lengthKm: 2.1 }, { name: "Mount Sanitas Trail", lengthKm: 1.9 }])], "Good day hikes near Boulder under 5 miles");
    expect(texts(ungroundedClaims("Try Royal Arch Trail or the Flatirons Loop.", pool))).toEqual(["Flatirons Loop"]);
    expect(noteFeatureNames("Hike Mt. Sanitas Trail and Royal Arch Trail")).toEqual(["Mt. Sanitas Trail", "Royal Arch Trail"]);
    expect(ungroundedClaims("Mt. Sanitas Trail is 1.9 km.", pool)).toEqual([]);
    // SNOTEL's short forms: "Spirit Lk" is Spirit Lake, written with a narrow no-break space.
    const snotel = factPool([answer({ featureCount: 1 }, [{ name: "Spirit Lk", v: 12 }])], "Where's the deepest fresh snow in Utah right now?");
    expect(ungroundedClaims("Deepest at Spirit\u202fLake.", snotel)).toEqual([]);
    // The park around a place the question names is no invention.
    const rainier = factPool([answer({ featureCount: 1 })], "Which trails at Mount Rainier are snow free right now?");
    expect(ungroundedClaims("Snow lingers high in Mount Rainier National Park.", rainier)).toEqual([]);
    expect(ungroundedClaims("Mount Rainier’s trails are drawn.", rainier)).toEqual([]);
  });

  it("catches a count no result holds (2,650 firesheds for 265)", () => {
    const pool = factPool([answer({ featureCount: 265, stats: { sum: 5853271, unit: "acres" } })], "Old-growth forest in Oregon that isn't in wilderness");
    expect(texts(ungroundedClaims("2,650 firesheds cover 5,853,271 acres.", pool))).toEqual(["2,650"]);
    expect(ungroundedClaims("265 firesheds cover 5,853,271 acres.", pool)).toEqual([]);
  });

  it("holds flow words to the gauges' flow classes", () => {
    const normal = factPool([answer({ featureCount: 1 }, [{ name: "French Broad River at Asheville, NC", v: 863, flowClass: "normal", pctOfMedian: 85 }])], "Is the French Broad going to flood?");
    expect(ungroundedClaims("The French Broad is at 863 cfs, well above typical levels.", normal)).toEqual([{ text: "well above typical", kind: "flow" }]);
    const high = factPool([answer({ featureCount: 1 }, [{ name: "San Juan River at Four Corners", v: 21000, flowClass: "record_high" }])], "Class IV runs in Colorado");
    expect(ungroundedClaims("The San Juan is running high at 21,000 cfs.", high)).toEqual([]);
  });

  it("accepts conversions, percents and the question's own numbers", () => {
    const pool = factPool([answer({ change: { from: 32.7, to: 19, unit: "km²" }, stats: { max: 12.1, unit: "°C" } })], "Good day hikes near Boulder under 5 miles");
    expect(ungroundedClaims("Ice fell from 32.7 km² to 19 km², 42% less. Water is 54 °F. All are under 8 km (5 mi).", pool)).toEqual([]);
  });
});

describe("measures no result carries", () => {
  it("catches gusts from a wind layer without them, and drivers of forest loss", () => {
    const wind = factPool([answer({ stats: { max: 13.4, unit: "m/s" } })], "Is it too windy to climb at Joshua Tree tomorrow?");
    expect(ungroundedClaims("Tomorrow's strongest gusts reach 13.4 m/s.", wind)).toEqual([{ text: "gusts", kind: "measure" }]);
    const loss = factPool([answer({ kind: "tiles", layer: "forest-loss" })], "How much forest did Pará lose since 2017 and to what?");
    expect(texts(ungroundedClaims("Loss was driven primarily by cattle ranching.", loss))).toEqual(["driven primarily by"]);
  });
});

describe("withoutClaims", () => {
  it("cuts the sentence or list item that holds a claim, and a heading left empty", () => {
    const claims = [{ text: "6.5 million km²", kind: "number" as const }];
    expect(withoutClaims("Sea ice is drawn. In 2012 it covered 6.5 million km². The map shows today.", claims)).toBe("Sea ice is drawn. The map shows today.");
    expect(withoutClaims("**Findings**\n- 6.5 million km² in 2012", claims)).toBe("");
  });
});

describe("checkNote with grounding", () => {
  it("sends an invented number back once, then cuts it", () => {
    const turn = createTurn({ question: "How has Arctic sea ice changed since 2012?", geocoder: async () => ({ error: "none" }) });
    turn.outputs.push(answer({ kind: "tiles", layer: "sea-ice" }));
    const first = checkNote("Sea ice is drawn for today. In 2012 it covered 6.5 million km².", turn);
    expect(first).toEqual({ error: expect.stringContaining("These are not in any result this turn: 6.5 million km²") });
    const second = checkNote("Sea ice is drawn for today. In 2012 it covered 6.5 million km².", turn);
    expect(second).toEqual({ markdown: "Sea ice is drawn for today." });
    expect(turn.log.join(" ")).toContain("cut from the note, not in any result: 6.5 million km²");
  });

  it("leaves a grounded note as it is", () => {
    const turn = createTurn({ question: "Fires near Missoula", geocoder: async () => ({ error: "none" }) });
    turn.outputs.push(answer({ featureCount: 3, stats: { sum: 12450 } }));
    expect(checkNote("3 fires burned 12,450 acres.", turn)).toBeNull();
  });
});
