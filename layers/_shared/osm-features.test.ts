import { describe, expect, it } from "vitest";
import {
  bboxClause,
  checkedOn,
  countedTotal,
  gradeNumber,
  isoDate,
  metres,
  relationLine,
  returnedNote,
  wayCenter,
  wayLine,
  wholeNumber,
} from "./osm-features";

describe("bboxClause", () => {
  it("orders the box south,west,north,east", () => {
    expect(bboxClause([-120.2, 38.85, -120, 39])).toBe("(38.85,-120.2,39,-120)");
  });
});

describe("countedTotal", () => {
  it("sums the totals of every count element and returns null without one", () => {
    const body = { elements: [{ type: "count", tags: { total: "153" } }, { type: "count", tags: { total: "2" } }, { type: "way" }] };
    expect(countedTotal(body)).toBe(155);
    expect(countedTotal({ elements: [] })).toBeNull();
    expect(countedTotal(null)).toBeNull();
  });
});

describe("tag parsing", () => {
  it("accepts only real calendar dates", () => {
    expect(isoDate("2024-02-29")).toBe("2024-02-29");
    expect(isoDate("2023-02-29")).toBeUndefined();
    expect(isoDate("2024-05")).toBeUndefined();
    expect(checkedOn({ check_date: "bad", "survey:date": "2022-07-01" })).toBe("2022-07-01");
  });

  it("reads whole numbers and metres, converting feet", () => {
    expect(wholeNumber("62")).toBe(62);
    expect(wholeNumber("10-20")).toBeUndefined();
    expect(metres("1234")).toBe(1234);
    expect(metres("1234.5 m")).toBe(1234.5);
    expect(metres("5280 ft")).toBe(1609.3);
    expect(metres("high")).toBeUndefined();
  });

  it("turns whitewater grades into numbers, hardest end of a range", () => {
    expect(gradeNumber("3")).toBe(3);
    expect(gradeNumber("3+")).toBe(3.5);
    expect(gradeNumber("2-")).toBe(1.5);
    expect(gradeNumber("2-3")).toBe(3);
    expect(gradeNumber("II-III")).toBe(3);
    expect(gradeNumber("IV")).toBe(4);
    expect(gradeNumber("class 5")).toBe(5);
    expect(gradeNumber("portage")).toBeUndefined();
    expect(gradeNumber(undefined)).toBeUndefined();
  });
});

describe("geometry helpers", () => {
  const a = [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }];
  it("builds a line from two or more points only", () => {
    expect(wayLine(a)).toEqual({ type: "LineString", coordinates: [[2, 1], [4, 3]] });
    expect(wayLine([a[0]])).toBeNull();
    expect(wayLine(undefined)).toBeNull();
  });

  it("joins relation way members and skips nodes and empty members", () => {
    const members = [{ type: "way", geometry: a }, { type: "node" }, { type: "way", geometry: [] }, { type: "way", geometry: a }];
    expect(relationLine(members)?.type).toBe("MultiLineString");
    expect(relationLine([members[0]])?.type).toBe("LineString");
    expect(relationLine([members[1]])).toBeNull();
  });
});

describe("wayCenter", () => {
  it("averages a closed ring, takes the middle of an open line, and returns null for nothing", () => {
    const ring = [{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }, { lat: 2, lon: 2 }, { lat: 2, lon: 0 }, { lat: 0, lon: 0 }];
    expect(wayCenter(ring)).toEqual([1, 1]);
    expect(wayCenter([{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }])).toEqual([1, 0]);
    expect(wayCenter([])).toBeNull();
  });
});

describe("returnedNote", () => {
  it("reports the count, and whether the box held more", () => {
    expect(returnedNote(1200, 1200, "trail ways", "named first")).toBe("Returned 1,200 trail ways; the box was not truncated");
    expect(returnedNote(2000, 3400, "trail ways", "named first")).toBe(
      "Showing 2,000 of 3,400 trail ways in this box (named first); zoom in for the rest",
    );
  });
});
