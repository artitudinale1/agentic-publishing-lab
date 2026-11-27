import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import {
  ARTICLE_LENGTHS,
  instructionsFor,
  loadMarkdownFile,
  modelPrompt,
  parseCli,
  parseEditorialRequest,
  type EditorialRequest,
} from "../src/editorial";
import {
  EXISTING_ARTICLE_MAX_OUTPUT_TOKENS,
  formatRunOutput,
  runExperiment,
  type ModelClient,
} from "../src/experiment";

const SUPPLIED = "# Supplied article\n\nThis paragraph must be stored unchanged.\n";
const FIXTURE = "test/fixtures/supplied-article.md";
const PUBLISHED_SLUG = "beta-driven-development";

type CreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;

function toolCall(name: string, callId: string, args: unknown): OpenAI.Responses.Response {
  return {
    id: `resp_${callId}`,
    model: "fake-model",
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  } as unknown as OpenAI.Responses.Response;
}

function message(text: string): OpenAI.Responses.Response {
  return {
    id: "resp_final",
    model: "fake-model",
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
    usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
  } as unknown as OpenAI.Responses.Response;
}

function scriptedClient(responses: OpenAI.Responses.Response[]): {
  client: ModelClient;
  requests: CreateParams[];
} {
  const requests: CreateParams[] = [];
  let index = 0;

  return {
    requests,
    client: {
      responses: {
        create: async (params) => {
          requests.push(params);
          const next = responses[index];
          index += 1;
          if (!next) {
            throw new Error("The experiment made a model call the test did not expect.");
          }
          return next;
        },
      },
    },
  };
}

function requiredFields(params: CreateParams | undefined): unknown {
  const tool = params?.tools?.find((item) => "name" in item && item.name === "createDraft");
  if (!tool || !("parameters" in tool)) {
    return undefined;
  }

  const parameters: unknown = tool.parameters;
  if (typeof parameters !== "object" || parameters === null || !("required" in parameters)) {
    return undefined;
  }

  return parameters.required;
}

function parsedOutput(params: CreateParams | undefined, callId: string): {
  ok: boolean;
  error?: string;
  validation?: { code?: string; length?: string; wordCount?: number; maxWords?: number };
  result?: {
    found?: boolean;
    article?: { body?: string; title?: string; status?: string; bodyStored?: boolean };
  };
} {
  assert.ok(Array.isArray(params?.input));
  const output = params.input.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "function_call_output" &&
      "call_id" in item &&
      item.call_id === callId &&
      "output" in item,
  );
  if (!output || !("output" in output) || typeof output.output !== "string") {
    throw new Error(`Missing tool output for ${callId}.`);
  }
  return JSON.parse(output.output) as {
    ok: boolean;
    error?: string;
    validation?: { code?: string; length?: string; wordCount?: number; maxWords?: number };
    result?: {
      found?: boolean;
      article?: { body?: string; title?: string; status?: string; bodyStored?: boolean };
    };
  };
}

function wordBody(count: number): string {
  return Array.from({ length: count }, () => "word").join(" ");
}

const metadata = {
  slug: "supplied-article",
  title: "Supplied Article",
  summary: "A summary written by the model.",
  category: "CATS",
};

