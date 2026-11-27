import { existsSync, readFileSync } from "node:fs";
import { isArticleCategory, type ArticleCategory } from "./articles";
import { MAX_INLINE_IMAGES, type InlineImage, type InlineImagePrompt } from "./images";

/**
 * An explicit editorial task. Orchestration stays with the model;
 * this object tells the backend which content rule to enforce.
 */
export type ArticleLength = "short" | "medium" | "long";

export const ARTICLE_LENGTHS: Record<
  ArticleLength,
  { minWords: number; maxWords: number; maxOutputTokens: number }
> = {
  short: { minWords: 150, maxWords: 300, maxOutputTokens: 2048 },
  medium: { minWords: 300, maxWords: 600, maxOutputTokens: 4096 },
  long: { minWords: 600, maxWords: 1000, maxOutputTokens: 8192 },
};

/** Generate mode uses medium when the caller does not name a length. */
export function resolveArticleLength(length?: ArticleLength): ArticleLength {
  return length ?? "medium";
}

/** Count words by whitespace. The stored text is not changed. */
export function countWords(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words?.length ?? 0;
}

export type EditorialRequest =
  | {
      mode: "existing";
      instructions: string;
      body: string;
      context?: string;
      category?: ArticleCategory;
      images?: readonly InlineImagePrompt[];
    }
  | {
      mode: "generate";
      prompt: string;
      context?: string;
      length?: ArticleLength;
      category?: ArticleCategory;
      images?: readonly InlineImagePrompt[];
    };

export type RunTarget = "mock" | "live";

export type CliRun = {
  prompt: string;
  request?: EditorialRequest;
  target: RunTarget;
  coverPath?: string;
  images?: readonly InlineImage[];
};

const EXISTING_FLAGS = ["mode", "file", "instructions", "context", "category", "target", "cover", "image", "image-description"];
const GENERATE_FLAGS = ["mode", "prompt", "context", "length", "category", "target", "cover", "image", "image-description"];

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for --${name}.`);
  }

  return value;
}

function flagValues(argv: string[], name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== `--${name}`) {
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}.`);
    }

    values.push(value);
    index += 1;
  }

  return values;
}

function rejectUnknownFlags(argv: string[], allowed: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      continue;
    }

    const name = token.slice(2);
    if (!allowed.includes(name)) {
      throw new Error(`Unknown argument: --${name}.`);
    }

    index += 1;
  }
}

function optionalContext(context: string | undefined): string | undefined {
  if (context === undefined) {
    return undefined;
  }

  const trimmed = context.trim();
  if (!trimmed) {
    throw new Error("Optional context must be a non-empty string.");
  }

  return trimmed;
}

/** Read a Markdown article without changing its text. */
export function loadMarkdownFile(filePath: string): string {
  if (!filePath.endsWith(".md")) {
    throw new Error("Article file must end in .md.");
  }

  if (!existsSync(filePath)) {
    throw new Error(`Article file not found: ${filePath}`);
  }

  const body = readFileSync(filePath, "utf8");
  if (body.trim() === "") {
    throw new Error("Article file is empty.");
  }

  return body;
}

function articleCategorySetting(category: string | undefined): ArticleCategory | undefined {
  if (category === undefined) {
    return undefined;
  }

  if (isArticleCategory(category)) {
    return category;
  }

  throw new Error("Set category to CODE, JAPANESE, CATS, or COOKING.");
}

function articleLengthSetting(length: string | undefined): ArticleLength {
  if (length === undefined) {
    return "medium";
  }

  if (length === "short" || length === "medium" || length === "long") {
    return length;
  }

  throw new Error("Set length to short, medium, or long.");
}

