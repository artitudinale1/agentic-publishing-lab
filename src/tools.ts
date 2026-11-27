import type OpenAI from "openai";
import {
  createDraft,
  findArticle,
  updateDraft,
  type Article,
  type Catalog,
  type FindArticleResult,
} from "./articles";
import {
  ARTICLE_LENGTHS,
  countWords,
  resolveArticleLength,
  type ArticleLength,
  type EditorialRequest,
} from "./editorial";

/**
 * Strict Responses API tools.
 * Every property is required and additional properties are rejected.
 * The model chooses which tool to call. These definitions do not set an order.
 */
const findArticleTool: OpenAI.Responses.Tool = {
  type: "function",
  name: "findArticle",
  description:
    "Read one article by slug from the in-memory catalog, including its body. The article may be a draft or published.",
  parameters: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description: "Article slug, for example beta-driven-development.",
      },
    },
    required: ["slug"],
    additionalProperties: false,
  },
  strict: true,
};

const updateDraftTool: OpenAI.Responses.Tool = {
  type: "function",
  name: "updateDraft",
  description:
    "Replace the title and summary of an existing draft. The backend rejects updates to missing or published articles. This tool cannot change the article body.",
  parameters: {
    type: "object",
    properties: {
      slug: { type: "string", description: "Slug of the draft to change." },
      title: { type: "string", description: "Replacement title." },
      summary: { type: "string", description: "Replacement summary." },
    },
    required: ["slug", "title", "summary"],
    additionalProperties: false,
  },
  strict: true,
};

function createDraftTool(acceptsBody: boolean): OpenAI.Responses.Tool {
  if (!acceptsBody) {
    return {
      type: "function",
      name: "createDraft",
      description:
        "Create a draft. Pass slug, title, and summary only. The backend attaches the article body and rejects a body argument. It also rejects a slug that already exists.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "New article slug." },
          title: { type: "string", description: "Draft title." },
          summary: { type: "string", description: "Draft summary." },
        },
        required: ["slug", "title", "summary"],
        additionalProperties: false,
      },
      strict: true,
    };
  }

  return {
    type: "function",
    name: "createDraft",
    description:
      "Create a draft from generated content. Include slug, title, summary, and the full article body. The backend stores the body only when every field is valid, and rejects a slug that already exists.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "New article slug." },
        title: { type: "string", description: "Draft title." },
        summary: { type: "string", description: "Draft summary." },
        body: { type: "string", description: "Full generated article body." },
      },
      required: ["slug", "title", "summary", "body"],
      additionalProperties: false,
    },
    strict: true,
  };
}

export const articleTools: OpenAI.Responses.Tool[] = [
  findArticleTool,
  createDraftTool(false),
  updateDraftTool,
];

/** Tool list for one editorial mode. The model still chooses the call order. */
export function toolsFor(request: EditorialRequest): OpenAI.Responses.Tool[] {
  return [findArticleTool, createDraftTool(request.mode === "generate"), updateDraftTool];
}

export type DraftToolArticle = {
  slug: string;
  title: string;
  summary: string;
  status: Article["status"];
  bodyStored: true;
};

export type ArticleTooLong = {
  code: "too_long";
  length: ArticleLength;
  wordCount: number;
  maxWords: number;
};

export type ToolResult =
  | {
      ok: true;
      result:
        | FindArticleResult
        | { created: true; article: DraftToolArticle }
        | { updated: true; article: DraftToolArticle };
    }
  | { ok: false; error: string; validation?: ArticleTooLong };

/** Tool replies omit the body. The catalog keeps the full text. */
function compactDraft(article: Article): DraftToolArticle {
  return {
    slug: article.slug,
    title: article.title,
    summary: article.summary,
    status: article.status,
    bodyStored: true,
  };
}

export function parseToolArguments(
  raw: string,
  fields: readonly string[],
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Arguments are not valid JSON." };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Arguments must be a JSON object." };
  }

  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) {
      return { ok: false, error: `Unexpected argument: ${key}.` };
    }
  }

  const values: Record<string, string> = {};

  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      return { ok: false, error: `Missing required argument: ${field}.` };
    }

    const current = record[field];

    if (typeof current !== "string") {
      return { ok: false, error: `${field} must be a string.` };
    }

    if (current.trim() === "") {
      return { ok: false, error: `${field} must be a non-empty string.` };
    }

    values[field] = current;
  }

  return { ok: true, values };
}

/**
 * Validate, then apply the backend rule for the tool the model named.
 * Unknown tools and invalid arguments do not change the catalog.
 */
function field(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (value === undefined) {
    throw new Error(`Missing ${name} after validation.`);
  }
  return value;
}

export function runToolCall(
  catalog: Catalog,
  name: string,
  rawArguments: string,
  request?: EditorialRequest,
  log?: (line: string) => void,
): ToolResult {
  if (name === "findArticle") {
    const parsed = parseToolArguments(rawArguments, ["slug"]);
    if (!parsed.ok) {
      return parsed;
    }
    return { ok: true, result: findArticle(catalog, field(parsed.values, "slug")) };
  }

  if (name === "createDraft") {
    const fields =
      request?.mode === "generate"
        ? ["slug", "title", "summary", "body"]
        : ["slug", "title", "summary"];
    const parsed = parseToolArguments(rawArguments, fields);
    if (!parsed.ok) {
      return parsed;
    }

    const body =
      request?.mode === "existing"
        ? request.body
        : request?.mode === "generate"
          ? field(parsed.values, "body")
          : "";

    if (request?.mode === "generate") {
      const length = resolveArticleLength(request.length);
      const maxWords = ARTICLE_LENGTHS[length].maxWords;
      const wordCount = countWords(body);
      log?.(`[article] words=${wordCount}`);

      if (wordCount > maxWords) {
        return {
          ok: false,
          error: `Generated article has ${wordCount} words, which exceeds the maximum of ${maxWords}.`,
          validation: { code: "too_long", length, wordCount, maxWords },
        };
      }
    }

    const created = createDraft(
      catalog,
      field(parsed.values, "slug"),
      field(parsed.values, "title"),
      field(parsed.values, "summary"),
      body,
    );
    if (!created.ok) {
      return created;
    }

    return { ok: true, result: { created: true, article: compactDraft(created.result.article) } };
  }

  if (name === "updateDraft") {
    const parsed = parseToolArguments(rawArguments, ["slug", "title", "summary"]);
    if (!parsed.ok) {
      return parsed;
    }
    const updated = updateDraft(
      catalog,
      field(parsed.values, "slug"),
      field(parsed.values, "title"),
      field(parsed.values, "summary"),
    );
    if (!updated.ok) {
      return updated;
    }

    return { ok: true, result: { updated: true, article: compactDraft(updated.result.article) } };
  }

  return { ok: false, error: `Unknown tool: ${name}.` };
}
