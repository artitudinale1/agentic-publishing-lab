import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import OpenAI from "openai";
import { createBlogClient, persistValidatedDraft, readBlogConfig } from "./blog";
import { createCloudinaryUploader, inspectCoverFile, readCloudinaryConfig } from "./cover";
import { openAIClientOptions, readConfig } from "./config";
import { parseCli, type CliRun } from "./editorial";
import { formatRunOutput, runExperiment } from "./experiment";

/**
 * Manual entry point. This is the only file that constructs an OpenAI client.
 * Tests do not import it, and nothing here runs unless you start the program.
 */

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

async function readRun(): Promise<CliRun> {
  const argv = process.argv.slice(2);

  if (argv.length > 0) {
    return parseCli(argv);
  }

  if (!input.isTTY) {
    throw new Error('Pass a prompt: npm start -- "Look up beta-driven-development"');
  }

  const rl = createInterface({ input, output });

  try {
    const line = await rl.question("Prompt: ");
    return { prompt: line.trim(), target: "mock" };
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  loadLocalEnv();

  const run = await readRun();

  if (!run.prompt) {
    throw new Error("Prompt is empty. No API request was sent.");
  }

  if (run.coverPath) {
    inspectCoverFile(run.coverPath);
  }

  const blogConfig = run.target === "live" ? readBlogConfig(process.env) : undefined;
  const cloudinaryConfig =
    run.target === "live" && run.coverPath ? readCloudinaryConfig(process.env) : undefined;
  const config = readConfig(process.env);
  const client = new OpenAI(openAIClientOptions(config));

  console.log(`[config] requested_model=${config.model} max_retries=0`);
  if (config.baseURL) {
    console.log(`[config] base_url=${config.baseURL}`);
  }
  if (run.request) {
    console.log(`[config] mode=${run.request.mode}`);
    if (run.request.category) {
      console.log(`[config] category=${run.request.category}`);
    }
  }
  console.log(`[config] target=${run.target}`);
  if (run.coverPath) {
    console.log(`[config] cover=${basename(run.coverPath)}`);
  }

  const blog = blogConfig ? createBlogClient(blogConfig) : undefined;
  const uploadCover = cloudinaryConfig ? createCloudinaryUploader(cloudinaryConfig) : undefined;

  const result = await runExperiment({
    client,
    model: config.model,
    prompt: run.prompt,
    request: run.request,
  });

  console.log(
    `[result] status=${result.status} incomplete_reason=${result.incompleteReason ?? "none"}`,
  );
  console.log("");
  console.log(formatRunOutput(result));

  await persistValidatedDraft({
    target: run.target,
    draft: result.draft,
    request: run.request,
    status: result.status,
    stoppedAtCallLimit: result.stoppedAtCallLimit,
    client: blog,
    coverPath: run.coverPath,
    uploadCover,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
