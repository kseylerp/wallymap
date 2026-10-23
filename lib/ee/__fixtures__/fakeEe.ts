/**
 * Test doubles for Earth Engine: a throwaway service account key (generated per run, never a real one) and a fetch
 * that plays Google's token service and the Earth Engine REST API from recorded answers (forest-types.json).
 */
import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";

let key: { privateKey: string; publicKey: string } | undefined;

/** A generated RSA key pair, made once per test file. */
export function testKeyPair(): { privateKey: string; publicKey: string } {
  key ??= generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return key;
}

/** Env with a generated service account key, as production sets it. */
export function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  const json = JSON.stringify({ type: "service_account", client_email: "wallymap-ee@wally-14e22.iam.gserviceaccount.com", private_key: testKeyPair().privateKey, token_uri: "https://oauth2.googleapis.com/token" });
  return { EE_PROJECT: "wally-14e22", EE_SERVICE_ACCOUNT_JSON: json, ...extra };
}

export type EeCall = { url: string; method: string; body?: unknown; headers: Record<string, string> };

/**
 * A fetch for Google's token endpoint and Earth Engine: tokens always succeed; `compute` answers value:compute (by the
 * parsed expression), `tile` answers tile GETs, maps.create returns a numbered map id. Every call is recorded.
 */
export function fakeEeFetch(handlers: {
  compute?: (expression: unknown) => unknown;
  tile?: (url: string) => Response;
  map?: () => Response;
}) {
  const calls: EeCall[] = [];
  let maps = 0;
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" && headers["content-type"] === "application/json" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method: init?.method ?? "GET", body, headers });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "ya29.test-token", expires_in: 3599, token_type: "Bearer" });
    }
    if (url.endsWith("/value:compute")) {
      const result = handlers.compute?.((body as { expression: unknown }).expression);
      return result instanceof Response ? result : Response.json({ result });
    }
    if (/\/maps$/.test(url)) {
      if (handlers.map) return handlers.map();
      maps += 1;
      return Response.json({ name: `projects/wally-14e22/maps/map${maps}` });
    }
    if (/\/tiles\/\d+\/\d+\/\d+$/.test(url)) {
      return handlers.tile ? handlers.tile(url) : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** The function names an expression calls, in wire order (to tell which recorded answer a request wants). */
export function functionNames(expression: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const fi = (v as { functionInvocationValue?: { functionName: string; arguments: Record<string, unknown> } }).functionInvocationValue;
    if (fi) out.push(fi.functionName);
    for (const child of Object.values(v as Record<string, unknown>)) walk(child);
  };
  walk(expression);
  return out;
}
