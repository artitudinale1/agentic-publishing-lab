import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findArticle } from "../src/articles";
import { parseFindArticleArguments, runFindArticleCall } from "../src/findArticleTool";

const EXISTING_SLUG = "beta-driven-development";

describe("findArticle", () => {
  it("returns the one existing article", () => {
    const result = findArticle(EXISTING_SLUG);

    assert.equal(result.found, true);
    if (!result.found) {
      return;
    }

    assert.equal(result.article.slug, EXISTING_SLUG);
    assert.equal(
      result.article.title,
      "Beta-Driven Development: An Agentic Architecture for Resource Acquisition",
    );
    assert.equal(
      result.article.summary,
      "Beta is a black-and-white cat specialising in resource acquisition, human interaction, security and operational sustainability.",
    );
  });

  it("reports a missing article", () => {
    const result = findArticle("not-in-the-catalog");

    assert.deepEqual(result, {
      found: false,
      slug: "not-in-the-catalog",
      message: 'No article found for slug "not-in-the-catalog".',
    });
  });
});

describe("findArticle arguments", () => {
  it("accepts a slug string", () => {
    assert.deepEqual(parseFindArticleArguments(JSON.stringify({ slug: EXISTING_SLUG })), {
      ok: true,
      slug: EXISTING_SLUG,
    });
  });

  it("rejects invalid arguments before lookup", () => {
    const cases = [
      ["{", "Arguments are not valid JSON."],
      ["[]", "Arguments must be a JSON object."],
      ["{}", "Missing required argument: slug."],
      [JSON.stringify({ slug: "" }), "slug must be a non-empty string."],
      [JSON.stringify({ slug: "   " }), "slug must be a non-empty string."],
      [JSON.stringify({ slug: 12 }), "slug must be a string."],
      [JSON.stringify({ slug: EXISTING_SLUG, extra: true }), "Unexpected argument: extra."],
    ] as const;

    for (const [raw, error] of cases) {
      const parsed = parseFindArticleArguments(raw);
      assert.deepEqual(parsed, { ok: false, error });

      const outcome = runFindArticleCall("findArticle", raw);
      assert.deepEqual(outcome, { ok: false, error });
    }
  });

  it("runs the mock only after validation succeeds", () => {
    const found = runFindArticleCall(
      "findArticle",
      JSON.stringify({ slug: EXISTING_SLUG }),
    );
    assert.equal(found.ok, true);
    if (!found.ok) {
      return;
    }
    assert.equal(found.result.found, true);

    const missing = runFindArticleCall(
      "findArticle",
      JSON.stringify({ slug: "missing-article" }),
    );
    assert.deepEqual(missing, {
      ok: true,
      result: {
        found: false,
        slug: "missing-article",
        message: 'No article found for slug "missing-article".',
      },
    });
  });
});