describe("editorial input", () => {
  it("loads Markdown exactly and parses both modes", () => {
    assert.equal(loadMarkdownFile(FIXTURE), SUPPLIED);

    const existing = parseEditorialRequest({
      mode: "existing",
      instructions: " Propose a title. ",
      body: SUPPLIED,
      context: " Internal note ",
    });
    assert.deepEqual(existing, {
      mode: "existing",
      instructions: "Propose a title.",
      body: SUPPLIED,
      context: "Internal note",
    });

    const generated = parseEditorialRequest({
      mode: "generate",
      prompt: " Write about the desk. ",
    });
    assert.deepEqual(generated, {
      mode: "generate",
      prompt: "Write about the desk.",
      length: "medium",
    });
  });

  it("rejects missing or invalid editorial inputs", () => {
    assert.throws(() => parseEditorialRequest({}), /Set mode to existing or generate/);
    assert.throws(
      () => parseEditorialRequest({ mode: "existing", instructions: "Title it" }),
      /requires the article body/,
    );
    assert.throws(
      () => parseEditorialRequest({ mode: "existing", instructions: "   ", body: SUPPLIED }),
      /publishing instructions/,
    );
    assert.throws(
      () => parseEditorialRequest({ mode: "existing", instructions: "Title it", body: " \n" }),
      /requires the article body/,
    );
    assert.throws(() => parseEditorialRequest({ mode: "generate" }), /editorial prompt/);
    assert.throws(
      () => parseEditorialRequest({ mode: "generate", prompt: "Write", context: " " }),
      /context must be a non-empty string/,
    );
    assert.throws(() => parseCli(["--mode", "existing"]), /requires --file and --instructions/);
    assert.throws(() => parseCli(["--mode", "generate"]), /requires --prompt/);
    assert.throws(
      () => parseCli(["--mode", "generate", "--prompt", "Write", "--category", "PETS"]),
      /CODE, JAPANESE, CATS, or COOKING/,
    );
    assert.throws(
      () => parseCli(["--mode", "generate", "--prompt", "Write", "--length", "huge"]),
      /short, medium, or long/,
    );
    assert.throws(
      () =>
        parseCli([
          "--mode",
          "existing",
          "--file",
          FIXTURE,
          "--instructions",
          "Propose a title.",
          "--length",
          "short",
        ]),
      /Unknown argument: --length/,
    );
    assert.throws(() => parseCli(["--mode", "publish", "--prompt", "Write"]), /existing or generate/);
    assert.throws(
      () => parseCli(["--mode", "generate", "--prompt", "Write", "--target", "remote"]),
      /mock or live/,
    );
    assert.equal(parseCli(["--target", "live", "Look up beta"]).target, "live");
    assert.equal(parseCli(["--target", "live", "Look up beta"]).prompt, "Look up beta");
    assert.equal(parseCli(["Look up beta"]).target, "mock");
    assert.throws(() => loadMarkdownFile("missing.md"), /Article file not found/);
    assert.throws(() => loadMarkdownFile("notes.txt"), /must end in \.md/);

    const directory = mkdtempSync(join(tmpdir(), "editorial-"));
    try {
      const emptyFile = join(directory, "empty.md");
      writeFileSync(emptyFile, " \n");
      assert.throws(() => loadMarkdownFile(emptyFile), /Article file is empty/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds an existing-article run from a local Markdown file", () => {
    const run = parseCli([
      "--mode",
      "existing",
      "--file",
      FIXTURE,
      "--instructions",
      "Propose a title, slug, and summary.",
      "--context",
      "Audience is the lab.",
    ]);

    assert.equal(run.request?.mode, "existing");
    if (run.request?.mode !== "existing") {
      return;
    }
    assert.equal(run.request.body, SUPPLIED);
    assert.equal(run.request.instructions, "Propose a title, slug, and summary.");
    assert.equal(run.request.context, "Audience is the lab.");
    assert.match(run.prompt, /Propose a title, slug, and summary/);
    assert.ok(run.prompt.includes(SUPPLIED));
  });
});

describe("editorial drafts", () => {
  const existing: EditorialRequest = {
    mode: "existing",
    instructions: "Propose a title, slug, and summary.",
    body: SUPPLIED,
    context: "Audience is the lab.",
  };

  it("stores the supplied article body exactly", async () => {
    const lines: string[] = [];
    const script = scriptedClient([
      toolCall("createDraft", "call_create", metadata),
      toolCall("updateDraft", "call_update", {
        slug: metadata.slug,
        title: "Supplied Article, revised",
        summary: "A revised summary.",
      }),
      toolCall("findArticle", "call_find", { slug: metadata.slug }),
      message("Draft saved."),
    ]);

    const result = await runExperiment({
      client: script.client,
      model: "provider/model-name",
      prompt: modelPrompt(existing),
      request: existing,
      log: (line) => lines.push(line),
    });

    assert.equal(result.finalText, "Draft saved.");
    assert.equal(result.status, "completed");
    assert.equal(script.requests[0]?.max_output_tokens, EXISTING_ARTICLE_MAX_OUTPUT_TOKENS);
    assert.ok(lines.includes(`[api] max_output_tokens=${EXISTING_ARTICLE_MAX_OUTPUT_TOKENS}`));
    assert.equal(
      lines.some((line) => line.startsWith("[article]")),
      false,
    );
    const created = parsedOutput(script.requests[1], "call_create");
    const updated = parsedOutput(script.requests[2], "call_update");
    assert.equal(created.result?.article?.body, undefined);
    assert.equal(created.result?.article?.bodyStored, true);
    assert.equal(updated.result?.article?.bodyStored, true);
    assert.equal(updated.result?.article?.title, "Supplied Article, revised");
    assert.equal(parsedOutput(script.requests[3], "call_find").result?.article?.body, SUPPLIED);
    assert.equal(result.draft?.body, SUPPLIED);
    assert.equal(result.finalText.includes(SUPPLIED), false);
    assert.equal(script.requests[0]?.tool_choice, "auto");
    assert.ok(formatRunOutput(result).includes(SUPPLIED));
    assert.equal(formatRunOutput(result).startsWith("Draft saved."), true);

    assert.deepEqual(requiredFields(script.requests[0]), ["slug", "title", "summary", "category"]);
  });

  it("rejects tool arguments that try to replace the supplied body", async () => {
    const script = scriptedClient([
      toolCall("createDraft", "call_bad", { ...metadata, body: "Rewritten by the model.\n" }),
      toolCall("createDraft", "call_create", metadata),
      toolCall("updateDraft", "call_overwrite", {
        slug: metadata.slug,
        title: metadata.title,
        summary: metadata.summary,
        body: "Another rewrite.\n",
      }),
      toolCall("findArticle", "call_check", { slug: metadata.slug }),
      message("The original body remains."),
    ]);

    await runExperiment({
      client: script.client,
      model: "provider/model-name",
      prompt: modelPrompt(existing),
      request: existing,
      log: () => undefined,
    });

    assert.deepEqual(parsedOutput(script.requests[1], "call_bad"), {
      ok: false,
      error: "Unexpected argument: body.",
    });
    assert.deepEqual(parsedOutput(script.requests[3], "call_overwrite"), {
      ok: false,
      error: "Unexpected argument: body.",
    });
    assert.equal(parsedOutput(script.requests[4], "call_check").result?.article?.body, SUPPLIED);
  });

  it("stores generated body only after validation", async () => {
    const generated = "# Generated\n\nBeta keeps the lights on.\n";
    const request: EditorialRequest = {
      mode: "generate",
      prompt: "Write a short article about Beta.",
      context: "Mention the cat.",
    };
    const lines: string[] = [];
    const script = scriptedClient([
      toolCall("createDraft", "call_empty", { ...metadata, slug: "empty-body", body: "  " }),
      toolCall("createDraft", "call_create", { ...metadata, body: generated }),
      toolCall("findArticle", "call_find", { slug: metadata.slug }),
      message("Generated draft saved."),
    ]);

    await runExperiment({
      client: script.client,
      model: "provider/model-name",
      prompt: modelPrompt(request),
      request,
      log: (line) => lines.push(line),
    });

    assert.equal(script.requests[0]?.max_output_tokens, ARTICLE_LENGTHS.medium.maxOutputTokens);
    assert.ok(lines.includes("[article] length=medium"));
    assert.ok(lines.includes(`[api] max_output_tokens=${ARTICLE_LENGTHS.medium.maxOutputTokens}`));
    assert.equal(parsedOutput(script.requests[1], "call_empty").ok, false);
    assert.equal(parsedOutput(script.requests[1], "call_empty").error, "body must be a non-empty string.");
    const created = parsedOutput(script.requests[2], "call_create");
    assert.equal(created.result?.article?.body, undefined);
    assert.equal(created.result?.article?.bodyStored, true);
    assert.equal(JSON.stringify(created).includes(generated), false);
    assert.equal(parsedOutput(script.requests[3], "call_find").result?.article?.body, generated);

    assert.deepEqual(requiredFields(script.requests[0]), ["slug", "title", "summary", "body", "category"]);
  });

  it("keeps published-article protection and skips incomplete tool calls", async () => {
    const protection = scriptedClient([
      toolCall("updateDraft", "call_published", {
        slug: PUBLISHED_SLUG,
        title: "Replaced title",
        summary: "Replaced summary",
      }),
      toolCall("findArticle", "call_check", { slug: PUBLISHED_SLUG }),
      message("Published article unchanged."),
    ]);

    await runExperiment({
      client: protection.client,
      model: "provider/model-name",
      prompt: modelPrompt(existing),
      request: existing,
      log: () => undefined,
    });

    assert.deepEqual(parsedOutput(protection.requests[1], "call_published"), {
      ok: false,
      error: `Cannot update published article "${PUBLISHED_SLUG}".`,
    });
    const published = parsedOutput(protection.requests[2], "call_check").result?.article;
    assert.equal(published?.status, "published");
    assert.equal(published?.title?.includes("Beta-Driven Development"), true);
    assert.equal(
      published?.body,
      "Beta is a black-and-white cat. This published article is already in the catalog.\n",
    );

    const incomplete = scriptedClient([
      {
        id: "resp_incomplete",
        model: "fake-model",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "function_call",
            call_id: "call_partial",
            name: "createDraft",
            arguments: JSON.stringify(metadata),
          },
        ],
        usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
      } as unknown as OpenAI.Responses.Response,
      message("This follow-up must not be requested."),
    ]);
    const lines: string[] = [];
    const result = await runExperiment({
      client: incomplete.client,
      model: "provider/model-name",
      prompt: modelPrompt(existing),
      request: existing,
      log: (line) => lines.push(line),
    });

    assert.equal(incomplete.requests.length, 1);
    assert.equal(result.status, "incomplete");
    assert.equal(result.incompleteReason, "max_output_tokens");
    assert.equal(result.inputTokens, 9);
    assert.equal(result.outputTokens, 3);
    assert.ok(lines.includes("[incomplete] did not execute call_id=call_partial"));
    assert.equal(
      lines.some((line) => line.includes("[tool] result")),
      false,
    );
  });
});

