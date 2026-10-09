import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Resolves the chat model from server env. MODEL_PROVIDER picks the backend
 * (openrouter by default) and MODEL_NAME is always required; there is no
 * silent default model.
 */
export function getModel(): LanguageModel {
  const modelName = process.env.MODEL_NAME;
  if (!modelName) {
    throw new Error("MODEL_NAME is required");
  }

  const provider = process.env.MODEL_PROVIDER || "openrouter";
  switch (provider) {
    case "openrouter": {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is required");
      }
      return createOpenAICompatible({ name: "openrouter", baseURL: OPENROUTER_BASE_URL, apiKey })(
        modelName,
      );
    }
    case "anthropic":
      return anthropic(modelName);
    case "openai-compatible": {
      const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
      if (!baseURL) {
        throw new Error("OPENAI_COMPATIBLE_BASE_URL is required");
      }
      return createOpenAICompatible({
        name: "open",
        baseURL,
        apiKey: process.env.OPENAI_COMPATIBLE_API_KEY || undefined,
      })(modelName);
    }
    default:
      throw new Error("MODEL_PROVIDER must be openrouter, anthropic, or openai-compatible");
  }
}