export function parseEditorialRequest(input: {
  mode?: string;
  instructions?: string;
  prompt?: string;
  body?: string;
  context?: string;
  length?: string;
  category?: string;
}): EditorialRequest {
  const context = optionalContext(input.context);

  if (input.mode === "existing") {
    const instructions = input.instructions?.trim() ?? "";
    if (!instructions) {
      throw new Error("Existing article mode requires publishing instructions.");
    }

    if (typeof input.body !== "string" || input.body.trim() === "") {
      throw new Error("Existing article mode requires the article body.");
    }

    const category = articleCategorySetting(input.category);
    return {
      mode: "existing",
      instructions,
      body: input.body,
      ...(context ? { context } : {}),
      ...(category ? { category } : {}),
    };
  }

  if (input.mode === "generate") {
    const prompt = input.prompt?.trim() ?? "";
    if (!prompt) {
      throw new Error("Generate mode requires an editorial prompt.");
    }

    const length = articleLengthSetting(input.length);
    const category = articleCategorySetting(input.category);
    return {
      mode: "generate",
      prompt,
      length,
      ...(context ? { context } : {}),
      ...(category ? { category } : {}),
    };
  }

  throw new Error("Set mode to existing or generate.");
}

/** The user message. In existing mode the body is shown for reading, not for the model to copy back. */
export function modelPrompt(request: EditorialRequest): string {
  if (request.mode === "existing") {
    const context = request.context ? `\n\nContext:\n${request.context}` : "";
    return [
      "Publishing instructions:",
      request.instructions,
      context,
      "",
      "Supplied article body:",
      request.body,
    ].join("\n") + imagePromptSection(request.images);
  }

  const context = request.context ? `\n\nContext:\n${request.context}` : "";
  return `Editorial prompt:\n${request.prompt}${context}${imagePromptSection(request.images)}`;
}

export function instructionsFor(request: EditorialRequest): string {
  const shared = [
    "You help with a small in-memory article catalog.",
    "You can call findArticle, createDraft, and updateDraft.",
    "Choose which tools to call and in which order.",
    "Use only tool results. Do not invent catalog entries.",
    "If a tool reports an error, a duplicate slug, a missing article, or a published article, say that plainly.",
    "After createDraft succeeds, do not call findArticle for that article unless the user explicitly asked to read it back.",
    "Before you finish, call validateArticle for the draft you saved.",
    "Saving a draft does not require approval.",
    "You cannot approve or publish. Approval and publication happen outside this workflow.",
    "When you are finished, reply with a short summary of what you did. Do not repeat the article body.",
    request.category
      ? `The category is ${request.category}. createDraft must use that category.`
      : "createDraft must use a category of CODE, JAPANESE, CATS, or COOKING.",
  ];

  if (request.mode === "existing") {
    return [
      ...shared,
      "The user supplied the article body.",
      "createDraft accepts only slug, title, and summary.",
      "Do not send the article body as a tool argument. The backend attaches the original body.",
      "updateDraft cannot change the body.",
      ...imageRules(request),
    ].join(" ");
  }

  const length = resolveArticleLength(request.length);
  const preset = ARTICLE_LENGTHS[length];
  return [
    ...shared,
    "Generate the article.",
    `Write between ${preset.minWords} and ${preset.maxWords} words.`,
    "createDraft requires slug, title, summary, and body.",
    `The backend stores that body only when the arguments are valid and the article does not exceed ${preset.maxWords} words.`,
    "The backend does not shorten an article that is too long.",
    "updateDraft cannot change the body.",
    "Write Markdown the blog renderer supports: paragraphs, headings with one to three hashes, lists, quotes, fenced code, links, and bold or italic.",
    "Japanese readings use <ruby>base<rt>reading</rt></ruby> only. Do not use other HTML.",
    ...imageRules(request),
  ].join(" ");
}

function imagePromptSection(images: readonly InlineImagePrompt[] | undefined): string {
  if (!images || images.length === 0) {
    return "";
  }

  const lines = images.map((image) => (image.description ? `- ${image.id}: ${image.description}` : `- ${image.id}`));
  return `\n\nInline images:\n${lines.join("\n")}`;
}

function imageRules(request: EditorialRequest): string[] {
  const images = request.images ?? [];
  if (images.length === 0) {
    return [];
  }

  if (request.mode === "existing") {
    return [
      "The supplied article may contain placeholders such as image:image-1.",
      "Leave those placeholders as they are.",
      "Do not invent image URLs or file paths.",
    ];
  }

  return [
    "Embed every supplied image with Markdown such as ![descriptive alt text](image:image-1).",
    "Choose where each image belongs.",
    "Write the alt text from that image's description.",
    "The destination must be the assigned image id, not a URL or file path.",
    "Do not invent image URLs or file paths.",
  ];
}

