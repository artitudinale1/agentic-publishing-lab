import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDraft, createCatalog } from "../src/articles";
import {
  CREATE_POST_MUTATION,
  EDITOR_POSTS_QUERY,
  createBlogClient,
  persistValidatedDraft,
  readBlogConfig,
  type RemotePost,
} from "../src/blog";
import type { EditorialRequest } from "../src/editorial";
import type { Article } from "../src/articles";

const secret = "agent-secret-0123456789abcdef0123456789";
const url = "https://blog.example/graphql";
const body = "# Feline Cybersecurity\n\nExact body.\n";

const existing: EditorialRequest = {
  mode: "existing",
  instructions: "Keep the file.",
  body,
  category: "CODE",
};

function localDraft(markdown: string, slug = "feline-cybersecurity"): Article {
  const catalog = createCatalog();
  const saved = createDraft(catalog, slug, "Feline Cybersecurity", "A summary.", markdown, "CODE");
  if (!saved.ok) {
    throw new Error(saved.error);
  }
  return saved.result.article;
}

function remote(slug: string, markdown = body, status: RemotePost["status"] = "DRAFT"): RemotePost {
  return {
    id: `id-${slug}`,
    slug,
    title: "Feline Cybersecurity",
    excerpt: "A summary.",
    contentMarkdown: markdown,
    category: "CODE",
    status,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordedFetch(responses: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) {
      throw new Error("The blog client made a request the test did not expect.");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { fetch: fetchImpl, calls };
}

function operation(init: RequestInit | undefined): string {
  const payload = JSON.parse(String(init?.body)) as { query?: string; variables?: { input?: { contentMarkdown?: string } } };
  return payload.query ?? "";
}

function markdownSent(init: RequestInit | undefined): string | undefined {
  const payload = JSON.parse(String(init?.body)) as { variables?: { input?: { contentMarkdown?: string } } };
  return payload.variables?.input?.contentMarkdown;
}

describe("blog configuration", () => {
  it("fails closed when live settings are missing or too short", () => {
    assert.throws(() => readBlogConfig({}), /BLOG_API_URL/);
    assert.throws(() => readBlogConfig({ BLOG_API_URL: "https://blog.example/graphql" }), /AGENT_API_SECRET/);
    assert.throws(
      () => readBlogConfig({ BLOG_API_URL: "replace-me", AGENT_API_SECRET: secret }),
      /BLOG_API_URL/,
    );
    assert.throws(
      () => readBlogConfig({ BLOG_API_URL: "https://blog.example/graphql", AGENT_API_SECRET: "replace-me" }),
      /AGENT_API_SECRET/,
    );
    assert.throws(
      () => readBlogConfig({ BLOG_API_URL: "https://blog.example/graphql", AGENT_API_SECRET: "short-secret" }),
      /at least 32 characters/,
    );
    assert.throws(() => readBlogConfig({ BLOG_API_URL: "ftp://blog.example", AGENT_API_SECRET: secret }), /http/);
  });

  it("points the client at the GraphQL endpoint", () => {
    assert.equal(
      readBlogConfig({ BLOG_API_URL: "https://blog.example/graphql", AGENT_API_SECRET: secret }).url,
      "https://blog.example/graphql",
    );
    assert.equal(
      readBlogConfig({ BLOG_API_URL: "https://blog.example", AGENT_API_SECRET: secret }).url,
      "https://blog.example/graphql",
    );
    assert.equal(CREATE_POST_MUTATION.includes("publishPost"), false);
    assert.equal(CREATE_POST_MUTATION.includes("unpublishPost"), false);
    assert.equal(EDITOR_POSTS_QUERY.includes("publishPost"), false);
  });
});

describe("blog persistence", () => {
  it("stores a validated draft and keeps the Markdown unchanged", async () => {
    const article = localDraft(body);
    const script = recordedFetch([
      jsonResponse({ data: { editorPosts: [] } }),
      jsonResponse({ data: { createPost: remote(article.slug) } }),
    ]);
    const client = createBlogClient({ url, secret, fetch: script.fetch, timeoutMs: 50 });

    const report = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      log: () => undefined,
    });

    assert.equal(report.persisted, true);
    assert.match(report.message, /status=DRAFT/);
    assert.equal(script.calls.length, 2);
    assert.equal(operation(script.calls[0]?.init).includes("editorPosts"), true);
    assert.equal(operation(script.calls[1]?.init).includes("mutation CreatePost"), true);
    assert.equal(markdownSent(script.calls[1]?.init), body);
    const headers = new Headers(script.calls[0]?.init.headers);
    assert.equal(headers.get("x-agent-authorization"), `Bearer ${secret}`);
    assert.equal(report.message.includes(secret), false);
  });

  it("pages through drafts and does not treat a failed later page as absence", async () => {
    const article = localDraft(body);
    const fullPage = Array.from({ length: 50 }, (_item, index) => remote(`other-${index}`, "Other"));
    const found = recordedFetch([
      jsonResponse({ data: { editorPosts: fullPage } }),
      jsonResponse({ data: { editorPosts: [remote(article.slug)] } }),
    ]);
    const foundClient = createBlogClient({ url, secret, fetch: found.fetch, timeoutMs: 50 });
    const duplicate = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client: foundClient,
      log: () => undefined,
    });
    assert.equal(duplicate.persisted, false);
    assert.match(duplicate.message, /already exists/);
    assert.equal(found.calls.length, 2);
    assert.equal(found.calls.every((call) => operation(call.init).includes("editorPosts")), true);

    const broken = recordedFetch([
      jsonResponse({ data: { editorPosts: fullPage } }),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const brokenClient = createBlogClient({ url, secret, fetch: broken.fetch, timeoutMs: 50 });
    const uncertain = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client: brokenClient,
      log: () => undefined,
    });
    assert.equal(uncertain.persisted, false);
    assert.match(uncertain.message, /not treated as missing/);
    assert.equal(broken.calls.length, 3);
    assert.equal(broken.calls.every((call) => operation(call.init).includes("editorPosts")), true);
  });

  it("reports authentication failure and does not create a post", async () => {
    const script = recordedFetch([
      jsonResponse({
        errors: [{ message: "Invalid agent credentials", extensions: { code: "UNAUTHENTICATED" } }],
      }),
    ]);
    const client = createBlogClient({ url, secret, fetch: script.fetch, timeoutMs: 50 });
    const report = await persistValidatedDraft({
      target: "live",
      draft: localDraft(body),
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      log: () => undefined,
    });

    assert.equal(report.persisted, false);
    assert.equal(report.message, "Invalid agent credentials");
    assert.equal(script.calls.length, 1);
  });

  it("does not overwrite when createPost reports a duplicate slug", async () => {
    const script = recordedFetch([
      jsonResponse({ data: { editorPosts: [] } }),
      jsonResponse({ errors: [{ message: "slug already exists", extensions: { code: "BAD_USER_INPUT" } }] }),
    ]);
    const client = createBlogClient({ url, secret, fetch: script.fetch, timeoutMs: 50 });
    const report = await persistValidatedDraft({
      target: "live",
      draft: localDraft(body),
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      log: () => undefined,
    });

    assert.equal(report.persisted, false);
    assert.match(report.message, /not overwritten/);
    assert.equal(script.calls.length, 2);
  });

  it("does not send an invalid draft or a draft from an unfinished run", async () => {
    const called = recordedFetch([]);
    const client = createBlogClient({ url, secret, fetch: called.fetch, timeoutMs: 50 });
    const invalid = await persistValidatedDraft({
      target: "live",
      draft: localDraft("too short"),
      request: { mode: "generate", prompt: "Write", length: "short", category: "CODE" },
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      log: () => undefined,
    });
    const unfinished = await persistValidatedDraft({
      target: "live",
      draft: localDraft(body),
      request: existing,
      status: "incomplete",
      stoppedAtCallLimit: false,
      client,
      log: () => undefined,
    });
    const limited = await persistValidatedDraft({
      target: "live",
      draft: localDraft(body),
      request: existing,
      status: "completed",
      stoppedAtCallLimit: true,
      client,
      log: () => undefined,
    });

    assert.match(invalid.message, /failed validation/);
    assert.match(unfinished.message, /did not finish/);
    assert.match(limited.message, /did not finish/);
    assert.equal(called.calls.length, 0);
  });

  it("retries a cold lookup once and does not retry a mutation", async () => {
    const article = localDraft(body);
    const cold = recordedFetch([
      new Response("starting", { status: 503 }),
      jsonResponse({ data: { editorPosts: [] } }),
      jsonResponse({ data: { createPost: remote(article.slug) } }),
    ]);
    const coldClient = createBlogClient({ url, secret, fetch: cold.fetch, timeoutMs: 50 });
    const stored = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client: coldClient,
      log: () => undefined,
    });
    assert.equal(stored.persisted, true);
    assert.equal(cold.calls.length, 3);

    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const dropped = recordedFetch([
      jsonResponse({ data: { editorPosts: [] } }),
      timeout,
    ]);
    const droppedClient = createBlogClient({ url, secret, fetch: dropped.fetch, timeoutMs: 50 });
    const uncertain = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client: droppedClient,
      log: () => undefined,
    });
    assert.equal(uncertain.persisted, false);
    assert.match(uncertain.message, /may or may not exist/);
    assert.match(uncertain.message, /not retried/);
    assert.equal(dropped.calls.length, 2);
    assert.equal(operation(dropped.calls[1]?.init).includes("mutation CreatePost"), true);
  });

  it("keeps a validated mock draft in memory", async () => {
    const called = recordedFetch([]);
    const report = await persistValidatedDraft({
      target: "mock",
      draft: localDraft(body),
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client: createBlogClient({ url, secret, fetch: called.fetch, timeoutMs: 50 }),
      log: () => undefined,
    });

    assert.equal(report.persisted, false);
    assert.match(report.message, /in memory/);
    assert.equal(called.calls.length, 0);
  });
});
