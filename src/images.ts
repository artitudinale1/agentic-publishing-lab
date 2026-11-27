import { inspectCoverFile } from "./cover";

export const MAX_INLINE_IMAGES = 5;

/** Shown to the model. This object never carries a filesystem path. */
export type InlineImagePrompt = {
  id: string;
  description?: string;
};

export type InlineImage = InlineImagePrompt & {
  path: string;
};

/** Same image syntax the blog renderer accepts: no spaces in the destination. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
const MARKDOWN_LINK = /(?<!!)\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
const IMAGE_TOKEN = /image:image-(\d+)/g;
const PLACEHOLDER = /image:image-\d+/;
const RUBY = /<ruby>([^<]*)<rt>([^<]*)<\/rt><\/ruby>/gi;
const MAX_URL_LENGTH = 2048;

export type ImageReferenceCheck =
  | { ok: true; referencedIds: string[] }
  | { ok: false; message: string };

/**
 * Backend check for the article the model stored.
 * Generate mode requires every supplied image as a Markdown image.
 * This does not ask the model to decide whether the article is valid.
 */
export function validateArticleMarkdown(
  body: string,
  images: readonly InlineImagePrompt[],
  mode: "existing" | "generate" | undefined,
): ImageReferenceCheck {
  const html = disallowedHtml(body);
  if (html) {
    return { ok: false, message: html };
  }

  const links = unsafeLink(body);
  if (links) {
    return { ok: false, message: links };
  }

  return checkInlineImages(body, images, mode);
}

/**
 * Check the Markdown after placeholders have been replaced with upload URLs.
 * Remote persistence calls this before createPost.
 */
export function validateResolvedMarkdown(body: string): { ok: true } | { ok: false; message: string } {
  const html = disallowedHtml(body);
  if (html) {
    return { ok: false, message: html };
  }

  const links = unsafeLink(body);
  if (links) {
    return { ok: false, message: links };
  }

  const prose = outsideCode(body);
  if (PLACEHOLDER.test(prose)) {
    return { ok: false, message: "Unresolved image placeholder." };
  }

  for (const image of markdownImages(body)) {
    if (placeholderId(image.destination) || PLACEHOLDER.test(image.destination)) {
      return { ok: false, message: "Unresolved image placeholder." };
    }
    if (!safeImageUrl(image.destination)) {
      return { ok: false, message: "Unsafe image URL." };
    }
  }

  return { ok: true };
}

/**
 * Accept only ids the user supplied.
 * Generate mode also rejects Markdown images that are not those placeholders.
 */
export function checkInlineImages(
  body: string,
  images: readonly InlineImagePrompt[],
  mode: "existing" | "generate" | undefined,
): ImageReferenceCheck {
  const known = new Set(images.map((image) => image.id));
  const referenced: string[] = [];
  const remember = (id: string): void => {
    if (!referenced.includes(id)) {
      referenced.push(id);
    }
  };

  for (const image of markdownImages(body)) {
    const id = placeholderId(image.destination);
    if (mode === "generate") {
      if (!id || !known.has(id)) {
        if (!safeImageUrl(image.destination)) {
          return { ok: false, message: "Unsafe image URL." };
        }
        return { ok: false, message: `Unknown image reference: ${image.destination}.` };
      }
      if (image.alt.trim() === "" || image.alt.trim() === id) {
        return { ok: false, message: `Image ${id} needs alt text.` };
      }
      remember(id);
      continue;
    }

    if (id) {
      if (!known.has(id)) {
        return { ok: false, message: `Unknown image reference: image:${id}.` };
      }
      remember(id);
      continue;
    }

    if (!safeImageUrl(image.destination)) {
      return { ok: false, message: "Unsafe image URL." };
    }
  }

  const outsideImages = outsideCode(body).replace(MARKDOWN_IMAGE, "");
  for (const match of outsideImages.matchAll(IMAGE_TOKEN)) {
    const id = `image-${match[1] ?? ""}`;
    if (!known.has(id)) {
      return { ok: false, message: `Unknown image reference: image:${id}.` };
    }
    return { ok: false, message: `Image ${id} must use Markdown image syntax.` };
  }

  if (mode === "generate") {
    for (const image of images) {
      if (!referenced.includes(image.id)) {
        return { ok: false, message: `Missing image reference: ${image.id}.` };
      }
    }
  }

  return { ok: true, referencedIds: referenced };
}

/** Swap recognised image destinations for uploaded https URLs. Every other character stays. */
export function replaceImagePlaceholders(body: string, urls: ReadonlyMap<string, string>): string {
  return body.replace(MARKDOWN_IMAGE, (match, alt: string, destination: string) => {
    const id = placeholderId(destination.trim());
    if (!id) {
      return match;
    }
    const url = urls.get(id);
    if (!url) {
      return match;
    }
    if (!safeImageUrl(url)) {
      throw new Error("Unsafe image URL.");
    }
    return `![${alt}](${url})`;
  });
}

/** Inspect every supplied file, then reject unknown placeholders in an existing article. */
export function prepareInlineImages(images: readonly InlineImage[], body: string | undefined, mode: "existing" | "generate" | undefined): void {
  for (const image of images) {
    inspectCoverFile(image.path, "Inline image");
  }

  if (mode === "existing" && body !== undefined) {
    const checked = validateArticleMarkdown(body, images, "existing");
    if (!checked.ok) {
      throw new Error(checked.message);
    }
  }
}

function markdownImages(body: string): Array<{ alt: string; destination: string }> {
  const found: Array<{ alt: string; destination: string }> = [];
  for (const match of outsideCode(body).matchAll(MARKDOWN_IMAGE)) {
    found.push({ alt: match[1] ?? "", destination: (match[2] ?? "").trim() });
  }
  return found;
}

function outsideCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
}

function disallowedHtml(body: string): string | undefined {
  const withoutRuby = outsideCode(body).replace(RUBY, "");
  if (/<\/?[A-Za-z!][^>\n]*>/.test(withoutRuby)) {
    return "Unsupported HTML. Only ruby and rt tags are allowed.";
  }
  return undefined;
}

function unsafeLink(body: string): string | undefined {
  for (const match of outsideCode(body).matchAll(MARKDOWN_LINK)) {
    const destination = (match[2] ?? "").trim();
    if (!safeLinkUrl(destination)) {
      return "Unsafe URL.";
    }
  }
  return undefined;
}

function safeImageUrl(value: string): boolean {
  if (!value || value.length > MAX_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function safeLinkUrl(value: string): boolean {
  if (!value || value.length > MAX_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function placeholderId(destination: string): string | undefined {
  const match = /^image:(image-[1-5])$/.exec(destination);
  return match?.[1];
}
