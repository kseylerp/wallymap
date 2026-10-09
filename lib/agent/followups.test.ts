import { describe, expect, it } from "vitest";
import { extractFollowUps } from "@/lib/agent/followups";

describe("extractFollowUps", () => {
  it("splits a trailing list of three questions off the answer", () => {
    const md = [
      "**Hiking trails near Lake Tahoe**",
      "",
      "- 1,825 trail segments in view.",
      "- Data from OpenStreetMap (ODbL).",
      "",
      "---",
      "",
      "- Would you like to filter trails by difficulty?",
      "- Are you interested in surface types?",
      "- Should I add trailheads?",
      "",
    ].join("\n");
    expect(extractFollowUps(md)).toEqual({
      body: ["**Hiking trails near Lake Tahoe**", "", "- 1,825 trail segments in view.", "- Data from OpenStreetMap (ODbL)."].join("\n"),
      followUps: [
        "Would you like to filter trails by difficulty?",
        "Are you interested in surface types?",
        "Should I add trailheads?",
      ],
    });
  });

  it("accepts two items, any bullet marker, and strips inline markdown", () => {
    const md =
      "Here you go.\n\n* Show **alpine** trails near [Chamonix](https://x.y)?\n+ Compare _sac_scale_ with `osm-trails` in mountain_hiking areas?";
    expect(extractFollowUps(md)).toEqual({
      body: "Here you go.",
      followUps: ["Show alpine trails near Chamonix?", "Compare sac_scale with osm-trails in mountain_hiking areas?"],
    });
  });

  it("joins wrapped continuation lines and loose (blank-separated) items", () => {
    const md = "Done.\n\n- Want trails that\n  have a name?\n\n- Want only footpaths?";
    expect(extractFollowUps(md).followUps).toEqual(["Want trails that have a name?", "Want only footpaths?"]);
  });

  it("leaves the markdown alone when there is no trailing list", () => {
    const md = "- Is this a question?\n- And this?\n\nBut the answer ends in prose.";
    expect(extractFollowUps(md)).toEqual({ body: md, followUps: [] });
  });

  it("leaves one or four-plus items alone", () => {
    const one = "Text\n\n- Only one?";
    const four = "Text\n\n- A?\n- B?\n- C?\n- D?";
    expect(extractFollowUps(one)).toEqual({ body: one, followUps: [] });
    expect(extractFollowUps(four)).toEqual({ body: four, followUps: [] });
  });

  it("does not turn a closing list of facts into follow-ups", () => {
    const md = "Summary\n\n- 212 trails found.\n- Source: OpenStreetMap.";
    expect(extractFollowUps(md)).toEqual({ body: md, followUps: [] });
  });

  it("ignores ordered and nested lists", () => {
    const ordered = "Text\n\n1. First?\n2. Second?";
    const nested = "Text\n\n- Parent?\n  - Child?";
    expect(extractFollowUps(ordered)).toEqual({ body: ordered, followUps: [] });
    expect(extractFollowUps(nested)).toEqual({ body: nested, followUps: [] });
  });

  it("accepts statements when a lead-in introduces them, dropping leading emoji", () => {
    const md = [
      "Done.",
      "",
      "**Next steps – what would you like to explore?**",
      "",
      "- 🎯 Find trails of a specific difficulty.",
      "- 🏞️ Overlay satellite imagery.",
      "- 📍 Locate trailheads near South Lake Tahoe.",
    ].join("\n");
    expect(extractFollowUps(md)).toEqual({
      body: "Done.\n\n**Next steps – what would you like to explore?**",
      followUps: [
        "Find trails of a specific difficulty.",
        "Overlay satellite imagery.",
        "Locate trailheads near South Lake Tahoe.",
      ],
    });
  });

  it("drops leading checkboxes and arrows", () => {
    const md = "What next?\n\n- ☐ Filter by difficulty.\n- [ ] Add campgrounds.\n- → See contours.";
    expect(extractFollowUps(md).followUps).toEqual(["Filter by difficulty.", "Add campgrounds.", "See contours."]);
  });

  it("returns an empty body when the answer is only the list", () => {
    expect(extractFollowUps("- A?\n- B?")).toEqual({ body: "", followUps: ["A?", "B?"] });
  });
});
