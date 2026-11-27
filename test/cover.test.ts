import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createCatalog, createDraft, type Article } from "../src/articles";
import { createBlogClient, persistValidatedDraft, type RemotePost } from "../src/blog";
import {
  COVER_FOLDER,
  MAX_COVER_BYTES,
  classifyCover,
  createCloudinaryUploader,
  inspectCoverFile,
  readCloudinaryConfig,
} from "../src/cover";
import { parseCli } from "../src/editorial";
import type { EditorialRequest } from "../src/editorial";
import { articleTools } from "../src/tools";

const secret = "agent-secret-0123456789abcdef0123456789";
const apiSecret = "cloudinary-secret-should-not-leak";
const body = "# Feline Cybersecurity\n\nExact body.\n";
const secureUrl = "https://res.cloudinary.com/demo/image/upload/v1/alex-blog/agentic-lab/cat.png";

const existing: EditorialRequest = {
  mode: "existing",
  instructions: "Keep the file.",
  body,
  category: "CODE",
};

function localDraft(markdown: string): Article {
  const catalog = createCatalog();
  const saved = createDraft(catalog, "feline-cybersecurity", "Feline Cybersecurity", "A summary.", markdown, "CODE");
  if (!saved.ok) {
    throw new Error(saved.error);
  }
  return saved.result.article;
}

