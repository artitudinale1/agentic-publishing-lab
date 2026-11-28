import {
  articleRevision,
  isArticleCategory,
  type Article,
  type ArticleCategory,
} from "./articles.js";
import {
  BLOG_EXCERPT_MAX_LENGTH,
  BLOG_MARKDOWN_MAX_LENGTH,
  BLOG_SLUG_MAX_LENGTH,
  BLOG_TITLE_MAX_LENGTH,
} from "./blog-limits.js";
import {
  ARTICLE_LENGTHS,
  countWords,
  resolveArticleLength,
  type EditorialRequest,
} from "./editorial.js";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export {
  BLOG_EXCERPT_MAX_LENGTH,
  BLOG_FIELD_LIMITS,
  BLOG_MARKDOWN_MAX_LENGTH,
  BLOG_SLUG_MAX_LENGTH,
  BLOG_TITLE_MAX_LENGTH,
} from "./blog-limits.js";

export type ValidationIssue = {
  code:
    | "missing_title"
    | "missing_slug"
    | "invalid_slug"
    | "missing_summary"
    | "missing_body"
    | "invalid_category"
    | "category_mismatch"
    | "body_changed"
    | "too_short"
    | "too_long"
    | "title_too_long"
    | "slug_too_long"
    | "excerpt_too_long"
    | "markdown_too_long";
  message: string;
  wordCount?: number;
  minWords?: number;
  maxWords?: number;
  length?: number;
  maxLength?: number;
};

export type ValidationSuccess = {
  valid: true;
  slug: string;
  revision: string;
  category: ArticleCategory;
  wordCount: number;
};

/**
 * Check a saved draft. Failure leaves the draft in the catalog and clears
 * any previous validation or approval for that revision.
 */
export function validateStoredArticle(
  article: Article,
  request?: EditorialRequest,
): { ok: true; result: ValidationSuccess } | { ok: false; error: string; validation?: { code: "invalid_article"; issues: ValidationIssue[] } } {
  if (article.status !== "draft") {
    return { ok: false, error: `Cannot validate published article "${article.slug}".` };
  }

  const issues: ValidationIssue[] = [];

  if (article.title.trim() === "") {
    issues.push({ code: "missing_title", message: "Title is required." });
  }

  if (article.slug.trim() === "") {
    issues.push({ code: "missing_slug", message: "Slug is required." });
  } else if (!SLUG_PATTERN.test(article.slug)) {
    issues.push({
      code: "invalid_slug",
      message: "Slug must use lowercase letters, numbers, and single hyphens.",
    });
  }

  if (article.summary.trim() === "") {
    issues.push({ code: "missing_summary", message: "Summary is required." });
  }

  if (article.body.trim() === "") {
    issues.push({ code: "missing_body", message: "Body is required." });
  }

  if (!isArticleCategory(article.category)) {
    issues.push({
      code: "invalid_category",
      message: "Category must be CODE, JAPANESE, CATS, or COOKING.",
    });
  }

  if (request?.category && article.category !== request.category) {
    issues.push({
      code: "category_mismatch",
      message: `Category must be ${request.category}.`,
    });
  }

  if (request?.mode === "existing" && article.body !== request.body) {
    issues.push({
      code: "body_changed",
      message: "The stored body does not match the supplied article.",
    });
  }

  issues.push(...blogFieldIssues(article));

  if (request?.mode === "generate" && article.body.trim() !== "") {
    const preset = ARTICLE_LENGTHS[resolveArticleLength(request.length)];
    const wordCount = countWords(article.body);
    if (wordCount < preset.minWords) {
      issues.push({
        code: "too_short",
        message: `Generated article has ${wordCount} words, which is below the minimum of ${preset.minWords}.`,
        wordCount,
        minWords: preset.minWords,
        maxWords: preset.maxWords,
      });
    } else if (wordCount > preset.maxWords) {
      issues.push({
        code: "too_long",
        message: `Generated article has ${wordCount} words, which exceeds the maximum of ${preset.maxWords}.`,
        wordCount,
        minWords: preset.minWords,
        maxWords: preset.maxWords,
      });
    }
  }

  if (issues.length > 0) {
    article.validatedRevision = null;
    article.approvedRevision = null;
    return {
      ok: false,
      error: "Article failed validation.",
      validation: { code: "invalid_article", issues },
    };
  }

  const revision = articleRevision(article);
  article.revision = revision;
  if (article.approvedRevision !== revision) {
    article.approvedRevision = null;
  }
  article.validatedRevision = revision;

  return {
    ok: true,
    result: {
      valid: true,
      slug: article.slug,
      revision,
      category: article.category,
      wordCount: countWords(article.body),
    },
  };
}

/**
 * The same character limits createPost enforces.
 * Title, slug, and excerpt use the trimmed length. Markdown uses the exact length.
 */
export function blogFieldIssues(article: {
  title: string;
  slug: string;
  summary: string;
  body: string;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const titleLength = article.title.trim().length;
  if (titleLength > BLOG_TITLE_MAX_LENGTH) {
    issues.push({
      code: "title_too_long",
      message: `Title has ${titleLength} characters, which exceeds the maximum of ${BLOG_TITLE_MAX_LENGTH}.`,
      length: titleLength,
      maxLength: BLOG_TITLE_MAX_LENGTH,
    });
  }

  const slugLength = article.slug.trim().length;
  if (slugLength > BLOG_SLUG_MAX_LENGTH) {
    issues.push({
      code: "slug_too_long",
      message: `Slug has ${slugLength} characters, which exceeds the maximum of ${BLOG_SLUG_MAX_LENGTH}.`,
      length: slugLength,
      maxLength: BLOG_SLUG_MAX_LENGTH,
    });
  }

  const excerptLength = article.summary.trim().length;
  if (excerptLength > BLOG_EXCERPT_MAX_LENGTH) {
    issues.push({
      code: "excerpt_too_long",
      message: `Summary has ${excerptLength} characters, which exceeds the excerpt maximum of ${BLOG_EXCERPT_MAX_LENGTH}.`,
      length: excerptLength,
      maxLength: BLOG_EXCERPT_MAX_LENGTH,
    });
  }

  if (article.body.length > BLOG_MARKDOWN_MAX_LENGTH) {
    issues.push({
      code: "markdown_too_long",
      message: `Markdown has ${article.body.length} characters, which exceeds the maximum of ${BLOG_MARKDOWN_MAX_LENGTH}.`,
      length: article.body.length,
      maxLength: BLOG_MARKDOWN_MAX_LENGTH,
    });
  }

  return issues;
}
