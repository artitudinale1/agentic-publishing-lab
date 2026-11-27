import type { Catalog } from "./articles";

/**
 * Human approval is not a model tool and is not required to save a draft.
 * Publication stays outside this workflow.
 */

export function approveDraft(
  catalog: Catalog,
  slug: string,
  revision: string,
): { ok: true; approved: true; slug: string; revision: string } | { ok: false; error: string } {
  const article = catalog.find((entry) => entry.slug === slug);
  if (!article) {
    return { ok: false, error: `No article found for slug "${slug}".` };
  }

  if (article.status !== "draft") {
    return { ok: false, error: `Cannot approve published article "${slug}".` };
  }

  if (article.revision !== revision) {
    return { ok: false, error: "Approval revision does not match the saved draft." };
  }

  if (article.validatedRevision !== revision) {
    return { ok: false, error: "Draft must be validated before approval." };
  }

  article.approvedRevision = revision;
  return { ok: true, approved: true, slug, revision };
}

export function rejectDraft(
  catalog: Catalog,
  slug: string,
): { ok: true; rejected: true; slug: string } | { ok: false; error: string } {
  const article = catalog.find((entry) => entry.slug === slug);
  if (!article) {
    return { ok: false, error: `No article found for slug "${slug}".` };
  }

  if (article.status !== "draft") {
    return { ok: false, error: `Cannot reject approval for published article "${slug}".` };
  }

  article.approvedRevision = null;
  return { ok: true, rejected: true, slug };
}
