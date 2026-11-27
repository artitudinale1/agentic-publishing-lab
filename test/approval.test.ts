import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approveDraft, rejectDraft } from "../src/approval";
import { articleRevision, createCatalog, createDraft, findArticle, updateDraft } from "../src/articles";
import { articleTools, runToolCall, toolsFor } from "../src/tools";
import type { EditorialRequest } from "../src/editorial";

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
});
