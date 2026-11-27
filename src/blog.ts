import type { Article, ArticleCategory } from "./articles";
import type { CoverUploader } from "./cover";
import { inspectCoverFile } from "./cover";
import type { EditorialRequest, RunTarget } from "./editorial";
import { validateStoredArticle } from "./validation";

/** One GraphQL request. Mutations are not retried. */
export const BLOG_REQUEST_TIMEOUT_MS = 60_000;

const PAGE_SIZE = 50;
const MAX_OFFSET = 100_000;

export const EDITOR_POSTS_QUERY = `query EditorPosts($limit: Int!, $offset: Int!) {
  editorPosts(limit: $limit, offset: $offset) {
    id
    slug
    title
    excerpt
    contentMarkdown
    category
    status
  }
}`;

export const CREATE_POST_MUTATION = `mutation CreatePost($input: PostInput!) {
  createPost(input: $input) {
    id
    slug
    title
    excerpt
    contentMarkdown
    category
    status
    coverImageUrl
  }
}`;

export type RemotePost = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  contentMarkdown: string;
  category: ArticleCategory;
  status: "DRAFT" | "PUBLISHED";
  coverImageUrl?: string | null;
};

export type BlogConfig = {
  url: string;
  secret: string;
};

export type LookupResult =
  | { status: "found"; post: RemotePost }
  | { status: "absent" }
  | { status: "auth"; message: string }
  | { status: "uncertain"; message: string };

export type CreateRemoteResult =
  | { status: "created"; post: RemotePost }
  | { status: "duplicate"; message: string }
  | { status: "auth"; message: string }
  | { status: "rejected"; message: string }
  | { status: "uncertain"; message: string }
  | { status: "mismatch"; post: RemotePost; message: string };

type GraphQLErrorBody = {
  message?: string;
  extensions?: { code?: string };
};

type CallFailure = {
  ok: false;
  retryable: boolean;
  outcome: "auth" | "duplicate" | "rejected" | "uncertain";
  message: string;
};

type CallSuccess<T> = { ok: true; data: T };

export function readBlogConfig(env: NodeJS.ProcessEnv): BlogConfig {
  const url = env.BLOG_API_URL?.trim() ?? "";
  const secret = env.AGENT_API_SECRET?.trim() ?? "";

  if (!url || url === "replace-me") {
    throw new Error("Set BLOG_API_URL. Live mode needs the blog GraphQL endpoint.");
  }

  if (!secret || secret === "replace-me") {
    throw new Error("Set AGENT_API_SECRET. Live mode needs the agent secret.");
  }

  if (secret.length < 32) {
    throw new Error("AGENT_API_SECRET must be at least 32 characters.");
  }

  return { url: blogGraphqlUrl(url), secret };
}

export function blogGraphqlUrl(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("BLOG_API_URL must be an http(s) URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("BLOG_API_URL must be an http(s) URL.");
  }

  const path = parsed.pathname.replace(/\/$/, "");
  parsed.pathname = path.endsWith("/graphql") ? path : `${path}/graphql`;
  parsed.hash = "";
  return parsed.toString();
}

