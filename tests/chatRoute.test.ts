import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";

const post = (body: unknown, ip: string) =>
  POST(
    new Request("https://x.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );

const text = (t: string) => ({ id: "u", role: "user", parts: [{ type: "text", text: t }] });

describe("POST /api/chat caps", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers 413 for too many messages or too much text", async () => {
    const many = await post({ messages: Array.from({ length: 41 }, () => text("hi")) }, "198.51.100.1");
    expect(many.status).toBe(413);
    const long = await post({ messages: [text("x".repeat(60_001))] }, "198.51.100.2");
    expect(long.status).toBe(413);
  });

  it("answers 429 with Retry-After once a caller passes RATE_LIMIT_CHAT", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("RATE_LIMIT_CHAT", "2");
    const ip = "198.51.100.3";
    // Invalid bodies still count: the limit runs before the body is read.
    expect((await post({}, ip)).status).toBe(400);
    expect((await post({}, ip)).status).toBe(400);
    const limited = await post({}, ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: "Too many requests" });
  });
});
