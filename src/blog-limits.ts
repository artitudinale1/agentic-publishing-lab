/** Blog API limits. Title, slug, and excerpt are measured after trimming. Markdown is measured exactly. */
export const BLOG_TITLE_MAX_LENGTH = 160;
export const BLOG_SLUG_MAX_LENGTH = 80;
export const BLOG_EXCERPT_MAX_LENGTH = 300;
export const BLOG_MARKDOWN_MAX_LENGTH = 100_000;

export const BLOG_FIELD_LIMITS =
  `Title is at most ${BLOG_TITLE_MAX_LENGTH} characters. ` +
  `Slug is at most ${BLOG_SLUG_MAX_LENGTH} characters. ` +
  `Summary is the excerpt and is at most ${BLOG_EXCERPT_MAX_LENGTH} characters. ` +
  `Markdown is at most ${BLOG_MARKDOWN_MAX_LENGTH} characters. ` +
  "The backend does not shorten these fields.";
