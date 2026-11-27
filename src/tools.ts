import type OpenAI from "openai";
import {
  createDraft,
  findArticle,
  updateDraft,
  type Catalog,
  type CreateDraftResult,
  type FindArticleResult,
  type UpdateDraftResult,
} from "./articles";

/**
 * Strict Responses API tools.
 * Every property is required and additional properties are rejected.
 * The model chooses which tool to call. These definitions do not set an order.
 */
export const articleTools: OpenAI.Responses.Tool[] = [
  {
    type: "function",
    name: "findArticle",
    description:
      "Read one article by slug from the in-memory catalog. The article may be a draft or published.",
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
  },
  {
    type: "function",
    name: "createDraft",
    description:
      "Create a draft article. The backend rejects the call when that slug already exists.",
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
  },
  {
    type: "function",
    name: "updateDraft",
    description:
      "Replace the title and summary of an existing draft. The backend rejects updates to missing or published articles.",
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
  },
];

export type ToolResult =
  | { ok: true; result: FindArticleResult | CreateDraftResult | UpdateDraftResult }
  | { ok: false; error: string };

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
export function runToolCall(catalog: Catalog, name: string, rawArguments: string): ToolResult {
  if (name === "findArticle") {
    const parsed = parseToolArguments(rawArguments, ["slug"]);
    if (!parsed.ok) {
      return parsed;
    }
    return { ok: true, result: findArticle(catalog, parsed.values.slug ?? "") };
  }

  if (name === "createDraft") {
    const parsed = parseToolArguments(rawArguments, ["slug", "title", "summary"]);
    if (!parsed.ok) {
      return parsed;
    }
    return createDraft(
      catalog,
      parsed.values.slug ?? "",
      parsed.values.title ?? "",
      parsed.values.summary ?? "",
    );
  }

  if (name === "updateDraft") {
    const parsed = parseToolArguments(rawArguments, ["slug", "title", "summary"]);
    if (!parsed.ok) {
      return parsed;
    }
    return updateDraft(
      catalog,
      parsed.values.slug ?? "",
      parsed.values.title ?? "",
      parsed.values.summary ?? "",
    );
  }

  return { ok: false, error: `Unknown tool: ${name}.` };
}
