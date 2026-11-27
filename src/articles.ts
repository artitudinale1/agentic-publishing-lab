import { createHash } from "node:crypto";

export type ArticleStatus = "draft" | "published";

export const ARTICLE_CATEGORIES = ["CODE", "JAPANESE", "CATS", "COOKING"] as const;

export type ArticleCategory = (typeof ARTICLE_CATEGORIES)[number];

export function isArticleCategory(value: string): value is ArticleCategory {
  return (ARTICLE_CATEGORIES as readonly string[]).includes(value);
}

export type Article = {
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: ArticleCategory;
  status: ArticleStatus;
  revision: string;
  validatedRevision: string | null;
  approvedRevision: string | null;
};

/** Hash of the stored content. Approval is bound to this value. */
export function articleRevision(article: {
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: ArticleCategory;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        body: article.body,
        category: article.category,
        slug: article.slug,
        summary: article.summary,
        title: article.title,
      }),
    )
    .digest("hex");
}

function newArticle(article: {
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: ArticleCategory;
  status: ArticleStatus;
}): Article {
  return {
    ...article,
    revision: articleRevision(article),
    validatedRevision: null,
    approvedRevision: null,
  };
}

export type Catalog = Article[];

export type FindArticleResult =
  | { found: true; article: Article }
  | { found: false; slug: string; message: string };

export type CreateDraftResult = {
  created: true;
  article: Article;
};

export type UpdateDraftResult = {
  updated: true;
  article: Article;
};

/**
 * The published article present at the start of every run.
 * Each execution copies this seed into its own catalog.
 */
const SEED: readonly Article[] = [
  newArticle({
    slug: "beta-driven-development",
    title: "Beta-Driven Development: An Agentic Architecture for Resource Acquisition",
    summary:
      "Beta is a black-and-white cat specialising in resource acquisition, human interaction, security and operational sustainability.",
    body: "Beta is a black-and-white cat. This published article is already in the catalog.\n",
    category: "CATS",
    status: "published",
  }),
];

export function createCatalog(): Catalog {
  return SEED.map((article) => ({ ...article }));
}

export function findArticle(catalog: readonly Article[], slug: string): FindArticleResult {
  const article = catalog.find((entry) => entry.slug === slug);

  if (!article) {
    return {
      found: false,
      slug,
      message: `No article found for slug "${slug}".`,
    };
  }

  return {
    found: true,
    article: { ...article },
  };
}

export function createDraft(
  catalog: Catalog,
  slug: string,
  title: string,
  summary: string,
  body: string,
  category: ArticleCategory,
): { ok: true; result: CreateDraftResult } | { ok: false; error: string } {
  if (catalog.some((entry) => entry.slug === slug)) {
    return { ok: false, error: `Slug "${slug}" already exists.` };
  }

  const article = newArticle({ slug, title, summary, body, category, status: "draft" });
  catalog.push(article);

  return { ok: true, result: { created: true, article: { ...article } } };
}

export function updateDraft(
  catalog: Catalog,
  slug: string,
  title: string,
  summary: string,
): { ok: true; result: UpdateDraftResult } | { ok: false; error: string } {
  const article = catalog.find((entry) => entry.slug === slug);

  if (!article) {
    return { ok: false, error: `No article found for slug "${slug}".` };
  }

  if (article.status !== "draft") {
    return { ok: false, error: `Cannot update published article "${slug}".` };
  }

  article.title = title;
  article.summary = summary;
  article.revision = articleRevision(article);
  article.validatedRevision = null;
  article.approvedRevision = null;

  return { ok: true, result: { updated: true, article: { ...article } } };
}
