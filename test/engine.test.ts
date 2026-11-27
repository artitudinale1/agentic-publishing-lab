import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { runCli } from "../src/cli";
import { modelPrompt } from "../src/editorial";
import { runPublishingAgent, type PublishingEvent } from "../src/engine";
import type { ModelClient } from "../src/experiment";

const apiKey = "sk-test-secret-should-not-leak";
const agentSecret = "agent-secret-0123456789abcdef0123456789";
const cloudSecret = "cloudinary-secret-should-not-leak";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const env = {
  OPENAI_API_KEY: apiKey,
  OPENAI_MODEL: "test-model",
  AGENT_API_SECRET: agentSecret,
  CLOUDINARY_API_SECRET: cloudSecret,
  CLOUDINARY_API_KEY: "cloud-key-should-not-leak",
  CLOUDINARY_CLOUD_NAME: "private-cloud",
};

function message(text: string, model = "returned-model"): OpenAI.Responses.Response {
  return {
    id: "resp_final",
    model,
    output_text: text,
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 9,
      total_tokens: 29,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  } as unknown as OpenAI.Responses.Response;
}

function functionCall(callId: string, rawArguments: string): OpenAI.Responses.Response {
  return {
    id: `resp_${callId}`,
    model: "returned-model",
    output_text: "",
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: callId,
        name: "findArticle",
        arguments: rawArguments,
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  } as unknown as OpenAI.Responses.Response;
}

function scriptedClient(responses: OpenAI.Responses.Response[]): {
  client: ModelClient;
  requests: OpenAI.Responses.ResponseCreateParamsNonStreaming[];
} {
  const requests: OpenAI.Responses.ResponseCreateParamsNonStreaming[] = [];
  let index = 0;
  const client: ModelClient = {
    responses: {
      create: async (params) => {
        requests.push(params);
        const next = responses[index];
        index += 1;
        if (!next) {
          throw new Error("Unexpected model call.");
        }
        return next;
      },
    },
  };
  return { client, requests };
}

function userText(params: OpenAI.Responses.ResponseCreateParamsNonStreaming): string {
  const first = params.input;
  if (!Array.isArray(first)) {
    return "";
  }
  const messageItem = first[0];
  if (!messageItem || typeof messageItem !== "object" || !("content" in messageItem)) {
    return "";
  }
  return typeof messageItem.content === "string" ? messageItem.content : "";
}

