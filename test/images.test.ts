import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createCatalog, createDraft, type Article } from "../src/articles";
import { createBlogClient, persistValidatedDraft, type RemotePost } from "../src/blog";
import { COVER_FOLDER, createInlineImageUploader } from "../src/cover";
import type { EditorialRequest } from "../src/editorial";
import { instructionsFor, parseCli } from "../src/editorial";
import { checkInlineImages, prepareInlineImages, replaceImagePlaceholders, validateArticleMarkdown, validateResolvedMarkdown } from "../src/images";
import { articleTools, runToolCall } from "../src/tools";

const secret = "agent-secret-0123456789abcdef0123456789";
const apiSecret = "cloudinary-secret-should-not-leak";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const firstUrl = "https://res.cloudinary.com/demo/image/upload/v1/alex-blog/agentic-lab/image-1.png";
const secondUrl = "https://res.cloudinary.com/demo/image/upload/v1/alex-blog/agentic-lab/image-2.png";

function words(count: number): string {
  return Array.from({ length: count }, () => "beta").join(" ");
}

function localDraft(markdown: string, slug = "beta-notes"): Article {
  const catalog = createCatalog();
  const saved = createDraft(catalog, slug, "Beta Notes", "A summary.", markdown, "CODE");
  if (!saved.ok) {
    throw new Error(saved.error);
  }
  return saved.result.article;
}

function remote(markdown: string): RemotePost {
  return {
    id: "post-1",
    slug: "beta-notes",
    title: "Beta Notes",
    excerpt: "A summary.",
    contentMarkdown: markdown,
    category: "CODE",
    status: "DRAFT",
  };
}

describe("inline image input", () => {
  it("assigns stable ids and keeps filesystem paths away from the model", () => {
    const directory = mkdtempSync(join(tmpdir(), "inline-cli-"));
    const articlePath = join(directory, "article.md");
    const imagePath = join(directory, "secret-beta.png");
    writeFileSync(articlePath, "Hello.\n\n![Beta asleep](image:image-1)\n");
    writeFileSync(imagePath, png);

    const existing = parseCli([
      "--mode",
      "existing",
      "--file",
      articlePath,
      "--instructions",
      "Propose a title.",
      "--image",
      imagePath,
    ]);
    assert.equal(existing.images?.[0]?.id, "image-1");
    assert.equal(existing.images?.[0]?.path, imagePath);
    assert.equal(existing.prompt.includes(imagePath), false);
    assert.match(existing.prompt, /image-1/);
    assert.equal(existing.request && instructionsFor(existing.request).includes(imagePath), false);

    const generated = parseCli([
      "--mode",
      "generate",
      "--prompt",
      "Write about Beta.",
      "--image",
      imagePath,
      "--image-description",
      "Beta asleep on the keyboard",
      "--image",
      join(directory, "desk.png"),
      "--image-description",
      "The desk beside the window",
    ]);
    assert.deepEqual(
      generated.images?.map((image) => image.id),
      ["image-1", "image-2"],
    );
    assert.equal(generated.prompt.includes(imagePath), false);
    assert.match(generated.prompt, /image-1: Beta asleep on the keyboard/);
    assert.match(generated.prompt, /image-2: The desk beside the window/);
    assert.ok(generated.request);
    assert.match(instructionsFor(generated.request), /Do not invent image URLs or file paths/);
    assert.equal(JSON.stringify(articleTools).includes('"path"'), false);

    assert.throws(() => parseCli(["--mode", "generate", "--prompt", "Write.", "--image", imagePath]), /image-description/);
    assert.throws(
      () =>
        parseCli([
          "--mode",
          "existing",
          "--file",
          articlePath,
          "--instructions",
          "Propose a title.",
          ...Array.from({ length: 6 }, () => ["--image", imagePath]).flat(),
        ]),
      /five inline images/,
    );
    prepareInlineImages(existing.images ?? [], existing.request?.mode === "existing" ? existing.request.body : undefined, "existing");
    assert.throws(
      () => prepareInlineImages([{ id: "image-1", path: imagePath }], "![Missing](image:image-2)\n", "existing"),
      /Unknown image reference/,
    );
  });

  it("rejects an invented image URL before storing a generated draft", () => {
    const catalog = createCatalog();
    const request: EditorialRequest = {
      mode: "generate",
      prompt: "Write about Beta.",
      length: "short",
      images: [{ id: "image-1", description: "Beta asleep" }],
    };
    const rejected = runToolCall(
      catalog,
      "createDraft",
      JSON.stringify({
        slug: "beta-notes",
        title: "Beta Notes",
        summary: "A summary.",
        body: `![Nope](/home/alex/secret.png)\n\n${words(160)}`,
        category: "CODE",
      }),
      request,
    );
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.match(rejected.error, /Unsafe image URL/);
    }
    assert.equal(catalog.some((article) => article.slug === "beta-notes"), false);

    const accepted = runToolCall(
      catalog,
      "createDraft",
      JSON.stringify({
        slug: "beta-notes",
        title: "Beta Notes",
        summary: "A summary.",
        body: `![Beta asleep](image:image-1)\n\n${words(160)}`,
        category: "CODE",
      }),
      request,
    );
    assert.equal(accepted.ok, true);
    const stored = catalog.find((article) => article.slug === "beta-notes");
    assert.match(stored?.body ?? "", /image:image-1/);
    assert.equal(stored?.body.includes("https://"), false);
  });
});

