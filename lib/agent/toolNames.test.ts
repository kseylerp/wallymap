import { describe, expect, it } from "vitest";

describe("canonicalLayerId", () => {
  it("reads a query tool's name as its layer and cuts template junk", async () => {
    const { canonicalLayerId } = await import("./toolNames");
    const ids = ["peaks", "outdoor-features", "climbing"];
    expect(canonicalLayerId("query_peaks", ids)).toBe("peaks");
    expect(canonicalLayerId("climbing<|channel|>commentary", ids)).toBe("climbing");
    expect(canonicalLayerId("outdoor-features", ids)).toBe("outdoor-features");
    expect(canonicalLayerId("walking-route-123", ids)).toBe("walking-route-123");
  });
});
