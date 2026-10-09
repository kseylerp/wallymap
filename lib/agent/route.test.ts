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

  it("returns 500 naming the missing env var when MODEL_NAME is unset", async () => {
    vi.stubEnv("MODEL_NAME", "");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const res = await POST(post(JSON.stringify({ messages: [userMessage] })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "MODEL_NAME is required" });
  });
});
