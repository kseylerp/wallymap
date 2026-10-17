import { describe, expect, it } from "vitest";
import { placeCandidates } from "./places";

describe("placeCandidates", () => {
  it.each([
    ["How deep is Lake Tahoe?", ["Lake Tahoe"]],
    ["How full is Lake Powell right now?", ["Lake Powell"]],
    ["Recent earthquakes near Mammoth Lakes", ["Mammoth Lakes"]],
    ["Climbing crags near Red River Gorge", ["Red River Gorge"]],
    ["Outline the Sierra Nevada", ["Sierra Nevada"]],
    ["Show Miami with 3 feet of sea level rise", ["Miami"]],
    ["Is the Carson River running high?", ["Carson River"]],
    ["dams in the colorado river basin", ["colorado river basin"]],
    ["dams in the Colorado River basin", ["Colorado River basin"]],
    ["Which uranium mines near the Navajo Nation score highest?", ["Navajo Nation"]],
    ["wind farms in West Texas @view=[-104,29,-96,35]", ["West Texas"]],
    ["Who owns the land around Bryce Canyon, and is any of it designated wilderness?", ["Bryce Canyon"]],
    ["Show me a walking route from Tahoe City to Emerald Bay", ["Tahoe City", "Emerald Bay"]],
  ])("%s → %j", (question, places) => {
    expect(placeCandidates(question)).toEqual(places);
  });

  it.each(["What fires are here? @view=[-120.2,38.9,-119.8,39.3]", "Which sequoia groves burned in the 2020 and 2021 fires?", "Mountain bike trails nearby"])(
    "names no place in %s",
    (question) => {
      expect(placeCandidates(question)).toEqual([]);
    },
  );
});
