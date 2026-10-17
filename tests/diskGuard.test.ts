import { describe, expect, it, vi } from "vitest";
import { RUN_MIN_FREE, sizeText, watchDisk } from "@/scripts/diskGuard";

const GB = 1024 ** 3;

describe("disk guard", () => {
  it("keeps the lowest free space, reports the peak used, and calls onLow once under 2 GB", () => {
    const frees = [10 * GB, 8.5 * GB, 1.5 * GB, 1 * GB];
    const onLow = vi.fn();
    const guard = watchDisk(onLow, 60_000, () => frees.shift() ?? 9 * GB);
    expect(guard.low()).toBe(false);
    guard.sample();
    expect(guard.low()).toBe(false);
    guard.sample();
    guard.sample();
    expect(guard.low()).toBe(true);
    expect(onLow).toHaveBeenCalledTimes(1);
    expect(onLow).toHaveBeenCalledWith(1.5 * GB);
    expect(guard.report()).toBe("disk used at peak 9.0 GB (free 10.0 GB at the start, 1.0 GB at the lowest)");
    guard.stop();
    expect(RUN_MIN_FREE).toBe(2 * GB);
  });

  it("writes sizes in GB or MB", () => {
    expect(sizeText(1.24 * GB)).toBe("1.2 GB");
    expect(sizeText(340 * 1024 ** 2)).toBe("340 MB");
  });
});
