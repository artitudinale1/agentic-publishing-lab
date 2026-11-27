import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type OpenAI from "openai";
import { articleRevision, type ArticleCategory } from "../src/articles";
import { runExperiment, type ModelClient } from "../src/experiment";

/**
 * Fake model responses only. These tests do not call a provider.
 */

type CreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;

const PUBLISHED_SLUG = "beta-driven-development";
const PUBLISHED_TITLE =
  "Beta-Driven Development: An Agentic Architecture for Resource Acquisition";

const DRAFT = {
  slug: "office-notes",
  title: "Office Notes",
  summary: "A draft about the desk.",
  category: "CATS" as ArticleCategory,
};

function savedDraft(title = DRAFT.title, summary = DRAFT.summary, body = "") {
  const content = {
    slug: DRAFT.slug,
    title,
    summary,
    body,
    category: DRAFT.category,
  };
  return {
    ...content,
    status: "draft" as const,
    revision: articleRevision(content),
    validatedRevision: null,
    approvedRevision: null,
  };
}

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

function outputs(params: CreateParams | undefined): Array<{ call_id?: string; output?: string }> {
  assert.ok(Array.isArray(params?.input));
  return params.input.filter(
    (item) => typeof item === "object" && item !== null && "type" in item && item.type === "function_call_output",
  ) as Array<{ call_id?: string; output?: string }>;
}

function parsedOutput(params: CreateParams | undefined, callId: string): unknown {
  const output = outputs(params).find((item) => item.call_id === callId)?.output;
  if (typeof output !== "string") {
    throw new Error(`Missing tool output for ${callId}.`);
  }
  return JSON.parse(output);
}

async function runScript(responses: OpenAI.Responses.Response[], prompt: string) {
  const script = scriptedClient(responses);
  const result = await runExperiment({
    client: script.client,
    model: "provider/model-name",
    prompt,
    log: () => undefined,
  });
  return { ...script, result };
}

