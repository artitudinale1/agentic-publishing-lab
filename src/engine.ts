import { basename } from "node:path";
import OpenAI from "openai";
import type { Article, ArticleCategory } from "./articles.js";
import { createBlogClient, persistValidatedDraft, readBlogConfig, type PersistenceReport } from "./blog.js";
import { createCloudinaryUploader, createInlineImageUploader, inspectCoverBytes, readCloudinaryConfig } from "./cover.js";
import { openAIClientOptions, readConfig } from "./config.js";
import {
  modelPrompt,
  type ArticleLength,
  type EditorialRequest,
  type RunTarget,
} from "./editorial.js";
import { formatRunOutput, runExperiment, type ModelClient } from "./experiment.js";
import { MAX_INLINE_IMAGES, prepareInlineImages, validateArticleMarkdown, type InlineImage } from "./images.js";
import { validateStoredArticle, type ValidationIssue, type ValidationSuccess } from "./validation.js";

/**
 * Server-side publishing workflow. Import this from a Node.js server or a
 * Next.js Server Component, route handler, or server action. It reads no
 * filesystem paths of its own.
 */

export type PublishingImage = {
  filename: string;
  bytes: Uint8Array;
  description?: string;
};

export type PublishingRequest =
  | {
      mode: "existing";
      instructions: string;
      body: string;
      context?: string;
      category?: ArticleCategory;
    }
  | {
      mode: "generate";
      prompt: string;
      context?: string;
      length?: ArticleLength;
      category?: ArticleCategory;
    };

export type PublishingEvent =
  | {
      type: "config";
      requestedModel: string;
      baseURL?: string;
      mode?: "existing" | "generate";
      category?: ArticleCategory;
      target: RunTarget;
      cover?: string;
      inlineIds: string[];
    }
  | { type: "model"; call: number; model: string; inputTokens: number; outputTokens: number }
  | {
      type: "tool";
      phase: "request" | "result" | "skipped";
      name: string;
      callId: string;
      arguments?: string;
      output?: string;
    }
  | { type: "usage"; apiCalls: number; inputTokens: number; outputTokens: number }
  | { type: "incomplete"; reason: string }
  | {
      type: "result";
      status: "completed" | "incomplete";
      incompleteReason: string | null;
      stoppedAtCallLimit: boolean;
    }
  | { type: "validation"; article: ArticleValidation | null; images: ImageValidation | null }
  | { type: "persistence"; persisted: boolean; message: string }
  | { type: "duration"; milliseconds: number };

export type ArticleValidation =
  | { ok: true; result: ValidationSuccess }
  | { ok: false; error: string; issues?: ValidationIssue[] };

export type ImageValidation = { ok: true; referencedIds: string[] } | { ok: false; message: string };

export type PublishingAgentInput = {
  target?: RunTarget;
  /** Used when there is no structured editorial request. */
  prompt?: string;
  request?: PublishingRequest;
  cover?: PublishingImage;
  images?: readonly PublishingImage[];
  env?: NodeJS.ProcessEnv;
  /** Tests inject a fake client. The CLI omits this and the engine builds one. */
  client?: ModelClient;
  log?: (line: string) => void;
  onEvent?: (event: PublishingEvent) => void;
};

export type PublishingAgentResult = {
  requestedModel: string;
  models: string[];
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  status: "completed" | "incomplete";
  incompleteReason: string | null;
  stoppedAtCallLimit: boolean;
  finalText: string;
  draft: Article | null;
  validation: { article: ArticleValidation | null; images: ImageValidation | null };
  persistence: PersistenceReport;
  events: PublishingEvent[];
};