describe("publishing engine", () => {
  it("returns model identifiers, tool logs, token usage, duration, and persistence without secrets", async () => {
    const script = scriptedClient([
      functionCall("call_find", JSON.stringify({ slug: "beta-driven-development" })),
      message("Found the article."),
    ]);
    const logs: string[] = [];
    const streamed: PublishingEvent[] = [];
    const result = await runPublishingAgent({
      prompt: "Look up beta-driven-development",
      target: "mock",
      env,
      client: script.client,
      log: (line) => logs.push(line),
      onEvent: (event) => streamed.push(event),
    });

    assert.equal(result.requestedModel, "test-model");
    assert.deepEqual(result.models, ["returned-model", "returned-model"]);
    assert.equal(result.apiCalls, 2);
    assert.equal(result.inputTokens, 31);
    assert.equal(result.outputTokens, 16);
    assert.equal(result.durationMs >= 0, true);
    assert.equal(result.validation.article, null);
    assert.equal(result.persistence.persisted, false);
    assert.match(result.persistence.message, /No local draft/);
    assert.equal(result.events.some((event) => event.type === "tool" && event.phase === "request" && event.name === "findArticle"), true);
    assert.equal(result.events.some((event) => event.type === "usage" && event.apiCalls === 2), true);
    assert.equal(result.events.some((event) => event.type === "duration"), true);
    assert.equal(result.events.some((event) => event.type === "persistence"), true);
    assert.deepEqual(streamed, result.events);
    assert.match(logs.join("\n"), /\[config\] requested_model=test-model max_retries=0/);
    assert.match(logs.join("\n"), /\[config\] target=mock/);
    assert.match(logs.join("\n"), /\[tool\] request name=findArticle/);
    assert.match(logs.join("\n"), /\[result\] status=completed incomplete_reason=none/);
    const published = JSON.stringify({ events: result.events, persistence: result.persistence, logs });
    assert.equal(published.includes(apiKey), false);
    assert.equal(published.includes(agentSecret), false);
    assert.equal(published.includes(cloudSecret), false);
    assert.equal(published.includes("X-Agent-Authorization"), false);
    assert.equal(published.includes("Bearer"), false);
  });

  it("validates image buffers and does not open a filename as a filesystem path", async () => {
    let calls = 0;
    const client: ModelClient = {
      responses: {
        create: async () => {
          calls += 1;
          return message("Done.");
        },
      },
    };
    const result = await runPublishingAgent({
      request: { mode: "generate", prompt: "Write about Beta.", length: "short", category: "CODE" },
      target: "mock",
      env,
      client,
      cover: { filename: "/tmp/does-not-exist-cover.png", bytes: png },
      images: [{ filename: "/home/alex/secret-beta.png", bytes: png, description: "Beta asleep" }],
      log: () => undefined,
    });

    assert.equal(calls, 1);
    const config = result.events.find((event) => event.type === "config");
    assert.ok(config && config.type === "config");
    assert.equal(config.cover, "does-not-exist-cover.png");
    assert.deepEqual(config.inlineIds, ["image-1"]);
    assert.match(result.persistence.message, /No local draft/);
    assert.equal(JSON.stringify(result.events).includes("/home/alex/secret-beta.png"), false);
    assert.equal(JSON.stringify(result.events).includes("data:image"), false);

    let rejectedCalls = 0;
    await assert.rejects(
      () =>
        runPublishingAgent({
          prompt: "Hello",
          target: "mock",
          env,
          client: {
            responses: {
              create: async () => {
                rejectedCalls += 1;
                return message("Nope.");
              },
            },
          },
          cover: { filename: "/etc/passwd.png", bytes: Buffer.from("not an image") },
          log: () => undefined,
        }),
      /JPEG, PNG, or WebP/,
    );
    assert.equal(rejectedCalls, 0);
    await assert.rejects(
      () =>
        runPublishingAgent({
          request: { mode: "generate", prompt: "Write.", length: "short" },
          images: [{ filename: "beta.png", bytes: png }],
          env,
          client,
          log: () => undefined,
        }),
      /needs a description/,
    );
  });

  it("does not call the model when live configuration is missing", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        runPublishingAgent({
          prompt: "Look up beta-driven-development",
          target: "live",
          env: { OPENAI_API_KEY: apiKey, OPENAI_MODEL: "test-model" },
          client: {
            responses: {
              create: async () => {
                calls += 1;
                return message("Nope.");
              },
            },
          },
          log: () => undefined,
        }),
      /BLOG_API_URL/,
    );
    assert.equal(calls, 0);
  });
});

describe("CLI adapter", () => {
  it("keeps the command line on the same engine and out of the image paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "engine-cli-"));
    const articlePath = join(directory, "article.md");
    const coverPath = join(directory, "cover.png");
    const imagePath = join(directory, "secret-beta.png");
    writeFileSync(articlePath, "Hello from the supplied file.\n");
    writeFileSync(coverPath, png);
    writeFileSync(imagePath, png);
    const script = scriptedClient([message("Proposed a title.")]);
    const logs: string[] = [];
    const result = await runCli(
      [
        "--mode",
        "generate",
        "--prompt",
        "Write about Beta.",
        "--length",
        "short",
        "--category",
        "CODE",
        "--context",
        "Beta is a cat.",
        "--target",
        "mock",
        "--cover",
        coverPath,
        "--image",
        imagePath,
        "--image-description",
        "Beta asleep",
      ],
      env,
      { client: script.client, log: (line) => logs.push(line) },
    );

    const sent = userText(script.requests[0]!);
    assert.equal(sent.includes(imagePath), false);
    assert.equal(sent.includes(coverPath), false);
    assert.match(sent, /image-1: Beta asleep/);
    assert.match(script.requests[0]?.instructions ?? "", /Write between 150 and 300 words/);
    assert.equal(
      sent,
      modelPrompt({
        mode: "generate",
        prompt: "Write about Beta.",
        length: "short",
        category: "CODE",
        context: "Beta is a cat.",
        images: [{ id: "image-1", description: "Beta asleep" }],
      }),
    );
    assert.match(logs.join("\n"), /\[config\] mode=generate/);
    assert.match(logs.join("\n"), /\[config\] category=CODE/);
    assert.match(logs.join("\n"), /\[config\] target=mock/);
    assert.match(logs.join("\n"), /\[config\] cover=cover\.png/);
    assert.match(logs.join("\n"), /\[config\] inline=image-1/);
    assert.match(logs.join("\n"), /\[api\] max_output_tokens=2048/);
    assert.match(logs.join("\n"), /\[blog\] No local draft to store\./);
    assert.equal(result.persistence.persisted, false);
    const published = JSON.stringify({ logs, events: result.events });
    assert.equal(published.includes(apiKey), false);
    assert.equal(published.includes(directory), false);
  });
});
