/**
 * Body checks for `CachedFetch`'s `validate` option. Shared, long-lived cache entries (station lists, daily
 * files) must never store an upstream maintenance page, an empty list or a truncated file: each check parses
 * the body and asks for the minimal shape the layer needs.
 */

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** A JSON array with at least `minLength` items, each passing `item` when given. */
export function jsonArrayBody({ minLength = 1, item }: { minLength?: number; item?: (row: unknown) => boolean } = {}) {
  return (body: string): boolean => {
    const json = parseJson(body);
    if (!Array.isArray(json) || json.length < minLength) return false;
    return item === undefined || item(json[0]);
  };
}

/** A JSON object (not an array or null); with `listKey`, that key holds an array of at least `minLength` items. */
export function jsonObjectBody({ listKey, minLength = 1 }: { listKey?: string; minLength?: number } = {}) {
  return (body: string): boolean => {
    const json = parseJson(body);
    if (typeof json !== "object" || json === null || Array.isArray(json)) return false;
    if (listKey === undefined) return true;
    const list = (json as Record<string, unknown>)[listKey];
    return Array.isArray(list) && list.length >= minLength;
  };
}

/** Text that is at least `minChars` long and matches every marker (e.g. a file header or a root element). */
export function textBody({ markers, minChars = 1 }: { markers: RegExp[]; minChars?: number }) {
  return (body: string): boolean => body.length >= minChars && markers.every((m) => m.test(body));
}