describe("generate article length", () => {
  it("defaults to medium and accepts short or long from the CLI", () => {
    const medium = parseCli(["--mode", "generate", "--prompt", "Write about Beta."]);
    assert.equal(medium.request?.mode, "generate");
    if (medium.request?.mode !== "generate") {
      return;
    }
    assert.equal(medium.request.length, "medium");
    assert.match(instructionsFor(medium.request), /Write between 300 and 600 words/);

    const short = parseCli([
      "--mode",
      "generate",
      "--prompt",
      "Write about Beta.",
      "--length",
      "short",
    ]);
    assert.equal(short.request?.mode, "generate");
    if (short.request?.mode !== "generate") {
      return;
    }
    assert.equal(short.request.length, "short");
    assert.match(instructionsFor(short.request), /Write between 150 and 300 words/);
    assert.match(instructionsFor(short.request), /does not exceed 300 words/);

    const long = parseEditorialRequest({
      mode: "generate",
      prompt: "Write about Beta.",
      length: "long",
    });
    assert.equal(long.mode, "generate");
    if (long.mode !== "generate") {
      return;
    }
    assert.match(instructionsFor(long), /Write between 600 and 1000 words/);

    const existing = parseEditorialRequest({
      mode: "existing",
      instructions: "Propose a title.",
      body: SUPPLIED,
    });
    assert.equal(instructionsFor(existing).includes("Write between"), false);
    assert.match(instructionsFor(existing), /Choose which tools to call and in which order/);
    assert.match(
      instructionsFor(existing),
      /do not call findArticle for that article unless the user explicitly asked to read it back/,
    );
    assert.match(instructionsFor(medium.request), /Do not repeat the article body/);
    assert.match(instructionsFor(short.request), /Choose which tools to call and in which order/);
  });

  it("selects the token budget from the length preset", async () => {
    const body = wordBody(10);
    const cases = [
      { length: "short" as const, tokens: ARTICLE_LENGTHS.short.maxOutputTokens },
      { length: "medium" as const, tokens: ARTICLE_LENGTHS.medium.maxOutputTokens },
      { length: "long" as const, tokens: ARTICLE_LENGTHS.long.maxOutputTokens },
    ];

    for (const item of cases) {
      const request: EditorialRequest = {
        mode: "generate",
        prompt: "Write about Beta.",
        length: item.length,
      };
      const lines: string[] = [];
      const script = scriptedClient([
        toolCall("createDraft", "call_create", { ...metadata, body }),
        message("Saved."),
      ]);

      await runExperiment({
        client: script.client,
        model: "provider/model-name",
        prompt: modelPrompt(request),
        request,
        log: (line) => lines.push(line),
      });

      assert.equal(script.requests[0]?.max_output_tokens, item.tokens);
      assert.match(script.requests[0]?.instructions ?? "", /Write between/);
      assert.ok(lines.includes(`[article] length=${item.length}`));
      assert.ok(lines.includes(`[api] max_output_tokens=${item.tokens}`));
      assert.ok(lines.includes("[article] words=10"));
      assert.equal(parsedOutput(script.requests[1], "call_create").result?.article?.bodyStored, true);
    }
  });

  it("rejects an article over the maximum and stores one at the maximum unchanged", async () => {
    const request: EditorialRequest = {
      mode: "generate",
      prompt: "Write about Beta.",
      length: "short",
    };
    const tooLong = wordBody(ARTICLE_LENGTHS.short.maxWords + 1);
    const exact = wordBody(ARTICLE_LENGTHS.short.maxWords);
    const lines: string[] = [];
    const script = scriptedClient([
      toolCall("createDraft", "call_long", { ...metadata, body: tooLong }),
      toolCall("createDraft", "call_exact", { ...metadata, body: exact }),
      toolCall("findArticle", "call_find", { slug: metadata.slug }),
      message("Saved the exact article."),
    ]);

    const result = await runExperiment({
      client: script.client,
      model: "provider/model-name",
      prompt: modelPrompt(request),
      request,
      log: (line) => lines.push(line),
    });

    assert.deepEqual(parsedOutput(script.requests[1], "call_long"), {
      ok: false,
      error: "Generated article has 301 words, which exceeds the maximum of 300.",
      validation: { code: "too_long", length: "short", wordCount: 301, maxWords: 300 },
    });
    assert.equal(parsedOutput(script.requests[2], "call_exact").result?.article?.body, undefined);
    assert.equal(parsedOutput(script.requests[3], "call_find").result?.article?.body, exact);
    assert.equal(result.draft?.body, exact);
    assert.equal(result.draft?.body === tooLong, false);
    assert.ok(lines.includes("[article] words=301"));
    assert.ok(lines.includes("[article] words=300"));
    assert.equal(JSON.stringify(parsedOutput(script.requests[1], "call_long")).includes(tooLong), false);
  });

  it("stores an article below the requested minimum without shortening it", async () => {
    const request: EditorialRequest = {
      mode: "generate",
      prompt: "Write about Beta.",
      length: "long",
    };
    const body = wordBody(12);
    const script = scriptedClient([
      toolCall("createDraft", "call_create", { ...metadata, body }),
      toolCall("findArticle", "call_find", { slug: metadata.slug }),
      message("Saved."),
    ]);

    await runExperiment({
      client: script.client,
      model: "provider/model-name",
      prompt: modelPrompt(request),
      request,
      log: () => undefined,
    });

    assert.equal(script.requests[0]?.max_output_tokens, ARTICLE_LENGTHS.long.maxOutputTokens);
    assert.equal(parsedOutput(script.requests[2], "call_find").result?.article?.body, body);
  });

  it("returns the stored draft instead of the model's summary text", async () => {
    const request: EditorialRequest = {
      mode: "generate",
      prompt: "Write about Beta.",
      length: "short",
    };
    const body = wordBody(20);
    const summary = "Saved a short draft. The catalog holds the article.";
    const script = scriptedClient([
      toolCall("createDraft", "call_create", { ...metadata, body }),
      message(summary),
    ]);

    const result = await runExperiment({
      client: script.client,
      model: "provider/model-name",
      prompt: modelPrompt(request),
      request,
      log: () => undefined,
    });

    assert.equal(script.requests[0]?.tool_choice, "auto");
    assert.equal(result.finalText, summary);
    assert.equal(result.finalText.includes(body), false);
    assert.equal(result.draft?.body, body);
    assert.equal(result.draft?.slug, metadata.slug);
    assert.equal(result.draft?.status, "draft");
    const printed = formatRunOutput(result);
    assert.ok(printed.startsWith(summary));
    assert.ok(printed.endsWith(body));
    assert.equal(printed.includes(`[draft] slug=${metadata.slug}`), true);
  });
});
