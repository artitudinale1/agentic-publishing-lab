import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import OpenAI from "openai";
import { runExperiment } from "./experiment";

/**
 * Manual entry point. This is the only file that constructs an OpenAI client.
 * Tests do not import it, and nothing here runs unless you start the program.
 */

type Config = {
  apiKey: string;
  model: string;
};

/** Load `.env` from the current directory. Existing shell variables win. */
function loadLocalEnv(): void {
  if (!existsSync(".env")) {
    return;
  }

  const lines = readFileSync(".env", "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.OPENAI_API_KEY?.trim() ?? "";
  const model = env.OPENAI_MODEL?.trim() ?? "";

  if (!apiKey || apiKey === "replace-me") {
    throw new Error("Set OPENAI_API_KEY. Copy .env.example to .env and add your key.");
  }

  if (!model) {
    throw new Error("Set OPENAI_MODEL. Copy .env.example to .env and choose a model.");
  }

  return { apiKey, model };
}

async function readPrompt(): Promise<string> {
  const fromArgs = process.argv.slice(2).join(" ").trim();

  if (fromArgs) {
    return fromArgs;
  }

  if (!input.isTTY) {
    throw new Error('Pass a prompt: npm start -- "Look up beta-driven-development"');
  }

  const rl = createInterface({ input, output });

  try {
    const line = await rl.question("Prompt: ");
    return line.trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  loadLocalEnv();

  const prompt = await readPrompt();

  if (!prompt) {
    throw new Error("Prompt is empty. No API request was sent.");
  }

  const { apiKey, model } = readConfig(process.env);
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
  });

  console.log(`[config] model=${model} max_retries=0`);

  const result = await runExperiment({ client, model, prompt });

  console.log("");
  console.log(result.finalText);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
