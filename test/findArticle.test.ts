import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCatalog, findArticle } from "../src/articles";
import { parseToolArguments, runToolCall } from "../src/tools";

const EXISTING_SLUG = "beta-driven-development";

describe("findArticle", () => {
  it("returns the published seed article", () => {
    const result = findArticle(createCatalog(), EXISTING_SLUG);

    assert.equal(result.found, true);
    if (!result.found) {
      return;
    }

    assert.equal(result.article.slug, EXISTING_SLUG);
    assert.equal(result.article.status, "published");
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
    const result = findArticle(createCatalog(), "not-in-the-catalog");

    assert.deepEqual(result, {
      found: false,
      slug: "not-in-the-catalog",
      message: 'No article found for slug "not-in-the-catalog".',
    });
  });
});

describe("findArticle arguments", () => {
  it("accepts a slug string", () => {
    assert.deepEqual(parseToolArguments(JSON.stringify({ slug: EXISTING_SLUG }), ["slug"]), {
      ok: true,
      values: { slug: EXISTING_SLUG },
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
      const parsed = parseToolArguments(raw, ["slug"]);
      assert.deepEqual(parsed, { ok: false, error });

      const outcome = runToolCall(createCatalog(), "findArticle", raw);
      assert.deepEqual(outcome, { ok: false, error });
    }
  });

  it("runs the lookup only after validation succeeds", () => {
    const found = runToolCall(createCatalog(), "findArticle", JSON.stringify({ slug: EXISTING_SLUG }));
    assert.equal(found.ok, true);
    if (!found.ok || !("found" in found.result)) {
      return;
    }
    assert.equal(found.result.found, true);

    const missing = runToolCall(
      createCatalog(),
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
