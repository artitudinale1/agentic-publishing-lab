import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approveDraft, rejectDraft } from "../src/approval";
import { articleRevision, createCatalog, createDraft, findArticle, updateDraft } from "../src/articles";
import {
  BLOG_EXCERPT_MAX_LENGTH,
  BLOG_FIELD_LIMITS,
  BLOG_MARKDOWN_MAX_LENGTH,
  BLOG_SLUG_MAX_LENGTH,
  BLOG_TITLE_MAX_LENGTH,
} from "../src/blog-limits";
import { instructionsFor, type EditorialRequest } from "../src/editorial";
import { articleTools, runToolCall, toolsFor } from "../src/tools";

const request: EditorialRequest = {
  mode: "generate",
  prompt: "Write about Beta.",
  length: "short",
  category: "CATS",
};

function words(count: number): string {
  return Array.from({ length: count }, () => "word").join(" ");
}

function toolNames(tools: readonly object[]): string[] {
  return tools.map((tool) => ("name" in tool && typeof tool.name === "string" ? tool.name : ""));
}

describe("article validation and human approval", () => {
  it("saves a draft before validation or approval", () => {
    const catalog = createCatalog();
    const saved = createDraft(catalog, "office-notes", "Office Notes", "A summary.", words(10), "CATS");

    assert.equal(saved.ok, true);
    const found = findArticle(catalog, "office-notes");
    assert.equal(found.found, true);
    if (!found.found) {
      return;
    }
    assert.equal(found.article.status, "draft");
    assert.equal(found.article.validatedRevision, null);
    assert.equal(found.article.approvedRevision, null);
    assert.equal(found.article.body, words(10));
  });

  it("validates a generated draft inside the word range and preserves an existing body", () => {
    const generated = createCatalog();
    createDraft(generated, "beta-notes", "Beta Notes", "A summary.", words(200), "CATS");
    const generatedArticle = generated.find((entry) => entry.slug === "beta-notes");
    assert.ok(generatedArticle);
    const valid = runToolCall(generated, "validateArticle", JSON.stringify({ slug: "beta-notes" }), request);
    assert.equal(valid.ok, true);
    if (!valid.ok || !("valid" in valid.result)) {
      return;
    }
    assert.equal(valid.result.valid, true);
    assert.equal(valid.result.wordCount, 200);
    assert.equal(valid.result.revision, articleRevision(generatedArticle));
    assert.equal(generatedArticle.validatedRevision, valid.result.revision);
    assert.equal("body" in valid.result, false);

    const short = runToolCall(generated, "validateArticle", JSON.stringify({ slug: "beta-notes" }), {
      ...request,
      length: "long",
    });
    assert.equal(short.ok, false);
    if (short.ok || !short.validation || !("issues" in short.validation)) {
      return;
    }
    assert.equal(short.validation.issues[0]?.code, "too_short");
    assert.equal(generatedArticle.status, "draft");
    assert.equal(generatedArticle.validatedRevision, null);

    const existingRequest: EditorialRequest = {
      mode: "existing",
      instructions: "Keep the file.",
      body: "Supplied body.\n",
      category: "COOKING",
    };
    const existing = createCatalog();
    createDraft(existing, "kitchen-notes", "Kitchen Notes", "A summary.", "Supplied body.\n", "COOKING");
    const preserved = runToolCall(
      existing,
      "validateArticle",
      JSON.stringify({ slug: "kitchen-notes" }),
      existingRequest,
    );
    assert.equal(preserved.ok, true);

    const changed = existing.find((entry) => entry.slug === "kitchen-notes");
    assert.ok(changed);
    changed.body = "Rewritten.\n";
    const broken = runToolCall(
      existing,
      "validateArticle",
      JSON.stringify({ slug: "kitchen-notes" }),
      existingRequest,
    );
    assert.equal(broken.ok, false);
    if (broken.ok || !broken.validation || !("issues" in broken.validation)) {
      return;
    }
    assert.equal(broken.validation.issues.some((issue) => issue.code === "body_changed"), true);
    assert.equal(changed.status, "draft");
    assert.equal(changed.body, "Rewritten.\n");
  });

  it("rejects an invalid slug and category without deleting the draft", () => {
    const catalog = createCatalog();
    createDraft(catalog, "Bad Slug", "Title", "Summary", "Body text.", "CODE");
    const outcome = runToolCall(catalog, "validateArticle", JSON.stringify({ slug: "Bad Slug" }));
    assert.equal(outcome.ok, false);
    if (outcome.ok || !outcome.validation || !("issues" in outcome.validation)) {
      return;
    }
    assert.deepEqual(
      outcome.validation.issues.map((issue) => issue.code),
      ["invalid_slug"],
    );
    const found = findArticle(catalog, "Bad Slug");
    assert.equal(found.found, true);
    if (!found.found) {
      return;
    }
    assert.equal(found.article.validatedRevision, null);
    assert.equal(found.article.approvedRevision, null);
  });

  it("rejects a category that disagrees with the editorial request before saving", () => {
    const catalog = createCatalog();
    const outcome = runToolCall(
      catalog,
      "createDraft",
      JSON.stringify({
        slug: "code-notes",
        title: "Code Notes",
        summary: "A summary.",
        body: words(180),
        category: "CODE",
      }),
      request,
    );

    assert.deepEqual(outcome, { ok: false, error: "Category must be CATS." });
    assert.equal(findArticle(catalog, "code-notes").found, false);

    const unsupported = runToolCall(
      catalog,
      "createDraft",
      JSON.stringify({
        slug: "food-notes",
        title: "Food Notes",
        summary: "A summary.",
        body: words(180),
        category: "FOOD",
      }),
      request,
    );
    assert.deepEqual(unsupported, {
      ok: false,
      error: "Category must be CODE, JAPANESE, CATS, or COOKING.",
    });
    assert.equal(findArticle(catalog, "food-notes").found, false);
  });

  it("approves only the validated revision and clears that approval after a change", () => {
    const catalog = createCatalog();
    createDraft(catalog, "beta-notes", "Beta Notes", "A summary.", words(180), "CATS");
    const validated = runToolCall(
      catalog,
      "validateArticle",
      JSON.stringify({ slug: "beta-notes" }),
      request,
    );
    assert.equal(validated.ok, true);
    if (!validated.ok || !("revision" in validated.result)) {
      return;
    }

    const revision = validated.result.revision;
    assert.deepEqual(approveDraft(catalog, "beta-notes", "stale-revision"), {
      ok: false,
      error: "Approval revision does not match the saved draft.",
    });
    assert.deepEqual(approveDraft(catalog, "beta-notes", revision), {
      ok: true,
      approved: true,
      slug: "beta-notes",
      revision,
    });

    const approved = findArticle(catalog, "beta-notes");
    assert.equal(approved.found, true);
    if (!approved.found) {
      return;
    }
    assert.equal(approved.article.status, "draft");
    assert.equal(approved.article.approvedRevision, revision);

    assert.deepEqual(rejectDraft(catalog, "beta-notes"), {
      ok: true,
      rejected: true,
      slug: "beta-notes",
    });
    const rejected = findArticle(catalog, "beta-notes");
    assert.equal(rejected.found, true);
    if (!rejected.found) {
      return;
    }
    assert.equal(rejected.article.approvedRevision, null);
    assert.equal(rejected.article.validatedRevision, revision);
    assert.equal(rejected.article.body, words(180));

    assert.equal(approveDraft(catalog, "beta-notes", revision).ok, true);
    const updated = updateDraft(catalog, "beta-notes", "Beta Notes, revised", "A new summary.");
    assert.equal(updated.ok, true);
    const changed = findArticle(catalog, "beta-notes");
    assert.equal(changed.found, true);
    if (!changed.found) {
      return;
    }
    assert.equal(changed.article.validatedRevision, null);
    assert.equal(changed.article.approvedRevision, null);
    assert.equal(changed.article.status, "draft");
    assert.notEqual(changed.article.revision, revision);

    assert.deepEqual(approveDraft(catalog, "beta-notes", revision), {
      ok: false,
      error: "Approval revision does not match the saved draft.",
    });
    assert.deepEqual(approveDraft(catalog, "beta-notes", changed.article.revision), {
      ok: false,
      error: "Draft must be validated before approval.",
    });
    assert.equal(changed.article.title, "Beta Notes, revised");
  });

  it("does not let the model approve or publish", () => {
    const catalog = createCatalog();
    createDraft(catalog, "beta-notes", "Beta Notes", "A summary.", words(180), "CATS");
    runToolCall(catalog, "validateArticle", JSON.stringify({ slug: "beta-notes" }), request);

    const approve = runToolCall(
      catalog,
      "approveDraft",
      JSON.stringify({ slug: "beta-notes" }),
      request,
    );
    const publish = runToolCall(
      catalog,
      "publishDraft",
      JSON.stringify({ slug: "beta-notes" }),
      request,
    );

    assert.deepEqual(approve, { ok: false, error: "Unknown tool: approveDraft." });
    assert.deepEqual(publish, { ok: false, error: "Unknown tool: publishDraft." });

    const found = findArticle(catalog, "beta-notes");
    assert.equal(found.found, true);
    if (!found.found) {
      return;
    }
    assert.equal(found.article.status, "draft");
    assert.equal(found.article.approvedRevision, null);
    assert.equal(toolNames(articleTools).includes("approveDraft"), false);
    assert.equal(toolNames(articleTools).includes("publishDraft"), false);
    assert.equal(toolNames(toolsFor(request)).includes("validateArticle"), true);
    assert.equal(toolNames(toolsFor(request)).includes("publishDraft"), false);
  });

  it("accepts blog field limits at the boundary and rejects one character over", () => {
    const existing = (body: string): EditorialRequest => ({
      mode: "existing",
      instructions: "Keep the file.",
      body,
      category: "CODE",
    });
    const title = "T".repeat(BLOG_TITLE_MAX_LENGTH);
    const paddedTitle = ` ${title} `;
    const slug = "a".repeat(BLOG_SLUG_MAX_LENGTH);
    const summary = ` ${"s".repeat(BLOG_EXCERPT_MAX_LENGTH)} `;
    const markdown = "m".repeat(BLOG_MARKDOWN_MAX_LENGTH);
    const catalog = createCatalog();
    const accepted = runToolCall(
      catalog,
      "createDraft",
      JSON.stringify({ slug, title: paddedTitle, summary, category: "CODE" }),
      existing(markdown),
    );

    assert.equal(accepted.ok, true);
    const stored = catalog.find((entry) => entry.slug === slug);
    assert.ok(stored);
    assert.equal(stored.title, paddedTitle);
    assert.equal(stored.summary, summary);
    assert.equal(stored.body, markdown);
    const validated = runToolCall(catalog, "validateArticle", JSON.stringify({ slug }), existing(markdown));
    assert.equal(validated.ok, true);

    const cases = [
      {
        slug: "title-over",
        title: "T".repeat(BLOG_TITLE_MAX_LENGTH + 1),
        summary: "A summary.",
        body: "Body.\n",
        code: "title_too_long",
        length: BLOG_TITLE_MAX_LENGTH + 1,
        maxLength: BLOG_TITLE_MAX_LENGTH,
      },
      {
        slug: "b".repeat(BLOG_SLUG_MAX_LENGTH + 1),
        title: "Title",
        summary: "A summary.",
        body: "Body.\n",
        code: "slug_too_long",
        length: BLOG_SLUG_MAX_LENGTH + 1,
        maxLength: BLOG_SLUG_MAX_LENGTH,
      },
      {
        slug: "excerpt-over",
        title: "Title",
        summary: "s".repeat(BLOG_EXCERPT_MAX_LENGTH + 1),
        body: "Body.\n",
        code: "excerpt_too_long",
        length: BLOG_EXCERPT_MAX_LENGTH + 1,
        maxLength: BLOG_EXCERPT_MAX_LENGTH,
      },
      {
        slug: "markdown-over",
        title: "Title",
        summary: "A summary.",
        body: `${"m".repeat(BLOG_MARKDOWN_MAX_LENGTH)}\n`,
        code: "markdown_too_long",
        length: BLOG_MARKDOWN_MAX_LENGTH + 1,
        maxLength: BLOG_MARKDOWN_MAX_LENGTH,
      },
    ];

    for (const item of cases) {
      const next = createCatalog();
      const outcome = runToolCall(
        next,
        "createDraft",
        JSON.stringify({
          slug: item.slug,
          title: item.title,
          summary: item.summary,
          category: "CODE",
        }),
        existing(item.body),
      );
      assert.equal(outcome.ok, false);
      assert.equal(findArticle(next, item.slug).found, false);
      if (outcome.ok || !outcome.validation || !("issues" in outcome.validation)) {
        assert.fail("Expected structured field issues.");
      }
      assert.equal(outcome.validation.issues.length, 1);
      assert.equal(outcome.validation.issues[0]?.code, item.code);
      assert.equal(outcome.validation.issues[0]?.length, item.length);
      assert.equal(outcome.validation.issues[0]?.maxLength, item.maxLength);
    }

    const both = createCatalog();
    const combined = runToolCall(
      both,
      "createDraft",
      JSON.stringify({
        slug: "both-over",
        title: "T".repeat(BLOG_TITLE_MAX_LENGTH + 1),
        summary: "s".repeat(BLOG_EXCERPT_MAX_LENGTH + 1),
        category: "CODE",
      }),
      existing("Body.\n"),
    );
    assert.equal(combined.ok, false);
    if (combined.ok || !combined.validation || !("issues" in combined.validation)) {
      assert.fail("Expected structured field issues.");
    }
    assert.deepEqual(
      combined.validation.issues.map((issue) => issue.code),
      ["title_too_long", "excerpt_too_long"],
    );
    assert.equal(findArticle(both, "both-over").found, false);

    const revision = createCatalog();
    createDraft(revision, "office-notes", "Office Notes", "A summary.", "Body.\n", "CODE");
    const blocked = runToolCall(
      revision,
      "updateDraft",
      JSON.stringify({
        slug: "office-notes",
        title: "Office Notes",
        summary: "s".repeat(BLOG_EXCERPT_MAX_LENGTH + 1),
      }),
    );
    assert.equal(blocked.ok, false);
    if (blocked.ok || !blocked.validation || !("issues" in blocked.validation)) {
      assert.fail("Expected structured field issues.");
    }
    assert.equal(blocked.validation.issues[0]?.code, "excerpt_too_long");
    assert.equal(revision.find((entry) => entry.slug === "office-notes")?.summary, "A summary.");

    const storedLong = createCatalog();
    createDraft(storedLong, "long-excerpt", "Title", "s".repeat(BLOG_EXCERPT_MAX_LENGTH + 1), "Body.\n", "CODE");
    const rejected = runToolCall(storedLong, "validateArticle", JSON.stringify({ slug: "long-excerpt" }));
    assert.equal(rejected.ok, false);
    if (rejected.ok || !rejected.validation || !("issues" in rejected.validation)) {
      assert.fail("Expected structured field issues.");
    }
    assert.equal(rejected.validation.issues[0]?.code, "excerpt_too_long");
    assert.equal(findArticle(storedLong, "long-excerpt").found, true);

    const instructions = instructionsFor(existing("Body.\n"));
    assert.ok(instructions.includes(BLOG_FIELD_LIMITS));
    assert.match(instructions, /submit a shorter value/);
    const createTool = toolsFor(existing("Body.\n")).find((tool) => "name" in tool && tool.name === "createDraft");
    assert.equal(createTool && "description" in createTool && createTool.description?.includes(BLOG_FIELD_LIMITS), true);
    const updateTool = toolsFor(existing("Body.\n")).find((tool) => "name" in tool && tool.name === "updateDraft");
    assert.equal(updateTool && "description" in updateTool && updateTool.description?.includes("300"), true);
  });
});
