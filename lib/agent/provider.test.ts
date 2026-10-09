import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "@/lib/agent/provider";

type ModelInfo = { modelId: string; provider: string };

function info(model: unknown): ModelInfo {
  return model as ModelInfo;
}

describe("getModel", () => {
  beforeEach(() => {
    vi.stubEnv("MODEL_PROVIDER", "");
    vi.stubEnv("MODEL_NAME", "anthropic/claude-haiku-5-5");
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to an OpenRouter model named by MODEL_NAME", () => {
    const model = info(getModel());
    expect(model.modelId).toBe("anthropic/claude-haiku-5-5");
    expect(model.provider).toMatch(/^openrouter/);
  });

  it("treats MODEL_PROVIDER=openrouter the same as unset", () => {
    vi.stubEnv("MODEL_PROVIDER", "openrouter");
    expect(info(getModel()).provider).toMatch(/^openrouter/);
  });

  it("requires OPENROUTER_API_KEY for the default provider", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => getModel()).toThrow("OPENROUTER_API_KEY is required");
  });

  it("returns an Anthropic model when MODEL_PROVIDER=anthropic", () => {
    vi.stubEnv("MODEL_PROVIDER", "anthropic");
    vi.stubEnv("MODEL_NAME", "claude-sonnet-5-5");
    const model = info(getModel());
    expect(model.modelId).toBe("claude-sonnet-5-5");
    expect(model.provider).toMatch(/^anthropic/);
  });

  it("requires a base URL for openai-compatible", () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-compatible");
    expect(() => getModel()).toThrow("OPENAI_COMPATIBLE_BASE_URL is required");
  });

  it("returns an openai-compatible model when the base URL is set", () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-compatible");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("MODEL_NAME", "qwen3");
    const model = info(getModel());
    expect(model.modelId).toBe("qwen3");
    expect(model.provider).toMatch(/^open/);
  });

  it("rejects an unknown provider with the exact message", () => {
    vi.stubEnv("MODEL_PROVIDER", "gemini");
    expect(() => getModel()).toThrow(
      "MODEL_PROVIDER must be openrouter, anthropic, or openai-compatible",
    );
  });

  it("requires MODEL_NAME", () => {
    vi.stubEnv("MODEL_NAME", "");
    expect(() => getModel()).toThrow("MODEL_NAME is required");
  });
});
