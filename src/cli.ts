import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadCoverFile } from "./cover.js";
import { parseCli, type CliRun } from "./editorial.js";
import { runPublishingAgent, type PublishingAgentInput, type PublishingAgentResult, type PublishingEvent } from "./engine.js";
import type { ModelClient } from "./experiment.js";

export type CliOptions = {
  client?: ModelClient;
  log?: (line: string) => void;
  onEvent?: (event: PublishingEvent) => void;
};

/** Map a parsed command line onto the shared engine. Paths are read only here. */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: CliOptions = {},
): Promise<PublishingAgentResult> {
  const run = await readRun(argv);
  return runPublishingAgent(publishingInputFromRun(run, env, options));
}

export function publishingInputFromRun(run: CliRun, env: NodeJS.ProcessEnv, options: CliOptions = {}): PublishingAgentInput {
  const cover = run.coverPath ? loadCoverFile(run.coverPath, "Cover image") : undefined;
  const images = (run.images ?? []).map((image) => {
    if (!image.path) {
      throw new Error("Inline image could not be read.");
    }
    const loaded = loadCoverFile(image.path, "Inline image");
    return {
      filename: loaded.filename,
      bytes: loaded.bytes,
      ...(image.description ? { description: image.description } : {}),
    };
  });

  return {
    target: run.target,
    ...(run.request ? { request: stripImagePrompts(run.request) } : { prompt: run.prompt }),
    ...(cover ? { cover: { filename: cover.filename, bytes: cover.bytes } } : {}),
    ...(images.length > 0 ? { images } : {}),
    env,
    ...(options.client ? { client: options.client } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  };
}

function stripImagePrompts(request: NonNullable<CliRun["request"]>): PublishingAgentInput["request"] {
  if (request.mode === "existing") {
    return {
      mode: "existing",
      instructions: request.instructions,
      body: request.body,
      ...(request.context ? { context: request.context } : {}),
      ...(request.category ? { category: request.category } : {}),
    };
  }

  return {
    mode: "generate",
    prompt: request.prompt,
    ...(request.context ? { context: request.context } : {}),
    ...(request.length ? { length: request.length } : {}),
    ...(request.category ? { category: request.category } : {}),
  };
}

async function readRun(argv: string[]): Promise<CliRun> {
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
