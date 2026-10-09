// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBundle, MAX_LOOSE_FILES, type ExportBundle } from "@/lib/export/exportView";

const file = (name: string) => ({ name, blob: new Blob([name]) });

afterEach(() => vi.restoreAllMocks());

describe("downloadBundle", () => {
  function stubDownloads() {
    const names: string[] = [];
    // jsdom has no object URLs; every anchor click is stubbed so no real download starts.
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    return names;
  }

  it("downloads nothing until it is called, then one anchor click per file", async () => {
    const names = stubDownloads();
    const bundle: ExportBundle = { files: [file("a.geojson"), file("citations.md")] };
    expect(names).toEqual([]);
    expect(await downloadBundle(bundle)).toEqual(["a.geojson", "citations.md"]);
    expect(names).toEqual(["a.geojson", "citations.md"]);
  });

  it("packs more than the loose-file limit into a single zip download", async () => {
    const names = stubDownloads();
    const files = Array.from({ length: MAX_LOOSE_FILES + 1 }, (_, i) => file(`l${i}.geojson`));
    const out = await downloadBundle({ files }, new Date("2026-10-09T12:00:00Z"));
    expect(out).toEqual(["wallymap-export-2026-10-09.zip"]);
    expect(names).toEqual(["wallymap-export-2026-10-09.zip"]);
  });
});
