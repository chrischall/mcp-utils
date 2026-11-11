/**
 * `@chrischall/mcp-utils/rich` — message bodies between HTML and the forms an
 * agent reads and writes cheaply.
 *
 * Zero dependencies. It is a subpath rather than part of the core barrel only
 * because few servers handle rich message bodies (lifted from
 * microsoft-teams-mcp, shared with office-outlook-mcp).
 *
 *  - Reading: {@link parseHtml} (a tolerant, hostile-input-safe parse),
 *    {@link sanitiseHtml}, {@link htmlToText}, {@link htmlToMarkdown},
 *    {@link linksOf}, {@link bodyStructure}, {@link isRichHtml}. Hidden
 *    content is dropped by default; {@link HtmlReadOptions.element} lets a
 *    caller keep or restyle its own elements (Teams' @mention spans).
 *  - Writing: {@link renderMarkdown}, a Markdown subset to safe HTML (raw HTML
 *    escaped, links http(s)/mailto only), with optional headings, quotes and
 *    `:key:` shortcodes.
 *  - Atoms: {@link escapeHtml}, {@link decodeEntities}, {@link attr},
 *    {@link safeHref}.
 */

export * from './html.js';
export * from './markdown.js';
