import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const css = read("app/globals.css");

/** The bodies of the `@media (max-width: …)` blocks under the md breakpoint. */
function phoneBlocks(): string[] {
  const out: string[] = [];
  const re = /@media \(max-width: ([\d.]+)px\) \{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (Number(m[1]) >= 768) continue;
    // Walk to the matching close brace.
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}

const px = (value: string) => Number(/^(\d+(?:\.\d+)?)px$/.exec(value.trim())?.[1] ?? NaN);

describe("iOS Safari on a phone", () => {
  it("never scrolls the page sideways", () => {
    // body hides sideways overflow; html must not, because an overflow rule on html turns it into a scroll
    // container on iOS Safari (broken toolbar collapse, blank band under the map).
    const bodyStart = css.indexOf("\nbody {\n  overflow-x");
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const htmlStart = css.indexOf("html,\nbody {");
    expect(htmlStart).toBeGreaterThanOrEqual(0);
    const htmlBlock = css.slice(htmlStart, css.indexOf("}", htmlStart));
    expect(htmlBlock).not.toMatch(/overflow-x/);
  });

  it("sizes the page to the dynamic viewport, with a fill-available fallback where dvh is missing", () => {
    const start = css.indexOf("html,\nbody {");
    expect(css.slice(start, css.indexOf("}", start))).toContain("height: 100dvh;");
    const fallback = css.indexOf("@supports not (height: 100dvh)");
    expect(fallback).toBeGreaterThan(0);
    expect(css.slice(fallback, css.indexOf("}", fallback))).toContain("height: -webkit-fill-available;");
  });

  it("gives every text field, textarea and select at least 16px at phone widths", () => {
    const blocks = phoneBlocks();
    const rule = blocks
      .flatMap((b) => [...b.matchAll(/([^{}]+)\{([^{}]*)\}/g)])
      .find(([, selector]) => /\binput\b/.test(selector) && /\btextarea\b/.test(selector) && /\bselect\b/.test(selector));
    expect(rule, "a phone rule covering input, textarea and select").toBeDefined();
    const [, selector, body] = rule!;
    const size = /font-size:\s*([^;]+);/.exec(body)?.[1] ?? "";
    expect(px(size)).toBeGreaterThanOrEqual(16);
    // Only controls that take no keyboard are left out.
    const excluded = [...selector.matchAll(/\[type="([a-z]+)"\]/g)].map((m) => m[1]);
    for (const type of ["text", "search", "email", "url", "tel", "password", "number", "date"]) {
      expect(excluded).not.toContain(type);
    }
  });

  it("keeps the chat input at 16px or more below the md breakpoint, whatever the stylesheet", () => {
    const chat = read("components/ChatRail.tsx");
    const input = chat.slice(chat.indexOf("<input"), chat.indexOf("/>", chat.indexOf("<input")));
    const base = /className="[^"]*?(?:^|\s)text-\[(\d+)px\]/.exec(input.replace(/\n/g, " "));
    expect(Number(base?.[1])).toBeGreaterThanOrEqual(16);
  });

  it("does not stop pinch-zoom with maximum-scale or user-scalable", () => {
    const layout = read("app/layout.tsx");
    expect(layout).not.toMatch(/maximumScale|maximum-scale|userScalable|user-scalable/);
  });

  it("keeps the right-hand map controls inside the screen edge", () => {
    expect(read("components/MapControls.tsx")).toContain("right-[max(12px,var(--safe-right))]");
  });

  it("measures the console's top from the app, not the viewport Safari may have panned", () => {
    const app = read("components/App.tsx");
    expect(app).toMatch(/getBoundingClientRect\(\)\.bottom - top/);
  });
});
