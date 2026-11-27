import type OpenAI from "openai";
import { findArticle, type FindArticleResult } from "./articles";

/**
 * Official Responses API function tool.
 * `strict: true` requires every property to be listed in `required`
 * and `additionalProperties` to be false.
 */
export const findArticleTool: OpenAI.Responses.Tool = {
  type: "function",
  name: "findArticle",
  description:
    "Look up one article by its slug in the local mock catalog. Use this for any question about a specific article.",
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

export type ParsedArguments =
  | { ok: true; slug: string }
  | { ok: false; error: string };

export type ToolResult =
  | { ok: true; result: FindArticleResult }
  | { ok: false; error: string };

export function parseFindArticleArguments(raw: string): ParsedArguments {
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
    if (key !== "slug") {
      return { ok: false, error: `Unexpected argument: ${key}.` };
    }
  }

  if (!Object.hasOwn(record, "slug")) {
    return { ok: false, error: "Missing required argument: slug." };
  }

  const slug = record.slug;

  if (typeof slug !== "string") {
    return { ok: false, error: "slug must be a string." };
  }

  if (slug.trim() === "") {
    return { ok: false, error: "slug must be a non-empty string." };
  }

  return { ok: true, slug };
}

/**
 * Validate, then run the mock. Invalid arguments never reach findArticle.
 * An unknown tool name is reported back to the model instead of being executed.
 */
export function runFindArticleCall(name: string, rawArguments: string): ToolResult {
  if (name !== "findArticle") {
    return { ok: false, error: `Unknown tool: ${name}.` };
  }

  const parsed = parseFindArticleArguments(rawArguments);

  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, result: findArticle(parsed.slug) };
}