export async function runPublishingAgent(input: PublishingAgentInput): Promise<PublishingAgentResult> {
  const started = Date.now();
  const events: PublishingEvent[] = [];
  const log = input.log ?? ((line: string) => console.log(line));
  const emit = (event: PublishingEvent): void => {
    events.push(event);
    input.onEvent?.(event);
  };
  const target = input.target ?? "mock";
  const env = input.env ?? process.env;
  const inline = suppliedImages(input.images, input.request?.mode);
  const request = input.request ? withImagePrompts(input.request, inline) : undefined;
  const prompt = request ? modelPrompt(request) : (input.prompt ?? "").trim();

  if (!prompt) {
    throw new Error("Prompt is empty. No API request was sent.");
  }

  if (input.cover) {
    inspectCoverBytes(input.cover.bytes, input.cover.filename, "Cover image");
  }
  prepareInlineImages(inline, request?.mode === "existing" ? request.body : undefined, request?.mode);

  const blogConfig = target === "live" ? readBlogConfig(env) : undefined;
  const cloudinaryConfig =
    target === "live" && (input.cover || inline.length > 0) ? readCloudinaryConfig(env) : undefined;
  const config = readConfig(env);
  const client = input.client ?? new OpenAI(openAIClientOptions(config));

  log(`[config] requested_model=${config.model} max_retries=0`);
  if (config.baseURL) {
    log(`[config] base_url=${config.baseURL}`);
  }
  if (request) {
    log(`[config] mode=${request.mode}`);
    if (request.category) {
      log(`[config] category=${request.category}`);
    }
  }
  log(`[config] target=${target}`);
  const coverName = input.cover ? basename(input.cover.filename) : undefined;
  if (coverName) {
    log(`[config] cover=${coverName}`);
  }
  if (inline.length > 0) {
    log(`[config] inline=${inline.map((image) => image.id).join(",")}`);
  }
  emit({
    type: "config",
    requestedModel: config.model,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(request ? { mode: request.mode } : {}),
    ...(request?.category ? { category: request.category } : {}),
    target,
    ...(coverName ? { cover: coverName } : {}),
    inlineIds: inline.map((image) => image.id),
  });

  const blog = blogConfig ? createBlogClient(blogConfig) : undefined;
  const uploadCover = cloudinaryConfig && input.cover ? createCloudinaryUploader(cloudinaryConfig) : undefined;
  const uploadInline = cloudinaryConfig && inline.length > 0 ? createInlineImageUploader(cloudinaryConfig) : undefined;
  const models: string[] = [];

  const result = await runExperiment({
    client,
    model: config.model,
    prompt,
    request,
    log,
    notice: (notice) => {
      if (notice.type === "model") {
        models.push(notice.model);
      }
      emit(notice);
    },
  });

  log(`[result] status=${result.status} incomplete_reason=${result.incompleteReason ?? "none"}`);
  log("");
  log(formatRunOutput(result));
  emit({
    type: "result",
    status: result.status,
    incompleteReason: result.incompleteReason,
    stoppedAtCallLimit: result.stoppedAtCallLimit,
  });

  const validation = validationSnapshot(result.draft, request, result.status, result.stoppedAtCallLimit);
  emit({ type: "validation", article: validation.article, images: validation.images });

  const persistence = await persistValidatedDraft({
    target,
    draft: result.draft,
    request,
    status: result.status,
    stoppedAtCallLimit: result.stoppedAtCallLimit,
    client: blog,
    ...(input.cover
      ? { coverBytes: input.cover.bytes, coverFilename: basename(input.cover.filename) }
      : {}),
    uploadCover,
    images: inline,
    uploadInline,
    log,
  });
  emit({ type: "persistence", persisted: persistence.persisted, message: persistence.message });

  const durationMs = Date.now() - started;
  emit({ type: "duration", milliseconds: durationMs });

  return {
    requestedModel: config.model,
    models,
    apiCalls: result.apiCalls,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs,
    status: result.status,
    incompleteReason: result.incompleteReason,
    stoppedAtCallLimit: result.stoppedAtCallLimit,
    finalText: result.finalText,
    draft: result.draft,
    validation,
    persistence,
    events,
  };
}

function suppliedImages(
  images: readonly PublishingImage[] | undefined,
  mode: "existing" | "generate" | undefined,
): InlineImage[] {
  const list = images ?? [];
  if (list.length > MAX_INLINE_IMAGES) {
    throw new Error("At most five inline images can be supplied.");
  }
  if (mode === "generate" && list.some((image) => !image.description?.trim())) {
    throw new Error("Each inline image in generate mode needs a description.");
  }

  return list.map((image, index) => {
    const description = image.description?.trim();
    return {
      id: `image-${index + 1}`,
      filename: basename(image.filename),
      bytes: image.bytes,
      ...(description ? { description } : {}),
    };
  });
}

function withImagePrompts(request: PublishingRequest, images: readonly InlineImage[]): EditorialRequest {
  const prompts = images.map((image) => ({
    id: image.id,
    ...(image.description ? { description: image.description } : {}),
  }));
  if (prompts.length === 0) {
    return request;
  }
  return { ...request, images: prompts };
}

function validationSnapshot(
  draft: Article | null,
  request: EditorialRequest | undefined,
  status: "completed" | "incomplete",
  stoppedAtCallLimit: boolean,
): { article: ArticleValidation | null; images: ImageValidation | null } {
  if (!draft || status !== "completed" || stoppedAtCallLimit) {
    return { article: null, images: null };
  }

  const article = validateStoredArticle({ ...draft }, request);
  if (!article.ok) {
    return {
      article: { ok: false, error: article.error, ...(article.validation ? { issues: article.validation.issues } : {}) },
      images: null,
    };
  }

  const images = validateArticleMarkdown(draft.body, request?.images ?? [], request?.mode);
  return {
    article: { ok: true, result: article.result },
    images: images.ok ? { ok: true, referencedIds: images.referencedIds } : { ok: false, message: images.message },
  };
}
