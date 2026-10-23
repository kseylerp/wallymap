import { createVerify } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessToken, adcPath, clearTokenCache, credentialsFromJson, EeAuthError, loadCredentials, REFRESH_MARGIN_MS, serviceAccountAssertion, tokenRequestBody, type ServiceAccount } from "./auth";
import { testEnv, testKeyPair } from "./__fixtures__/fakeEe";

const sa = (): ServiceAccount => credentialsFromJson(JSON.parse(testEnv().EE_SERVICE_ACCOUNT_JSON)) as ServiceAccount;

describe("Earth Engine credentials", () => {
  beforeEach(() => clearTokenCache());

  it("reads a service account key and an authorized_user file, and nothing else", () => {
    expect(sa()).toMatchObject({ kind: "service_account", clientEmail: "wallymap-ee@wally-14e22.iam.gserviceaccount.com" });
    expect(credentialsFromJson({ type: "authorized_user", client_id: "id", client_secret: "s", refresh_token: "r" })).toMatchObject({ kind: "authorized_user", tokenUri: "https://oauth2.googleapis.com/token" });
    expect(credentialsFromJson({ type: "authorized_user", client_id: "id" })).toBeNull();
    expect(credentialsFromJson({ type: "external_account" })).toBeNull();
    expect(credentialsFromJson(null)).toBeNull();
  });

  it("prefers EE_SERVICE_ACCOUNT_JSON, falls back to the local ADC file, and says so plainly when the key is bad", () => {
    const readFile = vi.fn(() => JSON.stringify({ type: "authorized_user", client_id: "id", client_secret: "s", refresh_token: "r" }));
    expect(loadCredentials(testEnv(), readFile)?.kind).toBe("service_account");
    expect(readFile).not.toHaveBeenCalled();
    expect(loadCredentials({}, readFile)?.kind).toBe("authorized_user");
    expect(readFile).toHaveBeenCalledWith(adcPath({}));
    expect(adcPath({ GOOGLE_APPLICATION_CREDENTIALS: "/k.json" })).toBe("/k.json");
    expect(loadCredentials({}, () => { throw new Error("ENOENT"); })).toBeNull();
    expect(() => loadCredentials({ EE_SERVICE_ACCOUNT_JSON: "{not json" })).toThrow(EeAuthError);
    expect(() => loadCredentials({ EE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: "authorized_user", client_id: "a", client_secret: "b", refresh_token: "c" }) })).toThrow(/not a service account/);
    // The error never repeats the value it was given.
    try {
      loadCredentials({ EE_SERVICE_ACCOUNT_JSON: "{secret-material" });
    } catch (e) {
      expect(String(e)).not.toContain("secret-material");
    }
  });

  it("signs an RS256 JWT for Earth Engine that the key's public half verifies", () => {
    const jwt = serviceAccountAssertion(sa(), Date.UTC(2026, 9, 23, 12));
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const c = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(c).toMatchObject({ iss: sa().clientEmail, aud: "https://oauth2.googleapis.com/token" });
    expect(c.scope).toContain("https://www.googleapis.com/auth/earthengine");
    expect(c.exp - c.iat).toBe(3600);
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${claims}`);
    expect(verify.verify(testKeyPair().publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(tokenRequestBody(sa(), Date.now()).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(tokenRequestBody({ kind: "authorized_user", clientId: "i", clientSecret: "s", refreshToken: "r", tokenUri: "u" }, 0).get("grant_type")).toBe("refresh_token");
  });

  it("keeps a token until five minutes before it expires, and shares one request between callers", async () => {
    let now = 1_000_000;
    let n = 0;
    const fetch = vi.fn(async () => Response.json({ access_token: `t${++n}`, expires_in: 3600 })) as unknown as typeof globalThis.fetch;
    const [a, b] = await Promise.all([accessToken(sa(), { fetch, now: () => now }), accessToken(sa(), { fetch, now: () => now })]);
    expect([a, b]).toEqual(["t1", "t1"]);
    now += 3600_000 - REFRESH_MARGIN_MS - 1;
    expect(await accessToken(sa(), { fetch, now: () => now })).toBe("t1");
    now += 2;
    expect(await accessToken(sa(), { fetch, now: () => now })).toBe("t2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("names a refused credential by kind and Google's code, never by its value", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 })) as unknown as typeof globalThis.fetch;
    const user = { kind: "authorized_user" as const, clientId: "i", clientSecret: "shh", refreshToken: "refresh-secret", tokenUri: "https://oauth2.googleapis.com/token" };
    await expect(accessToken(user, { fetch })).rejects.toThrow("Google refused the Earth Engine local credentials (400: invalid_grant).");
    await expect(accessToken(user, { fetch })).rejects.not.toThrow(/refresh-secret|shh/);
  });
});
