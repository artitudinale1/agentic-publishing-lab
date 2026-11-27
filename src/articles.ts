export type Article = {
  slug: string;
  title: string;
  summary: string;
};

export type FindArticleResult =
  | { found: true; article: Article }
  | { found: false; slug: string; message: string };

/**
 * Local stand-in for a catalog. This array is the entire database.
 * Nothing here contacts a blog, CDN, or other service.
 */
const ARTICLES: readonly Article[] = [
  {
    slug: "beta-driven-development",
    title: "Beta-Driven Development: An Agentic Architecture for Resource Acquisition",
    summary:
      "Beta is a black-and-white cat specialising in resource acquisition, human interaction, security and operational sustainability.",
  },
];

export function findArticle(slug: string): FindArticleResult {
  const article = ARTICLES.find((entry) => entry.slug === slug);

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