function remote(markdown = body, coverImageUrl: string | null = secureUrl): RemotePost {
  return {
    id: "post-1",
    slug: "feline-cybersecurity",
    title: "Feline Cybersecurity",
    excerpt: "A summary.",
    contentMarkdown: markdown,
    category: "CODE",
    status: "DRAFT",
    coverImageUrl,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("cover image files", () => {
  it("accepts JPEG, PNG, and WebP contents and rejects other files", () => {
    const directory = mkdtempSync(join(tmpdir(), "cover-"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
    const pngPath = join(directory, "cat.png");
    const jpegPath = join(directory, "cat.jpg");
    const webpPath = join(directory, "cat.webp");
    const disguised = join(directory, "cat.png");
    writeFileSync(pngPath, png);
    writeFileSync(jpegPath, jpeg);
    writeFileSync(webpPath, webp);

    assert.equal(inspectCoverFile(pngPath).mediaType, "image/png");
    assert.equal(inspectCoverFile(jpegPath).mediaType, "image/jpeg");
    assert.equal(inspectCoverFile(webpPath).mediaType, "image/webp");
    writeFileSync(disguised, jpeg);
    assert.throws(() => inspectCoverFile(disguised), /JPEG, PNG, or WebP/);
    assert.throws(() => classifyCover(png, MAX_COVER_BYTES + 1, ".png"), /5 MB/);
    assert.throws(() => classifyCover(Buffer.from("not an image"), 12, ".png"), /JPEG, PNG, or WebP/);
    assert.throws(() => inspectCoverFile(directory), /must be a file/);
  });

  it("reads Cloudinary settings without echoing them", () => {
    assert.throws(() => readCloudinaryConfig({}), /CLOUDINARY_CLOUD_NAME/);
    assert.throws(
      () =>
        readCloudinaryConfig({
          CLOUDINARY_CLOUD_NAME: "demo",
          CLOUDINARY_API_KEY: "replace-me",
          CLOUDINARY_API_SECRET: apiSecret,
        }),
      /CLOUDINARY_API_KEY/,
    );
    const config = readCloudinaryConfig({
      CLOUDINARY_CLOUD_NAME: "demo",
      CLOUDINARY_API_KEY: "123456",
      CLOUDINARY_API_SECRET: apiSecret,
    });
    assert.equal(config.cloudName, "demo");
  });

  it("uploads once through the SDK into the lab folder and does not retry", async () => {
    const uploads: Array<Record<string, unknown>> = [];
    const sdk = {
      config() {
        return undefined;
      },
      upload: async (_file: string, options: Record<string, unknown>) => {
        uploads.push(options);
        return { secure_url: secureUrl };
      },
    };
    const upload = createCloudinaryUploader(
      { cloudName: "demo", apiKey: "123456", apiSecret },
      sdk,
    );

    const stored = await upload("/tmp/cat.png");
    const second = await upload("/tmp/cat.png");

    assert.deepEqual(stored, { status: "uploaded", secureUrl });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]?.folder, COVER_FOLDER);
    assert.equal(uploads[0]?.overwrite, false);
    assert.equal(uploads[0]?.resource_type, "image");
    assert.equal(second.status, "failed");
    assert.equal(second.message.includes(apiSecret), false);

    const failing = createCloudinaryUploader(
      { cloudName: "demo", apiKey: "123456", apiSecret },
      {
        config() {
          return undefined;
        },
        upload: async () => {
          throw Object.assign(new Error(`timeout ${apiSecret}`), { name: "TimeoutError" });
        },
      },
    );
    const uncertain = await failing("/tmp/cat.png");
    assert.equal(uncertain.status, "uncertain");
    assert.match(uncertain.message, /was not deleted/);
    assert.match(uncertain.message, /not retried/);
    assert.equal(uncertain.message.includes(apiSecret), false);

    const rejected = await createCloudinaryUploader(
      { cloudName: "demo", apiKey: "123456", apiSecret },
      {
        config() {
          return undefined;
        },
        upload: async () => {
          throw { http_code: 401, message: apiSecret };
        },
      },
    )("/tmp/cat.png");
    assert.equal(rejected.status, "failed");
    assert.match(rejected.message, /HTTP 401/);
    assert.equal(rejected.message.includes(apiSecret), false);
  });
});

describe("cover persistence", () => {
  it("keeps the cover path out of the model prompt and the tool list", () => {
    const generated = parseCli([
      "--mode",
      "generate",
      "--prompt",
      "Write about Beta.",
      "--cover",
      "/tmp/covers/cat.png",
    ]);
    assert.equal(generated.coverPath, "/tmp/covers/cat.png");
    assert.equal(generated.target, "mock");
    assert.equal(generated.prompt.includes("/tmp/covers/cat.png"), false);

    const supplied = parseCli([
      "--mode",
      "existing",
      "--file",
      "test/fixtures/supplied-article.md",
      "--instructions",
      "Propose a title.",
      "--target",
      "live",
      "--cover",
      "cat.webp",
    ]);
    const free = parseCli(["Write about Beta.", "--cover", "/tmp/covers/cat.png", "--target", "mock"]);
    assert.equal(free.coverPath, "/tmp/covers/cat.png");
    assert.equal(free.prompt, "Write about Beta.");

    assert.equal(supplied.coverPath, "cat.webp");
    assert.equal(supplied.target, "live");
    assert.equal(supplied.prompt.includes("cat.webp"), false);
    assert.equal(
      articleTools.some((tool) => "name" in tool && tool.name.toLowerCase().includes("cover")),
      false,
    );
  });

  it("uploads only after validation and sends the secure URL with the original Markdown", async () => {
    const sequence: string[] = [];
    const article = localDraft(body);
    const directory = mkdtempSync(join(tmpdir(), "cover-live-"));
    const coverPath = join(directory, "cat.png");
    writeFileSync(coverPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const responses = [
      jsonResponse({ data: { editorPosts: [] } }),
      jsonResponse({ data: { createPost: remote() } }),
    ];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { input?: { contentMarkdown?: string; coverImageUrl?: string } };
      };
      if (payload.query?.includes("mutation")) {
        assert.equal(payload.variables?.input?.contentMarkdown, body);
        assert.equal(payload.variables?.input?.coverImageUrl, secureUrl);
      }
      sequence.push(payload.query?.includes("mutation") ? "create" : "lookup");
      const next = responses.shift();
      if (!next) {
        throw new Error("Unexpected blog request.");
      }
      return next;
    };
    const uploadCover = async (filePath: string) => {
      sequence.push("upload");
      assert.equal(filePath, coverPath);
      return { status: "uploaded" as const, secureUrl };
    };
    const client = createBlogClient({
      url: "https://blog.example/graphql",
      secret,
      fetch: fetchImpl,
      timeoutMs: 50,
    });

    const report = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      coverPath,
      uploadCover,
      log: () => undefined,
    });

    assert.equal(report.persisted, true);
    assert.deepEqual(sequence, ["lookup", "upload", "create"]);
    const createCall = sequence.lastIndexOf("create");
    assert.equal(createCall > sequence.indexOf("upload"), true);
  });

  it("does not upload in mock mode, for an invalid draft, or when the upload is uncertain", async () => {
    const article = localDraft(body);
    const directory = mkdtempSync(join(tmpdir(), "cover-skip-"));
    const coverPath = join(directory, "cat.png");
    writeFileSync(coverPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    let uploads = 0;
    const uploadCover = async () => {
      uploads += 1;
      return {
        status: "uncertain" as const,
        message:
          "The cover upload did not finish. An asset may have been stored in alex-blog/agentic-lab and was not deleted. The upload was not retried.",
      };
    };
    const fetchImpl: typeof fetch = async () => {
      throw new Error("Blog API should not be called.");
    };
    const client = createBlogClient({
      url: "https://blog.example/graphql",
      secret,
      fetch: fetchImpl,
      timeoutMs: 50,
    });

    const mock = await persistValidatedDraft({
      target: "mock",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      coverPath,
      uploadCover,
      log: () => undefined,
    });
    const invalid = await persistValidatedDraft({
      target: "live",
      draft: localDraft("too short"),
      request: { mode: "generate", prompt: "Write", length: "short", category: "CODE" },
      status: "completed",
      stoppedAtCallLimit: false,
      client,
      coverPath,
      uploadCover,
      log: () => undefined,
    });

    assert.match(mock.message, /not uploaded/);
    assert.match(invalid.message, /failed validation/);
    assert.equal(uploads, 0);

    const calls: string[] = [];
    const liveFetch: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { query?: string };
      calls.push(payload.query?.includes("mutation") ? "create" : "lookup");
      return jsonResponse({ data: { editorPosts: [] } });
    };
    const uncertain = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client: createBlogClient({
        url: "https://blog.example/graphql",
        secret,
        fetch: liveFetch,
        timeoutMs: 50,
      }),
      coverPath,
      uploadCover,
      log: () => undefined,
    });
    assert.match(uncertain.message, /was not deleted/);
    assert.deepEqual(calls, ["lookup"]);
    assert.equal(uploads, 1);
  });

  it("reports an orphaned upload when createPost does not finish", async () => {
    const article = localDraft(body);
    const directory = mkdtempSync(join(tmpdir(), "cover-orphan-"));
    const coverPath = join(directory, "cat.png");
    writeFileSync(coverPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    let uploads = 0;
    let mutations = 0;
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const responses: Array<Response | Error> = [
      jsonResponse({ data: { editorPosts: [] } }),
      timeout,
    ];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        query?: string;
        variables?: { input?: { contentMarkdown?: string; coverImageUrl?: string } };
      };
      if (payload.query?.includes("mutation")) {
        mutations += 1;
        assert.equal(payload.variables?.input?.contentMarkdown, body);
        assert.equal(payload.variables?.input?.coverImageUrl, secureUrl);
      }
      const next = responses.shift();
      if (next instanceof Error) {
        throw next;
      }
      if (!next) {
        throw new Error("Unexpected blog request.");
      }
      return next;
    };

    const report = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client: createBlogClient({
        url: "https://blog.example/graphql",
        secret,
        fetch: fetchImpl,
        timeoutMs: 50,
      }),
      coverPath,
      uploadCover: async () => {
        uploads += 1;
        return { status: "uploaded", secureUrl };
      },
      log: () => undefined,
    });

    assert.equal(report.persisted, false);
    assert.match(report.message, /may or may not exist/);
    assert.match(report.message, /not retried/);
    assert.match(report.message, /was not deleted/);
    assert.equal(report.message.includes(secureUrl), true);
    assert.equal(uploads, 1);
    assert.equal(mutations, 1);
  });

  it("does not upload when the remote slug already exists or the run did not finish", async () => {
    const article = localDraft(body);
    const directory = mkdtempSync(join(tmpdir(), "cover-existing-"));
    const coverPath = join(directory, "cat.png");
    writeFileSync(coverPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    let uploads = 0;
    const uploadCover = async () => {
      uploads += 1;
      return { status: "uploaded" as const, secureUrl };
    };
    const found = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "completed",
      stoppedAtCallLimit: false,
      client: createBlogClient({
        url: "https://blog.example/graphql",
        secret,
        fetch: async () => jsonResponse({ data: { editorPosts: [remote(body, null)] } }),
        timeoutMs: 50,
      }),
      coverPath,
      uploadCover,
      log: () => undefined,
    });
    const unfinished = await persistValidatedDraft({
      target: "live",
      draft: article,
      request: existing,
      status: "incomplete",
      stoppedAtCallLimit: false,
      client: createBlogClient({
        url: "https://blog.example/graphql",
        secret,
        fetch: async () => {
          throw new Error("Blog API should not be called.");
        },
        timeoutMs: 50,
      }),
      coverPath,
      uploadCover,
      log: () => undefined,
    });

    assert.match(found.message, /not overwritten/);
    assert.match(found.message, /not uploaded/);
    assert.match(unfinished.message, /did not finish/);
    assert.equal(uploads, 0);
  });
});
