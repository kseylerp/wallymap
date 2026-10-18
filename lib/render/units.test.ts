import type { Feature } from "geojson";
import { describe, expect, it } from "vitest";
import { cardContent } from "@/lib/render/card";
import { featureTitle } from "@/lib/render/contract";
import { hasTimeOfDay, localTime, quantity, zoneAt } from "@/lib/render/units";

const US = { units: "us" as const, secondaryUnits: "metric" as const, timeZone: "local" as const, showZone: true as const };
const METRIC = { ...US, units: "metric" as const, secondaryUnits: "us" as const };

describe("units for people (display)", () => {
  it("prints US first with metric second for US data, and the other way elsewhere", () => {
    expect(quantity(1609, "m", US)).toBe("5,279 ft (1,609 m)");
    expect(quantity(2.5, "km²", US)).toBe("0.97 mi² (2.5 km²)");
    expect(quantity(100, "m³/s", US)).toBe("3,531 cfs (100 m³/s)");
    expect(quantity(20, "°C", US)).toBe("68°F (20°C)");
    expect(quantity(500, "cfs", METRIC)).toBe("14.2 m³/s (500 cfs)");
    expect(quantity(1200, "MW", US)).toBe("1,200 MW");
    // Already in the wanted system: the other second.
    expect(quantity(5280, "ft", US)).toBe("5,280 ft (1,609 m)");
  });

  it("prints times in the feature's own zone with its abbreviation", () => {
    expect(zoneAt([-119.5, 37.8])).toBe("America/Los_Angeles");
    expect(zoneAt([-150, 61.2])).toBe("America/Anchorage");
    expect(localTime("2026-10-16T21:15:00Z", [-119.5, 37.8], US)).toBe("Oct 16, 2026, 2:15 PM PDT");
    expect(localTime("2026-10-16T21:15:00Z", [-119.5, 37.8], { timeZone: "utc" })).toBe("Oct 16, 2026, 9:15 PM UTC");
    expect(hasTimeOfDay("2026-10-16T00:00:00.000Z")).toBe(false);
    expect(localTime("2026-10-16", [-119.5, 37.8], US)).toBeNull();
  });
});

describe("cards (owner: no internal ids, error strings or field keys; titles name the thing)", () => {
  const quake: Feature = {
    type: "Feature",
    id: "nc75012345",
    geometry: { type: "Point", coordinates: [-120, 38.9] },
    properties: { kind: "earthquake", place: "10 km WSW of South Lake Tahoe, CA", depthKm: 8.2, quakeId: "nc75012345", note: "Returned 40 quakes", t: "2026-10-16T21:15:00Z" },
  };
  it("titles by kind and place, never Feature", () => {
    expect(featureTitle({ id: "earthquakes", title: "Earthquakes (USGS)" }, quake)).toBe("Earthquake 10 km WSW of South Lake Tahoe, CA");
  });
  it("hides ids and notes, prints depth in US units first and the time locally", () => {
    const content = cardContent(quake, { display: { ...US, at: [-120, 38.9] } });
    const rows = [...content.facts, ...content.details];
    expect(rows.some((r) => /nc75012345|Returned 40/.test(r.value))).toBe(false);
    expect(rows.find((r) => r.key === "depthKm")?.value).toBe("5.1 mi (8.2 km)");
  });
});
