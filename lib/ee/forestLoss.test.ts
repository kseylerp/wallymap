import { describe, expect, it } from "vitest";
import { toExpression } from "./expr";
import {
  DRIVER_CLASSES,
  boxLossExpression,
  driverShares,
  haText,
  km2Text,
  lossScale,
  matchRegion,
  matchScale,
  readLoss,
  readRegions,
  regionsExpression,
  topYears,
  type Region,
} from "./forestLoss";

const PARA_BOX: [number, number, number, number] = [-58.9, -9.9, -46.0, 2.6];

/** The ADM0 and ADM1 rows Earth Engine returned for the Pará box on 2026-10-23 (areas in km², rounded). */
const ADM1 = {
  list: [
    ["BRA-ADM1-1", "Para", "BRA", 1217747, 1217747],
    ["BRA-ADM1-2", "Amazonas", "BRA", 1565029, 124855],
    ["BRA-ADM1-3", "Mato Grosso", "BRA", 905552, 60610],
    ["BRA-ADM1-4", "Amapa", "BRA", 137458, 118942],
    ["SUR-ADM1-1", "Sipaliwini", "SUR", 112239, 10157],
  ],
};
const ADM0 = {
  list: [
    ["BRA-ADM0", "Brazil", "BRA", 8471604, 1757397],
    ["SUR-ADM0", "Suriname", "SUR", 145774, 9800],
    ["GUY-ADM0", "Guyana", "GUY", 210731, 24808],
  ],
};

describe("forest loss totals (Earth Engine)", () => {
  it("names the Hansen v1.13 and drivers assets and the seven drivers in the dataset's order", () => {
    const text = JSON.stringify(toExpression(boxLossExpression(PARA_BOX, 2017, 2025, 30)));
    expect(text).toContain("UMD/hansen/global_forest_change_2025_v1_13");
    expect(text).toContain("wri_gdm_drivers_forest_loss_1km/v1_3_2001_2025");
    expect(DRIVER_CLASSES.map((d) => d.label)).toEqual([
      "Permanent agriculture",
      "Hard commodities",
      "Shifting cultivation",
      "Logging",
      "Wildfire",
      "Settlements and infrastructure",
      "Other natural disturbances",
    ]);
    expect(JSON.stringify(toExpression(regionsExpression("ADM1", PARA_BOX)))).toContain("WM/geoLab/geoBoundaries/600/ADM1");
  });

  it("samples about 16 million cells over the area, never finer than 30 m, and outlines coarser", () => {
    expect(lossScale(1_000)).toBe(30);
    expect(lossScale(1_217_747)).toBe(280);
    expect(matchScale([-122.5, 44.6, -122.0, 44.9])).toBe(2000);
    expect(matchScale(PARA_BOX)).toBeGreaterThan(3000);
  });

  it("matches a box to the state or country it stands for, and to nothing in a valley's view", () => {
    const regions = [...readRegions("ADM0", ADM0), ...readRegions("ADM1", ADM1)];
    expect(matchRegion(regions)).toMatchObject({ level: "ADM1", name: "Para", id: "BRA-ADM1-1" });
    // The Santiam Canyon's view: Oregon reaches far beyond it.
    const oregon: Region[] = [
      { level: "ADM0", id: "USA", name: "United States", country: "USA", areaKm2: 9_500_000, inBoxKm2: 1100 },
      { level: "ADM1", id: "OR", name: "Oregon", country: "USA", areaKm2: 254_000, inBoxKm2: 1100 },
    ];
    expect(matchRegion(oregon)).toBeNull();
    // A country's own box is the country, not its largest state.
    const brazil: Region[] = [
      { level: "ADM0", id: "BRA", name: "Brazil", country: "BRA", areaKm2: 8_470_000, inBoxKm2: 8_470_000 },
      { level: "ADM0", id: "PER", name: "Peru", country: "PER", areaKm2: 1_280_000, inBoxKm2: 300_000 },
      { level: "ADM1", id: "AM", name: "Amazonas", country: "BRA", areaKm2: 1_565_000, inBoxKm2: 1_565_000 },
    ];
    expect(matchRegion(brazil)?.name).toBe("Brazil");
    expect(readRegions("ADM1", { list: [["x", "y", "z", 0, 0], "bad"] })).toEqual([]);
    expect(readRegions("ADM1", null)).toEqual([]);
  });

  it("reads the sums into km² per year and per driver, with shares and the busiest years", () => {
    const t = readLoss({ forest: 1_098_000, total: 82_800, y2017: 13_900, y2018: 8_000, y2024: 15_900, d1: 54_200, d5: 22_200, d3: 2_800, d2: 1_400, d4: 1_300, d7: 0 }, 2017, 2025);
    expect(t).not.toBeNull();
    expect(t!.byYear[2019]).toBe(0);
    expect(topYears(t!).map((y) => y.year)).toEqual([2024, 2017, 2018]);
    expect(driverShares(t!).map((d) => [d.driver.key, Math.round(d.share * 100)])).toEqual([
      ["agriculture", 66],
      ["wildfire", 27],
      ["shifting", 3],
      ["commodities", 2],
      ["logging", 2],
    ]);
    expect(readLoss({}, 2017, 2025)).toBeNull();
  });

  it("writes areas as people read them", () => {
    expect(km2Text(82_812)).toBe("82,800 km²");
    expect(km2Text(536.4)).toBe("536 km²");
    expect(km2Text(4.24)).toBe("4.2 km²");
    expect(haText(82_812)).toBe("8.3 million ha");
    expect(haText(536)).toBe("53,600 ha");
    expect(haText(4.2)).toBe("420 ha");
  });
});
