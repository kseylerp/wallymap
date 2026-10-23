import { describe, expect, it } from "vitest";
import { call, constant, constantImage, eq, loadCollection, mosaic, reduceBands, toExpression, unmask, visualize } from "./expr";

describe("Earth Engine expressions", () => {
  it("writes calls with constants for plain arguments and leaves undefined ones out", () => {
    expect(call("Image.select", { input: constant(1), bandSelectors: ["a"], newNames: undefined })).toEqual({
      functionInvocationValue: { functionName: "Image.select", arguments: { input: { constantValue: 1 }, bandSelectors: { constantValue: ["a"] } } },
    });
    // Image.unmask takes an image for its value.
    expect(JSON.stringify(unmask(constant(0), 0))).toContain('"value":{"functionInvocationValue":{"functionName":"Image.constant"');
    expect(JSON.stringify(visualize(constant(0), { min: 1, max: 6, palette: ["#9FB693"] }))).toContain('"palette":{"constantValue":["9FB693"]}');
  });

  it("sends a subtree used twice once, under a reference", () => {
    const stack = mosaic(loadCollection("projects/x/assets/c"));
    const expr = toExpression(eq(stack, reduceBands(stack, "max")));
    expect(expr.result).toBe("0");
    const wire = JSON.stringify(expr);
    expect(wire.match(/ImageCollection\.load/g)).toHaveLength(1);
    expect(wire.match(/valueReference/g)).toHaveLength(2);
    const [ref] = Object.keys(expr.values).filter((k) => k !== "0");
    expect(JSON.stringify(expr.values[ref])).toContain("ImageCollection.mosaic");
  });

  it("leaves a tree with nothing shared as one value", () => {
    const expr = toExpression(eq(constantImage(1), constantImage(2)));
    expect(Object.keys(expr.values)).toEqual(["0"]);
  });
});
