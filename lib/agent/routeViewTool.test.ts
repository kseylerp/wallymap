import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  tools: undefined as Record<string, { execute?: (input: unknown, options: unknown) => Promise<unknown> }> | undefined,
  routeCalls: [] as { input: unknown; deps: unknown }[],
}));

// Capture the tools the route builds instead of calling a model, and what the route tool is run with.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (options: { tools: NonNullable<typeof captured.tools> }) => {
      captured.tools = options.tools;
      return { toUIMessageStreamResponse: () => new Response("ok") };
    },
  };
});
vi.mock("@/lib/agent/route", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/route")>();
  return {
    ...actual,
    runRouteTool: async (input: unknown, deps: unknown) => {
      captured.routeCalls.push({ input, deps });
      return { error: "stubbed" };
    },
  };
});

const { POST } = await import("@/app/api/chat/route");

const userMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "Route Happy Isles to Nevada Fall" }] };
const view = { bbox: [-119.65, 37.68, -119.45, 37.78], zoom: 12, center: [-119.5578, 37.7313] };

function post(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the route tool's view", () => {
  beforeEach(() => {
    captured.tools = undefined;
    captured.routeCalls.length = 0;
    vi.stubEnv("MODEL_PROVIDER", "openrouter");
    vi.stubEnv("MODEL_NAME", "test-model");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs with the chat request's view", async () => {
    await POST(post({ messages: [userMessage], view }));
    await captured.tools!.route.execute!({ from: "Happy Isles", to: "Nevada Fall", via: "Mist Trail" }, {});
    expect(captured.routeCalls).toHaveLength(1);
    expect(captured.routeCalls[0].deps).toEqual({ view });
    expect(captured.routeCalls[0].input).toMatchObject({ via: "Mist Trail" });
  });

  it("runs with no view when the request sends none or a malformed one", async () => {
    for (const body of [{ messages: [userMessage] }, { messages: [userMessage], view: { zoom: "far" } }]) {
      captured.routeCalls.length = 0;
      await POST(post(body));
      await captured.tools!.route.execute!({ from: "a", to: "b" }, {});
      expect(captured.routeCalls[0].deps).toEqual({ view: null });
    }
  });
});
