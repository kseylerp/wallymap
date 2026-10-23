import { describe, expect, it } from "vitest";
import type { GeocodeResult } from "@/lib/agent/geocode";
import { createTurn } from "@/lib/agent/turn";

const at = (name: string, center: [number, number]): GeocodeResult => ({ name, center, bbox: [center[0] - 0.1, center[1] - 0.1, center[0] + 0.1, center[1] + 0.1], source: "mapbox" });

describe("Turn.lookup", () => {
  it("biases a lookup toward the question's other place when there is no view (Red Rock near Las Vegas)", async () => {
    const asked: { place: string; proximity?: [number, number] }[] = [];
    const turn = createTurn({
      question: "Beginner sport climbing at Red Rock near Las Vegas",
      geocoder: async (place, opts) => {
        asked.push({ place, ...(opts?.proximity && { proximity: opts.proximity }) });
        return place === "Las Vegas" ? at("Las Vegas, Nevada", [-115.14, 36.17]) : at("Red Rock Canyon, Nevada", [-115.43, 36.13]);
      },
    });
    await turn.lookup("Red Rock Canyon National Conservation Area");
    expect(asked).toEqual([{ place: "Las Vegas" }, { place: "Red Rock Canyon National Conservation Area", proximity: [-115.14, 36.17] }]);
  });

  it("biases a second lookup toward the place found first, and the view over both", async () => {
    const asked: ([number, number] | undefined)[] = [];
    const turn = createTurn({ question: "Where can I camp along the Wonderland Trail?", geocoder: async (_p, opts) => (asked.push(opts?.proximity), at("Mount Rainier", [-121.76, 46.85])) });
    turn.places.push(at("Mount Rainier", [-121.76, 46.85]));
    await turn.lookup("Wonderland Trail");
    expect(asked).toEqual([[-121.76, 46.85]]);
    const viewed = createTurn({ question: "Red Rock near Las Vegas", view: { bbox: [-116, 35, -115, 37], zoom: 8, center: [-115.5, 36] }, geocoder: async (_p, opts) => (asked.push(opts?.proximity), at("x", [0, 0])) });
    await viewed.lookup("Red Rock");
    expect(asked.at(-1)).toEqual([-115.5, 36]);
  });

  it("finds the national forest a bare name means when the question is about land", async () => {
    const regions = async (name: string) => (name === "Medicine Bow National Forest" ? { ...at("Medicine Bow National Forest", [-106.3, 41.28]), bbox: [-106.9, 40.7, -105.7, 41.8] as [number, number, number, number], source: "wikidata" as const } : null);
    const turn = createTurn({ question: "Where did beetles kill trees in the Medicine Bow since 2020?", geocoder: async () => at("Medicine Bow, Wyoming", [-106.2, 41.9]), regions });
    expect(await turn.lookup("Medicine Bow")).toMatchObject({ name: "Medicine Bow National Forest", source: "wikidata" });
    const town = createTurn({ question: "Restaurants in Medicine Bow", geocoder: async () => at("Medicine Bow, Wyoming", [-106.2, 41.9]), regions });
    expect(await town.lookup("Medicine Bow")).toMatchObject({ name: "Medicine Bow, Wyoming" });
  });
});