describe("inline image persistence", () => {
  it("replaces only the placeholder and uploads only the referenced file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inline-live-"));
    const first = join(directory, "beta.png");
    const second = join(directory, "desk.png");
    writeFileSync(first, png);
    writeFileSync(second, png);
    const body = `Intro stays.\n\n![Earlier](https://example.com/already.png)\n\n![Desk](image:image-2)\n\n![Beta asleep](image:image-1)\n\nTail stays.\n`;
    const article = localDraft(body);
    const images = [
      { id: "image-1", path: first, description: "Beta asleep" },
      { id: "image-2", path: second, description: "The desk" },
    ];
    const uploaded: string[] = [];
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { input?: { contentMarkdown?: string; coverImageUrl?: string } };
      };
      if (!payload.query?.includes("mutation")) {
        return Response.json({ data: { editorPosts: [] } });
      }
      const markdown = payload.variables?.input?.contentMarkdown ?? "";
      seen.push(markdown);
      assert.equal(payload.variables?.input?.coverImageUrl, undefined);
      return Response.json({ data: { createPost: remote(markdown) } });
    };

    const report = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: { mode: "existing", instructions: "Keep it.", body, category: "CODE" },
      status: "completed",
      stoppedAtCallLimit: false,
      client: createBlogClient({ url: "https://blog.example/graphql", secret, fetch: fetchImpl, timeoutMs: 50 }),
      images,
      uploadInline: async (filePath: string) => {
        uploaded.push(filePath);
        const secureUrl = filePath === first ? firstUrl : secondUrl;
        return { status: "uploaded", secureUrl };
      },
      log: () => undefined,
    });

    assert.equal(report.persisted, true);
    assert.deepEqual(uploaded, [second, first]);
    assert.equal(article.body, body);
    const stored = seen[0] ?? "";
    assert.equal(stored.includes("image:image-1"), false);
    assert.equal(stored.includes("image:image-2"), false);
    assert.match(stored, /Intro stays\./);
    assert.match(stored, /Tail stays\./);
    assert.match(stored, /https:\/\/example\.com\/already\.png/);
    assert.equal(
      stored,
      body.replace("image:image-2", secondUrl).replace("image:image-1", firstUrl),
    );
  });

  it("does not upload in mock mode, for an unknown reference, or when an image is unused", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inline-skip-"));
    const imagePath = join(directory, "beta.png");
    writeFileSync(imagePath, png);
    let uploads = 0;
    const uploadInline = async (filePath: string) => {
      uploads += 1;
      assert.equal(filePath, imagePath);
      return { status: "uploaded" as const, secureUrl: firstUrl };
    };
    const body = `![Beta asleep](image:image-1)\n\nTail.\n`;
    const article = localDraft(body);
    const unusedPath = join(directory, "unused.png");
    const images = [
      { id: "image-1", path: imagePath },
      { id: "image-2", path: unusedPath },
    ];
    writeFileSync(unusedPath, png);

    const mock = await persistValidatedDraft({
      target: "mock",
      draft: article,
      request: { mode: "existing", instructions: "Keep it.", body },
      status: "completed",
      stoppedAtCallLimit: false,
      images,
      uploadInline,
      log: () => undefined,
    });
    assert.match(mock.message, /not uploaded/);
    assert.equal(uploads, 0);

    const invented = words(160) + "\n\n![Nope](https://example.com/invented.png)\n";
    const rejected = await persistValidatedDraft({
      target: "live",
      draft: localDraft(invented),
      request: { mode: "generate", prompt: "Write.", length: "short", category: "CODE" },
      status: "completed",
      stoppedAtCallLimit: false,
      client: createBlogClient({
        url: "https://blog.example/graphql",
        secret,
        fetch: async () => {
          throw new Error("Blog API should not be called.");
        },
        timeoutMs: 50,
      }),
      images: [{ id: "image-1", path: imagePath, description: "Beta" }],
      uploadInline: async () => {
        uploads += 1;
        return { status: "uploaded", secureUrl: firstUrl };
      },
      log: () => undefined,
    });
    assert.match(rejected.message, /Unknown image reference/);
    assert.equal(uploads, 0);
    const referenced: string[] = [];
    const onlyUsed = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: { mode: "existing", instructions: "Keep it.", body },
      status: "completed",
      stoppedAtCallLimit: false,
      client: createBlogClient({
        url: "https://blog.example/graphql",
        secret,
        fetch: async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as { query?: string };
          if (payload.query?.includes("mutation")) {
            return Response.json({ data: { createPost: remote(body.replace("image:image-1", firstUrl)) } });
          }
          return Response.json({ data: { editorPosts: [] } });
        },
        timeoutMs: 50,
      }),
      images,
      uploadInline: async (filePath: string) => {
        referenced.push(filePath);
        return { status: "uploaded", secureUrl: firstUrl };
      },
      log: () => undefined,
    });
    assert.equal(onlyUsed.persisted, true);
    assert.deepEqual(referenced, [imagePath]);
    assert.equal(checkInlineImages(invented, [], "generate").ok, false);
    assert.equal(replaceImagePlaceholders("![Beta](image:image-1)", new Map([["image-1", firstUrl]])), `![Beta](${firstUrl})`);
  });

  it("reports an orphan when a later upload or createPost does not finish", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inline-orphan-"));
    const first = join(directory, "beta.png");
    const second = join(directory, "desk.png");
    writeFileSync(first, png);
    writeFileSync(second, png);
    const body = `![Beta asleep](image:image-1)\n\n![Desk](image:image-2)\n`;
    const article = localDraft(body);
    const images = [
      { id: "image-1", path: first },
      { id: "image-2", path: second },
    ];
    const request: EditorialRequest = { mode: "existing", instructions: "Keep it.", body, category: "CODE" };
    let mutations = 0;

    const partial = await persistValidatedDraft({
      target: "live",
      draft: article,
      request,
      status: "completed",
      stoppedAtCallLimit: false,
      client: createBlogClient({
        url: "https://blog.example/graphql",
        secret,
        fetch: async () => Response.json({ data: { editorPosts: [] } }),
        timeoutMs: 50,
      }),
      images,
      uploadInline: async (filePath: string) => {
        if (filePath === second) {
          return {
            status: "uncertain" as const,
            message:
              "The inline image upload did not finish. An asset may have been stored in alex-blog/agentic-lab and was not deleted. The upload was not retried.",
          };
        }
        return { status: "uploaded" as const, secureUrl: firstUrl };
      },
      log: () => undefined,
    });
    assert.equal(partial.persisted, false);
    assert.match(partial.message, /was not deleted/);
    assert.match(partial.message, /not retried/);
    assert.equal(partial.message.includes(firstUrl), true);
    assert.equal(partial.message.includes(apiSecret), false);

    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const dropped = await persistValidatedDraft({
      target: "live",
      draft: article,
      request,
      status: "completed",
      stoppedAtCallLimit: false,
      client: createBlogClient({
        url: "https://blog.example/graphql",
        secret,
        fetch: async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as { query?: string };
          if (payload.query?.includes("mutation")) {
            mutations += 1;
            throw timeout;
          }
          return Response.json({ data: { editorPosts: [] } });
        },
        timeoutMs: 50,
      }),
      images,
      uploadInline: async (filePath: string) => ({ status: "uploaded", secureUrl: filePath === first ? firstUrl : secondUrl }),
      log: () => undefined,
    });
    assert.equal(mutations, 1);
    assert.match(dropped.message, /not retried/);
    assert.equal(dropped.message.includes(firstUrl), true);
    assert.equal(dropped.message.includes(secondUrl), true);
    assert.match(dropped.message, /not deleted/);
  });

  it("uploads each inline file once through the SDK and does not retry it", async () => {
    const calls: string[] = [];
    const upload = createInlineImageUploader(
      { cloudName: "demo", apiKey: "123456", apiSecret },
      {
        config() {
          return undefined;
        },
        upload: async (file: string) => {
          calls.push(file);
          return { secure_url: file.endsWith("b.png") ? secondUrl : firstUrl };
        },
      },
    );
    const first = await upload("/tmp/a.png");
    const second = await upload("/tmp/b.png");
    const repeated = await upload("/tmp/a.png");
    assert.equal(first.status, "uploaded");
    assert.deepEqual(calls, ["/tmp/a.png", "/tmp/b.png"]);
    assert.equal(repeated.status, "failed");
    assert.match(repeated.message, /not retried/);
    assert.equal(COVER_FOLDER, "alex-blog/agentic-lab");
  });
});