describe("draft tools", () => {
  it("creates a draft when the model requests createDraft", async () => {
    const { requests, result } = await runScript(
      [toolCall("createDraft", "call_create", DRAFT), message("Created the draft.")],
      "Create a draft called Office Notes",
    );

    assert.equal(result.finalText, "Created the draft.");
    assert.deepEqual(result.draft, savedDraft());
    assert.deepEqual(
      requests[0]?.tools?.map((tool) => ("name" in tool ? tool.name : "")),
      ["findArticle", "createDraft", "updateDraft", "validateArticle"],
    );
    assert.equal(requests[0]?.tool_choice, "auto");
    assert.deepEqual(parsedOutput(requests[1], "call_create"), {
      ok: true,
      result: { created: true, article: { ...DRAFT, status: "draft", bodyStored: true } },
    });
  });

  it("updates a draft when the model requests createDraft and then updateDraft", async () => {
    const { requests, result } = await runScript(
      [
        toolCall("createDraft", "call_create", DRAFT),
        toolCall("updateDraft", "call_update", {
          slug: DRAFT.slug,
          title: "Office Notes, revised",
          summary: "A revised draft about the desk.",
        }),
        message("Updated the draft."),
      ],
      "Create Office Notes and then revise it",
    );

    assert.deepEqual(parsedOutput(requests[2], "call_update"), {
      ok: true,
      result: {
        updated: true,
        article: {
          slug: DRAFT.slug,
          title: "Office Notes, revised",
          summary: "A revised draft about the desk.",
          category: "CATS",
          status: "draft",
          bodyStored: true,
        },
      },
    });
    assert.deepEqual(
      result.draft,
      savedDraft("Office Notes, revised", "A revised draft about the desk."),
    );
  });

  it("rejects updates to published and missing articles", async () => {
    const published = await runScript(
      [
        toolCall("updateDraft", "call_published", {
          slug: PUBLISHED_SLUG,
          title: "Replaced title",
          summary: "Replaced summary",
        }),
        toolCall("findArticle", "call_check", { slug: PUBLISHED_SLUG }),
        message("The published article was left unchanged."),
      ],
      "Change the published article",
    );

    assert.deepEqual(parsedOutput(published.requests[1], "call_published"), {
      ok: false,
      error: `Cannot update published article "${PUBLISHED_SLUG}".`,
    });
    assert.equal(
      (parsedOutput(published.requests[2], "call_check") as { result: { found: true; article: { title: string } } })
        .result.article.title,
      PUBLISHED_TITLE,
    );

    const missing = await runScript(
      [
        toolCall("updateDraft", "call_missing", {
          slug: "not-in-the-catalog",
          title: "Missing",
          summary: "Missing summary",
        }),
        message("That article is not in the catalog."),
      ],
      "Update a missing draft",
    );

    assert.deepEqual(parsedOutput(missing.requests[1], "call_missing"), {
      ok: false,
      error: 'No article found for slug "not-in-the-catalog".',
    });
  });

  it("follows the model order instead of creating before an earlier update", async () => {
    const { requests } = await runScript(
      [
        toolCall("updateDraft", "call_update", {
          slug: DRAFT.slug,
          title: DRAFT.title,
          summary: DRAFT.summary,
        }),
        toolCall("createDraft", "call_create", DRAFT),
        message("Created it after the failed update."),
      ],
      "Update office notes, or create it if needed",
    );

    assert.deepEqual(parsedOutput(requests[1], "call_update"), {
      ok: false,
      error: `No article found for slug "${DRAFT.slug}".`,
    });
    assert.deepEqual(parsedOutput(requests[2], "call_create"), {
      ok: true,
      result: { created: true, article: { ...DRAFT, status: "draft", bodyStored: true } },
    });
  });

  it("rejects invalid draft arguments before changing the catalog", async () => {
    const { requests } = await runScript(
      [
        toolCall("createDraft", "call_bad", { slug: DRAFT.slug }),
        toolCall("findArticle", "call_check", { slug: DRAFT.slug }),
        message("The arguments were invalid."),
      ],
      "Create a draft with a slug only",
    );

    assert.deepEqual(parsedOutput(requests[1], "call_bad"), {
      ok: false,
      error: "Missing required argument: title.",
    });
    assert.deepEqual(parsedOutput(requests[2], "call_check"), {
      ok: true,
      result: {
        found: false,
        slug: DRAFT.slug,
        message: `No article found for slug "${DRAFT.slug}".`,
      },
    });
  });

  it("rejects a slug that already exists and keeps the first article", async () => {
    const { requests } = await runScript(
      [
        toolCall("createDraft", "call_published", {
          slug: PUBLISHED_SLUG,
          title: "Another title",
          summary: "Another summary",
          category: "CATS",
        }),
        toolCall("createDraft", "call_first", DRAFT),
        toolCall("createDraft", "call_duplicate", {
          slug: DRAFT.slug,
          title: "Different title",
          summary: "Different summary",
          category: "CATS",
        }),
        toolCall("findArticle", "call_check", { slug: DRAFT.slug }),
        message("Duplicates were rejected."),
      ],
      "Create two drafts and repeat a slug",
    );

    assert.deepEqual(parsedOutput(requests[1], "call_published"), {
      ok: false,
      error: `Slug "${PUBLISHED_SLUG}" already exists.`,
    });
    assert.deepEqual(parsedOutput(requests[3], "call_duplicate"), {
      ok: false,
      error: `Slug "${DRAFT.slug}" already exists.`,
    });
    assert.deepEqual(parsedOutput(requests[4], "call_check"), {
      ok: true,
      result: {
        found: true,
        article: savedDraft(),
      },
    });
  });

  it("gives each execution its own catalog", async () => {
    await runScript(
      [toolCall("createDraft", "call_create", DRAFT), message("Created.")],
      "Create office notes",
    );

    const second = await runScript(
      [
        toolCall("updateDraft", "call_update", {
          slug: DRAFT.slug,
          title: "Should not apply",
          summary: "Should not apply",
        }),
        message("The other run cannot see that draft."),
      ],
      "Update office notes",
    );

    assert.deepEqual(parsedOutput(second.requests[1], "call_update"), {
      ok: false,
      error: `No article found for slug "${DRAFT.slug}".`,
    });
  });
});
