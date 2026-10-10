import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildChatBody, viewFromCamera, type MapView } from "./view";

const userMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "What fires are here?" }] } as UIMessage;
const tahoe: MapView = { bbox: [-120.2, 38.9, -119.8, 39.3], zoom: 10.5, center: [-120, 39.1] };

describe("buildChatBody", () => {
  it("carries the current view beside the messages", () => {
    const body = buildChatBody({ id: "wildmap", messages: [userMessage], body: undefined, trigger: "submit-message", messageId: undefined }, tahoe);
    expect(body).toMatchObject({ id: "wildmap", trigger: "submit-message", view: tahoe });
    expect(body.messages).toEqual([userMessage]);
    expect(JSON.stringify(body.messages)).not.toContain("bbox");
  });

  it("leaves view out when the map has none", () => {
    const body = buildChatBody({ id: "wildmap", messages: [userMessage], body: undefined, trigger: "submit-message", messageId: undefined }, null);
    expect(body).not.toHaveProperty("view");
  });
});

describe("viewFromCamera", () => {
  const points: [number, number][] = [
    [-120.3, 39.4],
    [-119.7, 39.4],
    [-120.3, 38.8],
    [-119.7, 38.8],
  ];

  it("boxes the sample points", () => {
    expect(viewFromCamera({ center: [-120, 39.1], zoom: 10, points }).bbox).toEqual([-120.3, 38.8, -119.7, 39.4]);
  });

  it("trims the box to the map's own bounds (a pitched camera's horizon)", () => {
    const bounds: [number, number, number, number] = [-120.2, 38.9, -119.8, 39.3];
    expect(viewFromCamera({ center: [-120, 39.1], zoom: 10, points, bounds }).bbox).toEqual(bounds);
  });

  it("sends no bbox at globe zoom", () => {
    const view = viewFromCamera({ center: [-100, 40], zoom: 2.4, points });
    expect(view.bbox).toBeNull();
    expect(view.zoom).toBe(2.4);
  });

  it("keeps a box across the antimeridian on the camera's side", () => {
    const fiji: [number, number][] = [
      [178, -16],
      [-179, -16],
      [178, -19],
      [-179, -19],
    ];
    expect(viewFromCamera({ center: [179.5, -17.5], zoom: 6, points: fiji }).bbox).toEqual([178, -19, 180, -16]);
  });
});
