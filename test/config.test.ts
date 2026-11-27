import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openAIClientOptions, readConfig } from "../src/config";

describe("provider configuration", () => {
  it("keeps the official OpenAI host when OPENAI_BASE_URL is unset", () => {
    const config = readConfig({
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "gpt-6.2-astra",
    });

    assert.deepEqual(config, {
      apiKey: "test-key",
      model: "gpt-6.2-astra",
    });
    assert.deepEqual(openAIClientOptions(config), {
      apiKey: "test-key",
      maxRetries: 0,
    });
  });

  it("points the same client at OpenRouter when OPENAI_BASE_URL is set", () => {
    const config = readConfig({
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "openai/gpt-4o-mini",
      OPENAI_BASE_URL: " https://openrouter.ai/api/v1 ",
    });

    assert.equal(config.baseURL, "https://openrouter.ai/api/v1");
    assert.deepEqual(openAIClientOptions(config), {
      apiKey: "test-key",
      maxRetries: 0,
      baseURL: "https://openrouter.ai/api/v1",
    });
  });

  it("treats a blank base URL as the official API and does not invent a model", () => {
    const config = readConfig({
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "gpt-6.2-astra",
      OPENAI_BASE_URL: "   ",
    });

    assert.equal(config.model, "gpt-6.2-astra");
    assert.equal("baseURL" in config, false);
    assert.equal(openAIClientOptions(config).maxRetries, 0);
  });

  it("rejects a missing model and a placeholder key", () => {
    assert.throws(
      () => readConfig({ OPENAI_API_KEY: "test-key" }),
      /Set OPENAI_MODEL/,
    );
    assert.throws(
      () => readConfig({ OPENAI_API_KEY: "replace-me", OPENAI_MODEL: "gpt-6.2-astra" }),
      /Set OPENAI_API_KEY/,
    );
  });
});
