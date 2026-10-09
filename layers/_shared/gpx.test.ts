import { describe, expect, it } from "vitest";
import { parseGpx } from "./gpx";

/** A small GPX 1.1 file: two track segments (one with too few points) and a route. */
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Rubicon Trail &amp; Eagle Falls</name></metadata>
  <wpt lat="38.95" lon="-120.10"><name>Vikingsholm</name></wpt>
  <trk>
    <name>Morning hike</name>
    <trkseg>
      <trkpt lat="39.0001" lon="-120.1001"><ele>1900.5</ele><time>2026-07-01T15:00:00Z</time><name>p1</name></trkpt>
      <trkpt lon="-120.1002" lat="39.0002"><ele>1902</ele></trkpt>
      <trkpt lat='39.0003' lon='-120.1003'/>
    </trkseg>
    <!-- <trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg> -->
    <trkseg>
      <trkpt lat="39.1" lon="-120.2"/>
    </trkseg>
    <trkseg>
      <trkpt lat="bad" lon="-120.3"/>
      <trkpt lat="39.2" lon="-120.3"/>
      <trkpt lat="39.3" lon="-120.4"/>
    </trkseg>
  </trk>
  <rte>
    <name>Planned</name>
    <rtept lat="38.9" lon="-120.0"/>
    <rtept lat="38.8" lon="-120.1"/>
  </rte>
</gpx>`;

describe("parseGpx", () => {
  it("reads every track segment and route as a LineString in file order", () => {
    const { name, lines } = parseGpx(FIXTURE);
    expect(name).toBe("Rubicon Trail & Eagle Falls");
    expect(lines).toEqual([
      {
        type: "LineString",
        coordinates: [
          [-120.1001, 39.0001, 1900.5],
          [-120.1002, 39.0002, 1902],
          [-120.1003, 39.0003],
        ],
      },
      { type: "LineString", coordinates: [[-120.3, 39.2], [-120.4, 39.3]] },
      { type: "LineString", coordinates: [[-120.0, 38.9], [-120.1, 38.8]] },
    ]);
  });

  it("names the file after its track when there is no metadata name", () => {
    const xml = `<gpx><trk><name>Loop</name><trkseg><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"/></trkseg></trk></gpx>`;
    expect(parseGpx(xml)).toEqual({ name: "Loop", lines: [{ type: "LineString", coordinates: [[2, 1], [4, 3]] }] });
  });

  it("reads a route-only file with namespaced tags", () => {
    const xml = `<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1"><gpx:rte><gpx:name>R</gpx:name>
      <gpx:rtept lat="10" lon="20"></gpx:rtept><gpx:rtept lat="11" lon="21"></gpx:rtept></gpx:rte></gpx:gpx>`;
    expect(parseGpx(xml)).toEqual({ name: "R", lines: [{ type: "LineString", coordinates: [[20, 10], [21, 11]] }] });
  });

  it("returns no lines for empty or non-GPX text", () => {
    expect(parseGpx("")).toEqual({ lines: [] });
    expect(parseGpx("<html><body>nope</body></html>")).toEqual({ lines: [] });
  });
});
