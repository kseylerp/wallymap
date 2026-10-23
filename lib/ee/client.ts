/**
 * A small Earth Engine REST client (https://developers.google.com/earth-engine/reference/rest): map tiles from
 * `maps.create`, values from `value:compute`. Credentials stay on the server (lib/ee/auth.ts); the browser only ever
 * sees our own tile route (app/api/ee/tiles). Every request is billed to the Cloud project in EE_PROJECT (default
 * wally-14e22) through the `x-goog-user-project` header.
 *
 * Failures come back as EeError with a `sourceStatus` (docs/layer-contract.md): a 5xx or an unreadable answer is
 * `server-error`, a 429 `rate-limited`, a timeout or no network `offline`, missing or refused credentials `offline` with
 * a message that says Earth Engine is not set up. Nothing here logs or returns a credential.
 */
import type { SourceFailure } from "@/layers/types";
import { sourceFailureForError, sourceFailureForStatus } from "@/lib/fetch";
import { accessToken, clearTokenCache, EeAuthError, loadCredentials, type EeCredentials } from "./auth";
import { toExpression, type EeNode } from "./expr";

export const EE_API = "https://earthengine.googleapis.com/v1";
export const DEFAULT_EE_PROJECT = "wally-14e22";

/**
 * How long a map id is used before a new one is made. Earth Engine does not publish a lifetime for map ids; they have
 * lasted well over a day in practice, and a tile that answers 404 or 400 makes a new one at once (see `tile`).
 */
export const MAP_TTL_MS = 6 * 3600_000;
/** A map id this close to its TTL is replaced on the next request, so a busy map never waits on an expiry. */
export const MAP_REFRESH_MARGIN_MS = 30 * 60_000;

export const TIMEOUTS = { map: 15_000, tile: 25_000, compute: 25_000 } as const;

