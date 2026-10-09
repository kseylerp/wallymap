import { afterEach, describe, expect, it, vi } from "vitest";
import { createBucket } from "./bucket";

describe("createBucket", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks the sixth call until refill", async () => {
    vi.useFakeTimers();
    const bucket = createBucket({ capacity: 5, refillPerSecond: 1 });
    for (let i = 0; i < 5; i++) await bucket.take();

    let sixthResolved = false;
    const sixth = bucket.take().then(() => {
      sixthResolved = true;
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(sixthResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await sixth;
    expect(sixthResolved).toBe(true);
  });
});