export function createBlogClient(options: {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): {
  findBySlug(slug: string): Promise<LookupResult>;
  createDraft(article: Article, coverImageUrl?: string): Promise<CreateRemoteResult>;
} {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? BLOG_REQUEST_TIMEOUT_MS;

  async function call<T>(
    query: string,
    variables: Record<string, unknown>,
    kind: "query" | "mutation",
  ): Promise<CallSuccess<T> | CallFailure> {
    const first = await attempt<T>(query, variables, kind);
    if (kind === "mutation" || first.ok || !first.retryable) {
      return first;
    }

    return attempt<T>(query, variables, kind);
  }

  async function attempt<T>(
    query: string,
    variables: Record<string, unknown>,
    kind: "query" | "mutation",
  ): Promise<CallSuccess<T> | CallFailure> {
    try {
      const response = await fetchImpl(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Agent-Authorization": `Bearer ${options.secret}`,
        },
        body: JSON.stringify({ query, variables }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return classifyResponse<T>(response, kind);
    } catch (error) {
      return {
        ok: false,
        retryable: kind === "query",
        outcome: "uncertain",
        message: transportMessage(error, kind),
      };
    }
  }

  return {
    async findBySlug(slug: string): Promise<LookupResult> {
      let offset = 0;

      while (offset <= MAX_OFFSET) {
        const page = await call<{ editorPosts: RemotePost[] | null }>(
          EDITOR_POSTS_QUERY,
          { limit: PAGE_SIZE, offset },
          "query",
        );

        if (!page.ok) {
          if (page.outcome === "auth") {
            return { status: "auth", message: page.message };
          }

          return {
            status: "uncertain",
            message: `${page.message} The slug was not treated as missing.`,
          };
        }

        const posts = page.data.editorPosts;
        if (!Array.isArray(posts) || posts.length > PAGE_SIZE || posts.some((post) => !post || typeof post.slug !== "string")) {
          return {
            status: "uncertain",
            message: "The article lookup returned an incomplete page. The slug was not treated as missing.",
          };
        }

        const found = posts.find((post) => post.slug === slug);
        if (found) {
          return { status: "found", post: found };
        }

        if (posts.length < PAGE_SIZE) {
          return { status: "absent" };
        }

        offset += posts.length;
      }

      return {
        status: "uncertain",
        message: "The article lookup did not reach the end of the catalog. The slug was not treated as missing.",
      };
    },

    async createDraft(article: Article, coverImageUrl?: string): Promise<CreateRemoteResult> {
      const input: Record<string, string> = {
        title: article.title,
        slug: article.slug,
        excerpt: article.summary,
        contentMarkdown: article.body,
        category: article.category,
      };
      if (coverImageUrl) {
        input.coverImageUrl = coverImageUrl;
      }

      const created = await call<{ createPost: RemotePost | null }>(
        CREATE_POST_MUTATION,
        { input },
        "mutation",
      );

      if (!created.ok) {
        return { status: created.outcome, message: withOrphan(created.message, coverImageUrl) };
      }

      const post = created.data.createPost;
      if (!post || post.status !== "DRAFT") {
        return {
          status: "rejected",
          message: withOrphan(
            `createPost returned status ${post?.status ?? "none"}. Expected DRAFT.`,
            coverImageUrl,
          ),
        };
      }

      if (post.contentMarkdown !== article.body) {
        return {
          status: "mismatch",
          post,
          message: withOrphan(
            "The saved remote Markdown does not match the local draft. It was not changed again.",
            coverImageUrl,
          ),
        };
      }

      if (coverImageUrl && post.coverImageUrl !== coverImageUrl) {
        return {
          status: "mismatch",
          post,
          message: withOrphan("createPost did not confirm the cover URL.", coverImageUrl),
        };
      }

      return { status: "created", post };
    },
  };
}

export type PersistenceReport = {
  persisted: boolean;
  message: string;
};

export async function persistValidatedDraft(options: {
  target: RunTarget;
  draft: Article | null;
  request?: EditorialRequest;
  status: "completed" | "incomplete";
  stoppedAtCallLimit: boolean;
  client?: ReturnType<typeof createBlogClient>;
  coverPath?: string;
  uploadCover?: CoverUploader;
  log?: (line: string) => void;
}): Promise<PersistenceReport> {
  const log = options.log ?? ((line: string) => console.log(line));

  if (!options.draft) {
    const report = { persisted: false, message: "No local draft to store." };
    log(`[blog] ${report.message}`);
    return report;
  }

  if (options.status !== "completed" || options.stoppedAtCallLimit) {
    const report = {
      persisted: false,
      message: "The agent execution did not finish. The draft was not sent to the blog.",
    };
    log(`[blog] ${report.message}`);
    return report;
  }

  const validation = validateStoredArticle(options.draft, options.request);
  if (!validation.ok) {
    const report = {
      persisted: false,
      message: validation.error,
    };
    log(`[blog] validation failed: ${validation.error}`);
    return report;
  }

  if (options.target === "mock") {
    const report = {
      persisted: false,
      message: options.coverPath
        ? "Mock target kept the validated draft in memory. The cover image was not uploaded."
        : "Mock target kept the validated draft in memory.",
    };
    log(`[blog] ${report.message}`);
    return report;
  }

  if (!options.client) {
    throw new Error("Live mode requires a blog client.");
  }

  const lookup = await options.client.findBySlug(options.draft.slug);
  if (lookup.status === "uncertain" || lookup.status === "auth") {
    const report = { persisted: false, message: lookup.message };
    log(`[blog] ${report.message}`);
    return report;
  }

  if (lookup.status === "found") {
    const report = {
      persisted: false,
      message: options.coverPath
        ? `Remote slug "${options.draft.slug}" already exists. It was not overwritten. The cover image was not uploaded.`
        : `Remote slug "${options.draft.slug}" already exists. It was not overwritten.`,
    };
    log(`[blog] ${report.message}`);
    return report;
  }

  let coverImageUrl: string | undefined;
  if (options.coverPath) {
    if (!options.uploadCover) {
      throw new Error("Live mode with a cover image requires Cloudinary configuration.");
    }

    try {
      inspectCoverFile(options.coverPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cover image could not be read.";
      const report = { persisted: false, message };
      log(`[blog] ${report.message}`);
      return report;
    }

    const uploaded = await options.uploadCover(options.coverPath);
    if (uploaded.status !== "uploaded") {
      const report = { persisted: false, message: uploaded.message };
      log(`[blog] ${report.message}`);
      return report;
    }
    coverImageUrl = uploaded.secureUrl;
  }

  const created = await options.client.createDraft(options.draft, coverImageUrl);
  if (created.status === "created") {
    const report = {
      persisted: true,
      message: `Stored remote draft id=${created.post.id} slug=${created.post.slug} status=${created.post.status}`,
    };
    log(`[blog] ${report.message}`);
    return report;
  }

  const report = { persisted: false, message: created.message };
  log(`[blog] ${report.message}`);
  return report;
}

async function classifyResponse<T>(response: Response, kind: "query" | "mutation"): Promise<CallSuccess<T> | CallFailure> {
  const status = response.status;
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      retryable: kind === "query" && isColdStartStatus(status),
      outcome: "uncertain",
      message: uncertainHttpMessage(status, kind),
    };
  }

  const record = body as { data?: T; errors?: GraphQLErrorBody[] };
  const errors = Array.isArray(record.errors) ? record.errors : [];

  if (errors.length > 0) {
    return classifyErrors(errors, status, kind);
  }

  if (!response.ok || record.data === undefined || record.data === null) {
    if (isColdStartStatus(status) || status >= 500) {
      return {
        ok: false,
        retryable: kind === "query",
        outcome: "uncertain",
        message: uncertainHttpMessage(status, kind),
      };
    }

    return {
      ok: false,
      retryable: false,
      outcome: status === 401 || status === 403 ? "auth" : "rejected",
      message: `Blog API returned HTTP ${status}.`,
    };
  }

  return { ok: true, data: record.data };
}

function classifyErrors(errors: GraphQLErrorBody[], status: number, kind: "query" | "mutation"): CallFailure {
  const message = errors.map((error) => error.message).find((value) => typeof value === "string" && value.trim() !== "") ?? `Blog API returned HTTP ${status}.`;
  const codes = errors.map((error) => error.extensions?.code);

  if (message === "slug already exists") {
    return { ok: false, retryable: false, outcome: "duplicate", message: "Remote slug already exists. It was not overwritten." };
  }

  if (codes.includes("UNAUTHENTICATED") || codes.includes("FORBIDDEN") || status === 401 || status === 403) {
    return { ok: false, retryable: false, outcome: "auth", message };
  }

  if (isColdStartStatus(status)) {
    return {
      ok: false,
      retryable: kind === "query",
      outcome: "uncertain",
      message: uncertainHttpMessage(status, kind),
    };
  }

  return { ok: false, retryable: false, outcome: "rejected", message };
}

function isColdStartStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function uncertainHttpMessage(status: number, kind: "query" | "mutation"): string {
  if (kind === "mutation") {
    return `createPost did not return a completed result (HTTP ${status}). The draft may or may not exist remotely. The mutation was not retried.`;
  }

  return `Blog API returned HTTP ${status}.`;
}

function withOrphan(message: string, coverImageUrl?: string): string {
  if (!coverImageUrl) {
    return message;
  }

  return `${message} The uploaded asset at ${coverImageUrl} may be unused and was not deleted.`;
}

function transportMessage(error: unknown, kind: "query" | "mutation"): string {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  if (kind === "mutation") {
    return timedOut
      ? "createPost timed out. The draft may or may not exist remotely. The mutation was not retried."
      : "createPost failed on the network. The draft may or may not exist remotely. The mutation was not retried.";
  }

  return timedOut ? "The article lookup timed out." : "The article lookup failed on the network.";
}