export class EeError extends Error {
  override name = "EeError";
  constructor(
    message: string,
    readonly sourceStatus: SourceFailure,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type EeEnv = Record<string, string | undefined>;

export type EeClientOptions = {
  env?: EeEnv;
  fetch?: typeof fetch;
  now?: () => number;
  /** Injected credentials (tests); else read from env (EE_SERVICE_ACCOUNT_JSON) or the local ADC file. */
  credentials?: EeCredentials | null;
};

export type EeClient = {
  project: string;
  /** The `projects/<p>/maps/<id>` name for a visualized image, made once per `key` and reused until near its TTL. */
  mapName(key: string, image: EeNode): Promise<string>;
  /** One PNG tile of the map for `key` (made or reused), with one retry on a fresh map id when the old one is gone. */
  tile(key: string, image: EeNode, z: number, x: number, y: number): Promise<{ body: ArrayBuffer; contentType: string }>;
  /** Evaluates an expression (a number, a dictionary, a list) and returns its JSON `result`. */
  compute<T = unknown>(value: EeNode, timeoutMs?: number): Promise<T>;
};

/** True when credentials for Earth Engine exist on this server (the key in env, or local ADC). */
export function eeConfigured(env: EeEnv = process.env): boolean {
  try {
    return loadCredentials(env) !== null;
  } catch {
    return false;
  }
}

const notConfigured = (detail: string): EeError =>
  new EeError(`Google Earth Engine is not set up on this server: ${detail}`, {
    ok: false,
    reason: "offline",
    message: "Google Earth Engine is not set up on this server (no service account key), so this layer cannot draw.",
    since: new Date().toISOString(),
  });

type MapEntry = { name?: string; madeAt: number; pending?: Promise<string> };
/** Map ids by key, shared by every client in the process (the tile route makes a client per request). */
const maps = new Map<string, MapEntry>();

export function clearMapCache(): void {
  maps.clear();
}

export function createEeClient(opts: EeClientOptions = {}): EeClient {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const project = env.EE_PROJECT?.trim() || DEFAULT_EE_PROJECT;

  let creds: EeCredentials | null | undefined = opts.credentials;
  const credentials = (): EeCredentials => {
    if (creds === undefined) {
      try {
        creds = loadCredentials(env);
      } catch (error) {
        throw notConfigured(error instanceof Error ? error.message : "bad credentials");
      }
    }
    if (!creds) throw notConfigured("set EE_SERVICE_ACCOUNT_JSON (docs/earth-engine.md)");
    return creds;
  };

  async function headers(): Promise<Record<string, string>> {
    let token: string;
    try {
      token = await accessToken(credentials(), { fetch: fetchImpl, now });
    } catch (error) {
      if (error instanceof EeError) throw error;
      if (error instanceof EeAuthError) throw notConfigured(error.message);
      throw new EeError("Google's token service could not be reached.", sourceFailureForError(error, "https://oauth2.googleapis.com/token"));
    }
    return { authorization: `Bearer ${token}`, "x-goog-user-project": project };
  }

  /** One authorised request with a timeout; non-2xx answers become EeError with the status's sourceStatus. */
  async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...(await headers()) }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error instanceof EeError) throw error;
      throw new EeError(`Earth Engine did not answer (${error instanceof Error ? error.name : "error"}).`, sourceFailureForError(error, url));
    }
    if (res.ok) return res;
    if (res.status === 401) clearTokenCache();
    const text = await res.text().catch(() => "");
    let detail = "";
    try {
      detail = String((JSON.parse(text) as { error?: { message?: unknown } }).error?.message ?? "");
    } catch {
      detail = text.slice(0, 200);
    }
    const status: SourceFailure = sourceFailureForStatus(res.status, url) ?? {
      ok: false,
      reason: "server-error",
      message: `Earth Engine refused the request (${res.status}).`,
      since: new Date(now()).toISOString(),
    };
    throw new EeError(`Earth Engine ${res.status}: ${detail}`.trim(), status, res.status);
  }

  async function createMap(image: EeNode): Promise<string> {
    const res = await request(
      `${EE_API}/projects/${project}/maps`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expression: toExpression(image), fileFormat: "PNG" }) },
      TIMEOUTS.map,
    );
    const body = (await res.json().catch(() => ({}))) as { name?: unknown };
    if (typeof body.name !== "string" || !body.name.startsWith("projects/")) {
      throw new EeError("Earth Engine made no map id.", { ok: false, reason: "server-error", message: "Earth Engine's map service returned no map.", since: new Date(now()).toISOString() });
    }
    return body.name;
  }

  async function mapName(key: string, image: EeNode, fresh = false): Promise<string> {
    let entry = maps.get(key);
    const usable = entry?.name !== undefined && !fresh && now() - entry.madeAt < MAP_TTL_MS - MAP_REFRESH_MARGIN_MS;
    if (usable) return entry!.name!;
    if (entry?.pending) return entry.pending;
    entry = { ...(entry ?? { madeAt: 0 }) };
    maps.set(key, entry);
    const made = entry;
    made.pending = createMap(image).then(
      (name) => {
        made.name = name;
        made.madeAt = now();
        made.pending = undefined;
        return name;
      },
      (error: unknown) => {
        made.pending = undefined;
        throw error;
      },
    );
    return made.pending;
  }

  async function tile(key: string, image: EeNode, z: number, x: number, y: number) {
    for (const fresh of [false, true]) {
      const name = await mapName(key, image, fresh);
      try {
        const res = await request(`${EE_API}/${name}/tiles/${z}/${x}/${y}`, { method: "GET" }, TIMEOUTS.tile);
        return { body: await res.arrayBuffer(), contentType: res.headers.get("content-type") ?? "image/png" };
      } catch (error) {
        // A map id Earth Engine no longer knows answers 404 (or 400): make a new one once.
        const gone = error instanceof EeError && (error.status === 404 || error.status === 400);
        if (!gone || fresh) throw error;
      }
    }
    throw new Error("unreachable");
  }

  async function compute<T>(value: EeNode, timeoutMs: number = TIMEOUTS.compute): Promise<T> {
    const res = await request(
      `${EE_API}/projects/${project}/value:compute`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expression: toExpression(value) }) },
      timeoutMs,
    );
    const body = (await res.json().catch(() => undefined)) as { result?: T } | undefined;
    if (!body || !("result" in body)) {
      throw new EeError("Earth Engine returned no result.", { ok: false, reason: "server-error", message: "Earth Engine returned no result.", since: new Date(now()).toISOString() });
    }
    return body.result as T;
  }

  return { project, mapName: (key, image) => mapName(key, image), tile, compute };
}
