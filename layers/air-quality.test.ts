import { describe, expect, it, vi } from "vitest";
import type { QueryContext } from "./types";
import layer, { airDays, airQualityNote, aqiCategory, parseAirQuality } from "./air-quality";

// Five days of hours in Los Angeles time (UTC-7 in October), as Open-Meteo answers with timezone=auto.
function body(days = 3) {
  const time: string[] = [];
  const aqi: number[] = [];
  const pm: number[] = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      time.push(`2026-10-${String(23 + d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00`);
      aqi.push(30 + d * 20 + (h === 15 ? 5 : 0));
      pm.push(3 + d * 5);
    }
  }
  return { utc_offset_seconds: -25_200, timezone: "America/Los_Angeles", hourly: { time, pm2_5: pm, us_aqi: aqi } };
}

// Friday 2026-10-23, 19:30 in Los Angeles.
const NOW = Date.parse("2026-10-24T02:30:00Z");

describe("air-quality", () => {
  it("names the EPA categories", () => {
    expect(aqiCategory(37)).toBe("Good");
    expect(aqiCategory(101)).toBe("Unhealthy for sensitive groups");
    expect(aqiCategory(301)).toBe("Hazardous");
  });

  it("puts the local hours on a UTC axis and finds the hour now", () => {
    const aq = parseAirQuality(body(), [-119.59, 37.74], NOW)!;
    expect(aq.times[0]).toBe("2026-10-23T07:00:00.000Z");
    expect(aq.times[aq.now]).toBe("2026-10-24T02:00:00.000Z");
    expect(parseAirQuality({ nope: 1 }, [0, 0], NOW)).toBeNull();
  });

  it("gives each local day's worst hour from now, today marked as the hours left", () => {
    const aq = parseAirQuality(body(), [-119.59, 37.74], NOW)!;
    const days = airDays(aq);
    expect(days.map((d) => [d.label, d.worstAqi, d.partial])).toEqual([
      ["Fri Oct 23", 30, true],
      ["Sat Oct 24", 55, false],
      ["Sun Oct 25", 75, false],
    ]);
    expect(airQualityNote(aq, "Yosemite Valley")).toMatch(/^Air quality at Yosemite Valley .*now US AQI 30 \(good\), PM2.5 3 µg\/m³ \| Fri Oct 23: .* \| Sat Oct 24: air quality moderate, worst hour US AQI 55, PM2.5 up to 8 µg\/m³/);
  });

  it("answers one point at the asked place with the weekend in words", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const fetch = vi.fn(async () => new Response(JSON.stringify(body()), { status: 200 }));
      const ctx = { bbox: [-119.7, 37.68, -119.5, 37.78], zoom: 11, env: {}, fetch } as unknown as QueryContext;
      const r = await layer.query(ctx, layer.input.parse({ at: [-119.59, 37.74] }));
      if (!("kind" in r) || r.kind !== "geojson") throw new Error("expected geojson");
      expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain("latitude=37.740&longitude=-119.590&hourly=pm2_5,us_aqi");
      const p = r.data.features[0].properties!;
      expect(p).toMatchObject({ usAqi: 30, category: "Good", saturday: expect.stringMatching(/^Sat Oct 24: air quality moderate/), sunday: expect.stringMatching(/^Sun Oct 25:/) });
      expect(r.series?.times.length).toBe(72);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when Open-Meteo does not answer", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }));
    const ctx = { bbox: [-119.7, 37.68, -119.5, 37.78], zoom: 11, env: {}, fetch } as unknown as QueryContext;
    expect(await layer.query(ctx, layer.input.parse({}))).toMatchObject({ hint: "upstream" });
  });
});
