import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";

const userMessage = {
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "show trails near Lake Tahoe" }],
};

function post(body: string): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /api/chat", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 400 for a body that is not JSON", async () => {
    const res = await POST(post("not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request body" });
  });

  it("returns 400 when messages is not an array", async () => {
    const res = await POST(post(JSON.stringify({ messages: "hi" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request body" });
  });

  it("returns 413 when the request carries more than 40 messages", async () => {
    const messages = Array.from({ length: 41 }, (_, i) => ({ ...userMessage, id: `m${i}` }));
    const res = await POST(post(JSON.stringify({ messages })));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request too large" });
  });

  it("returns 413 when the raw body exceeds 256 KB", async () => {
    const big = { ...userMessage, parts: [{ type: "text", text: "x".repeat(256 * 1024) }] };
    const res = await POST(post(JSON.stringify({ messages: [big] })));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request too large" });
  });

  it("returns 413 when the messages carry more than 60,000 characters of text", async () => {
    const long = { ...userMessage, parts: [{ type: "text", text: "x".repeat(60_001) }] };
    const res = await POST(post(JSON.stringify({ messages: [long] })));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request too large" });
  });

  it("returns 429 with Retry-After once a caller passes RATE_LIMIT_CHAT, before reading the body", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("RATE_LIMIT_CHAT", "2");
    const from = (body: string) => {
      const req = post(body);
      req.headers.set("x-forwarded-for", "198.51.100.3");
      return req;
    };
    expect((await POST(from("not json"))).status).toBe(400);
    expect((await POST(from("not json"))).status).toBe(400);
    const limited = await POST(from("not json"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: "Too many requests" });
  });

  it("returns 500 naming the missing env var when MODEL_NAME is unset", async () => {
    vi.stubEnv("MODEL_NAME", "");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const res = await POST(post(JSON.stringify({ messages: [userMessage] })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "MODEL_NAME is required" });
  });
});
