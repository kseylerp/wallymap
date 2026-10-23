/**
 * Google OAuth access tokens for the Earth Engine REST API, without the Google SDKs.
 *
 * Two kinds of credentials:
 *   - production: a service account key, the JSON Google issues, in the env var EE_SERVICE_ACCOUNT_JSON. The server
 *     signs a JWT with the key (RS256) and trades it for an access token (the "JWT bearer" grant).
 *   - local: the application default credentials `gcloud auth application-default login` writes
 *     (~/.config/gcloud/application_default_credentials.json, or the file GOOGLE_APPLICATION_CREDENTIALS names), an
 *     `authorized_user` with a refresh token, traded for an access token (the "refresh token" grant). A service account
 *     file there works too.
 *
 * Tokens live an hour; one is kept per credential in memory and replaced five minutes before it expires. Nothing here
 * ever logs or returns a key, a refresh token or an access token in an error message.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Earth Engine reads and computes; cloud-platform covers the user project header (x-goog-user-project). */
export const EE_SCOPES = ["https://www.googleapis.com/auth/earthengine", "https://www.googleapis.com/auth/cloud-platform"];
/** A token is replaced this long before Google says it expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export type ServiceAccount = { kind: "service_account"; clientEmail: string; privateKey: string; tokenUri: string };
export type AuthorizedUser = { kind: "authorized_user"; clientId: string; clientSecret: string; refreshToken: string; tokenUri: string };
export type EeCredentials = ServiceAccount | AuthorizedUser;

/** Thrown when no credentials are set up or Google refuses them; `message` never holds a secret. */
export class EeAuthError extends Error {
  override name = "EeAuthError";
}

/** Credentials from one parsed Google credentials JSON (a service account key or an authorized_user file), or null. */
export function credentialsFromJson(json: unknown): EeCredentials | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : undefined);
  const tokenUri = str("token_uri") ?? TOKEN_URI;
  if (o.type === "service_account") {
    const clientEmail = str("client_email");
    const privateKey = str("private_key");
    return clientEmail && privateKey ? { kind: "service_account", clientEmail, privateKey, tokenUri } : null;
  }
  if (o.type === "authorized_user") {
    const clientId = str("client_id");
    const clientSecret = str("client_secret");
    const refreshToken = str("refresh_token");
    return clientId && clientSecret && refreshToken ? { kind: "authorized_user", clientId, clientSecret, refreshToken, tokenUri } : null;
  }
  return null;
}

/** Where gcloud keeps the application default credentials. */
export function adcPath(env: Record<string, string | undefined>): string {
  return env.GOOGLE_APPLICATION_CREDENTIALS || join(homedir(), ".config", "gcloud", "application_default_credentials.json");
}

/**
 * The credentials this server runs with: EE_SERVICE_ACCOUNT_JSON when set (a bad value is an error, never a silent
 * fallback), else the local application default credentials file, else null (Earth Engine is not set up here).
 * `readFile` is injectable for tests.
 */
export function loadCredentials(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): EeCredentials | null {
  const raw = env.EE_SERVICE_ACCOUNT_JSON?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new EeAuthError("EE_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole key file).");
    }
    const creds = credentialsFromJson(parsed);
    if (!creds || creds.kind !== "service_account") throw new EeAuthError("EE_SERVICE_ACCOUNT_JSON is not a service account key.");
    return creds;
  }
  let text: string;
  try {
    text = readFile(adcPath(env));
  } catch {
    return null;
  }
  try {
    return credentialsFromJson(JSON.parse(text));
  } catch {
    return null;
  }
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** The signed JWT a service account trades for an access token (RS256, one hour). */
export function serviceAccountAssertion(sa: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.clientEmail, scope: EE_SCOPES.join(" "), aud: sa.tokenUri, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(sa.privateKey).toString("base64url")}`;
}

/** The form body for the token request of either kind. */
export function tokenRequestBody(creds: EeCredentials, nowMs: number): URLSearchParams {
  if (creds.kind === "service_account") {
    return new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(creds, nowMs) });
  }
  return new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
  });
}

type Token = { accessToken: string; expiresAt: number };
const tokens = new Map<string, { token?: Token; pending?: Promise<Token> }>();

/** A key for the token cache that is not itself a secret. */
function credentialKey(creds: EeCredentials): string {
  return creds.kind === "service_account" ? `sa:${creds.clientEmail}` : `user:${creds.clientId}:${creds.refreshToken.slice(-6)}`;
}

/** Forgets every cached token (tests, and a 401 from Earth Engine). */
export function clearTokenCache(): void {
  tokens.clear();
}

export type TokenOptions = { fetch?: typeof fetch; now?: () => number; timeoutMs?: number };

/**
 * An access token for `creds`: the cached one while it has more than five minutes left, else a new one (one request
 * at a time per credential; callers waiting meanwhile share it).
 */
export async function accessToken(creds: EeCredentials, opts: TokenOptions = {}): Promise<string> {
  const now = opts.now ?? Date.now;
  const key = credentialKey(creds);
  const entry = tokens.get(key) ?? {};
  tokens.set(key, entry);
  if (entry.token && entry.token.expiresAt - REFRESH_MARGIN_MS > now()) return entry.token.accessToken;
  if (!entry.pending) {
    entry.pending = requestToken(creds, opts.fetch ?? fetch, now(), opts.timeoutMs ?? 10_000).then(
      (token) => {
        entry.token = token;
        entry.pending = undefined;
        return token;
      },
      (error: unknown) => {
        entry.pending = undefined;
        throw error;
      },
    );
  }
  return (await entry.pending).accessToken;
}

async function requestToken(creds: EeCredentials, fetchImpl: typeof fetch, nowMs: number, timeoutMs: number): Promise<Token> {
  const res = await fetchImpl(creds.tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody(creds, nowMs).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: unknown };
  if (!res.ok || typeof body.access_token !== "string") {
    // Google's error code ("invalid_grant") is safe to repeat; the body never echoes the secret back.
    const code = typeof body.error === "string" ? `: ${body.error}` : "";
    throw new EeAuthError(`Google refused the Earth Engine ${creds.kind === "service_account" ? "service account" : "local"} credentials (${res.status}${code}).`);
  }
  const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { accessToken: body.access_token, expiresAt: nowMs + seconds * 1000 };
}
