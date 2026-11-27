import type { ClientOptions } from "openai";

export type AppConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
};

/**
 * Read provider settings from the environment.
 * `OPENAI_BASE_URL` is optional. When it is absent, the OpenAI SDK keeps its
 * official API host. No model is substituted here.
 */
export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  const apiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const model = env.OPENAI_MODEL?.trim() ?? "";
  const baseURL = env.OPENAI_BASE_URL?.trim() ?? "";

  if (!apiKey || apiKey === "replace-me") {
    throw new Error("Set OPENAI_API_KEY. Copy .env.example to .env and add your key.");
  }

  if (!model) {
    throw new Error("Set OPENAI_MODEL. Copy .env.example to .env and choose a model.");
  }

  if (!baseURL) {
    return { apiKey, model };
  }

  return { apiKey, model, baseURL };
}

/** Official SDK options. Retries stay off. The base URL is set only when configured. */
export function openAIClientOptions(config: AppConfig): ClientOptions {
  const options: ClientOptions = {
    apiKey: config.apiKey,
    maxRetries: 0,
  };

  if (config.baseURL) {
    options.baseURL = config.baseURL;
  }

  return options;
}