function readTarget(argv: string[]): RunTarget {
  const target = flagValue(argv, "target");
  if (target === undefined) {
    return "mock";
  }

  if (target === "mock" || target === "live") {
    return target;
  }

  throw new Error("Set target to mock or live.");
}

function readCover(argv: string[]): string | undefined {
  return flagValue(argv, "cover");
}

function promptWithoutRunFlags(argv: string[]): string {
  const parts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--target" || token === "--cover" || token === "--image" || token === "--image-description") {
      index += 1;
      continue;
    }

    if (token !== undefined) {
      parts.push(token);
    }
  }

  return parts.join(" ").trim();
}

function readInlineImages(argv: string[], mode: "existing" | "generate"): InlineImage[] {
  const paths = flagValues(argv, "image");
  const descriptions = flagValues(argv, "image-description");

  if (paths.length > MAX_INLINE_IMAGES) {
    throw new Error("At most five inline images can be supplied.");
  }

  if (descriptions.length > paths.length || (descriptions.length > 0 && descriptions.length !== paths.length)) {
    throw new Error("Each inline image needs one --image-description.");
  }

  if (mode === "generate" && paths.length > 0 && descriptions.length !== paths.length) {
    throw new Error("Each inline image in generate mode needs --image-description.");
  }

  return paths.map((imagePath, index) => {
    const description = descriptions[index]?.trim();
    if (descriptions.length > 0 && !description) {
      throw new Error("Image description must be a non-empty string.");
    }

    return {
      id: `image-${index + 1}`,
      path: imagePath,
      ...(description ? { description } : {}),
    };
  });
}

function imagePrompts(images: readonly InlineImage[]): InlineImagePrompt[] {
  return images.map((image) => ({
    id: image.id,
    ...(image.description ? { description: image.description } : {}),
  }));
}

export function parseCli(argv: string[]): CliRun {
  if (!argv.includes("--mode")) {
    if (flagValues(argv, "image").length > 0 || flagValues(argv, "image-description").length > 0) {
      throw new Error("Inline images require --mode existing or --mode generate.");
    }
    return { prompt: promptWithoutRunFlags(argv), target: readTarget(argv), coverPath: readCover(argv) };
  }

  const mode = flagValue(argv, "mode");
  const context = flagValue(argv, "context");
  const target = readTarget(argv);
  const coverPath = readCover(argv);
  const images = mode === "existing" || mode === "generate" ? readInlineImages(argv, mode) : [];

  if (mode === "existing") {
    rejectUnknownFlags(argv, EXISTING_FLAGS);
    const file = flagValue(argv, "file");
    const instructions = flagValue(argv, "instructions");
    if (!file || !instructions) {
      throw new Error("Existing article mode requires --file and --instructions.");
    }

    const request = parseEditorialRequest({
      mode,
      instructions,
      body: loadMarkdownFile(file),
      context,
      category: flagValue(argv, "category"),
    });
    const prompts = imagePrompts(images);
    if (prompts.length > 0) {
      request.images = prompts;
    }
    return { prompt: modelPrompt(request), request, target, coverPath, ...(images.length > 0 ? { images } : {}) };
  }

  if (mode === "generate") {
    rejectUnknownFlags(argv, GENERATE_FLAGS);
    const prompt = flagValue(argv, "prompt");
    if (!prompt) {
      throw new Error("Generate mode requires --prompt.");
    }

    const request = parseEditorialRequest({
      mode,
      prompt,
      context,
      length: flagValue(argv, "length"),
      category: flagValue(argv, "category"),
    });
    const prompts = imagePrompts(images);
    if (prompts.length > 0) {
      request.images = prompts;
    }
    return { prompt: modelPrompt(request), request, target, coverPath, ...(images.length > 0 ? { images } : {}) };
  }

  throw new Error("Set mode to existing or generate.");
}
