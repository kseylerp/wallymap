import { describe, expect, it } from "vitest";
import { dateInput, dateNote, isRealDate, resolveTileDate, type DateWindow } from "./dated-tiles";

const NOW = Date.parse("2026-10-09T01:30:00Z");
const win: DateWindow = { from: "2020-11-18", latestOffsetDays: -3, label: "night lights" };

describe("resolveTileDate", () => {
  it("defaults to the newest day offered", () => {
    expect(resolveTileDate(undefined, win, NOW)).toEqual({ ok: true, date: "2026-10-06" });
  });

  it("uses defaultOffsetDays when it differs from the newest day (forecasts)", () => {
    const fc: DateWindow = { from: "2024-01-01", latestOffsetDays: 9, defaultOffsetDays: 0, label: "fire weather" };
    expect(resolveTileDate(undefined, fc, NOW)).toEqual({ ok: true, date: "2026-10-09" });
    expect(resolveTileDate("2026-10-15", fc, NOW)).toEqual({ ok: true, date: "2026-10-15" });
  });

  it("accepts a day inside the archive unchanged", () => {
    expect(resolveTileDate("2025-12-24", win, NOW)).toEqual({ ok: true, date: "2025-12-24" });
  });

  it("clamps a day after the newest one and says so", () => {
    const r = resolveTileDate("2026-10-09", win, NOW);
    expect(r).toMatchObject({ ok: true, date: "2026-10-06", note: expect.stringContaining("2026-10-06") });
  });

  it("clamps to `to` when the archive has ended", () => {
    const ended: DateWindow = { ...win, to: "2025-09-01", latestOffsetDays: 0 };
    expect(resolveTileDate(undefined, ended, NOW)).toEqual({ ok: true, date: "2025-09-01" });
  });

  it("rejects a day before the archive and an impossible day", () => {
    expect(resolveTileDate("2020-11-17", win, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("2020-11-18") });
    expect(resolveTileDate("2026-02-31", win, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("not a real date") });
  });

  it("starts at `from` when the default would fall before it", () => {
    const w: DateWindow = { from: "2026-10-08", latestOffsetDays: -30, label: "x" };
    expect(resolveTileDate(undefined, w, NOW)).toEqual({ ok: true, date: "2026-10-08" });
  });

  it("works across a month boundary in UTC", () => {
    expect(resolveTileDate(undefined, win, Date.parse("2026-03-02T23:59:00Z"))).toEqual({ ok: true, date: "2026-02-27" });
  });
});

describe("helpers", () => {
  it("checks real dates", () => {
    expect(isRealDate("2024-02-29")).toBe(true);
    expect(isRealDate("2025-02-29")).toBe(false);
  });
  it("validates the date input shape", () => {
    expect(dateInput.safeParse("2026-1-5").success).toBe(false);
    expect(dateInput.safeParse(undefined).success).toBe(true);
  });
  it("writes the coverage note", () => {
    expect(dateNote("Snow cover", "2026-10-08")).toBe("Snow cover for 2026-10-08");
    expect(dateNote("Snow cover", "2026-10-08", "moved")).toBe("Snow cover for 2026-10-08 (moved)");
  });
});