describe("blog markdown image rules", () => {
  it("requires every generated image and keeps ruby while rejecting other HTML", () => {
    const images = [
      { id: "image-1", description: "Beta asleep" },
      { id: "image-2", description: "The desk" },
    ];
    const embedded = `![Beta asleep](image:image-1)\n\n<ruby>漢字<rt>かんじ</rt></ruby>\n\n![The desk](image:image-2)\n`;
    const accepted = validateArticleMarkdown(embedded, images, "generate");
    assert.equal(accepted.ok, true);
    if (accepted.ok) {
      assert.deepEqual(accepted.referencedIds, ["image-1", "image-2"]);
    }

    const missing = validateArticleMarkdown("![Beta asleep](image:image-1)\n", images, "generate");
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.match(missing.message, /Missing image reference: image-2/);
    }

    const script = validateArticleMarkdown(`${embedded}\n<script>alert(1)</script>\n`, images, "generate");
    assert.equal(script.ok, false);
    if (!script.ok) {
      assert.match(script.message, /Only ruby and rt/);
    }

    const codeSample = "```html\n<script>alert(1)</script>\n```\n\n![Beta asleep](image:image-1)\n\n![The desk](image:image-2)\n";
    assert.equal(validateArticleMarkdown(codeSample, images, "generate").ok, true);

    const resolved = replaceImagePlaceholders(embedded, new Map([
      ["image-1", firstUrl],
      ["image-2", secondUrl],
    ]));
    assert.match(resolved, /<ruby>漢字<rt>かんじ<\/rt><\/ruby>/);
    assert.equal(resolved.includes("image:image-"), false);
    assert.equal(validateResolvedMarkdown(resolved).ok, true);
    const unresolved = validateResolvedMarkdown("![Beta](image:image-1)");
    assert.equal(unresolved.ok, false);
    if (!unresolved.ok) {
      assert.match(unresolved.message, /Unresolved image placeholder/);
    }
    const credentialUrl = validateResolvedMarkdown("![Beta](https://user:pass@res.cloudinary.com/demo/image/upload/v1/a.png)");
    assert.equal(credentialUrl.ok, false);
    if (!credentialUrl.ok) {
      assert.match(credentialUrl.message, /Unsafe image URL/);
    }
  });

  it("rejects a missing image, unsafe URL, or unresolved placeholder before createPost", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inline-rules-"));
    const imagePath = join(directory, "beta.png");
    writeFileSync(imagePath, png);
    let uploads = 0;
    let mutations = 0;
    const uploadInline = async () => {
      uploads += 1;
      return { status: "uploaded" as const, secureUrl: "https://user:pass@res.cloudinary.com/demo/image/upload/v1/a.png" };
    };
    const client = createBlogClient({
      url: "https://blog.example/graphql",
      secret,
      fetch: async (_input, init) => {
        const payload = JSON.parse(String(init?.body)) as { query?: string };
        if (payload.query?.includes("mutation")) {
          mutations += 1;
        }
        return Response.json({ data: { editorPosts: [] } });
      },
      timeoutMs: 50,
    });
    const images = [{ id: "image-1", path: imagePath, description: "Beta asleep" }];
    const body = `![Beta asleep](image:image-1)\n\n<ruby>漢字<rt>かんじ</rt></ruby>\n`;
    const article = localDraft(body);

    const missing = await persistValidatedDraft({
      target: "live",
      draft: localDraft(`![Beta asleep](image:image-1)\n\n${words(160)}`),
      request: {
        mode: "generate",
        prompt: "Write.",
        length: "short",
        category: "CODE",
        images: [
          { id: "image-1", description: "Beta asleep" },
          { id: "image-2", description: "The desk" },
        ],
      },
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      images: [
        images[0]!,
        { id: "image-2", path: imagePath, description: "The desk" },
      ],
      uploadInline,
      log: () => undefined,
    });
    assert.match(missing.message, /Missing image reference: image-2/);
    assert.equal(uploads, 0);
    assert.equal(mutations, 0);

    const scriptBody = `${body}\n<script>alert(1)</script>\n`;
    const script = await persistValidatedDraft({
      target: "live",
      draft: localDraft(scriptBody),
      request: { mode: "existing", instructions: "Keep it.", body: scriptBody },
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      images,
      uploadInline,
      log: () => undefined,
    });
    assert.match(script.message, /Only ruby and rt/);
    assert.equal(uploads, 0);

    const unsafe = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: { mode: "existing", instructions: "Keep it.", body, category: "CODE" },
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      images,
      uploadInline,
      log: () => undefined,
    });
    assert.equal(unsafe.persisted, false);
    assert.match(unsafe.message, /Unsafe image URL|must be https/);
    assert.match(unsafe.message, /not deleted/);
    assert.equal(uploads, 1);
    assert.equal(mutations, 0);
  });
});
