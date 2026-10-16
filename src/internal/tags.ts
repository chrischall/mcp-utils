/**
 * Linear tag-stripping shared by `scrape.stripHtml` and
 * `html.extractPlainTextFromHtml`. Zero-dep, and deliberately NOT in
 * `package.json#exports`.
 */

/**
 * Replace every `<…>` tag with `replacement` — exactly the matches of the
 * regex `/<[^>]+>/g` (a `<`, at least one non-`>` character, then the first
 * `>`), but in ONE forward pass. The regex re-scans the rest of the input from
 * every `<` when the `>` is withheld, which is quadratic: 14 s on 200 KB of
 * `<` (fleet-audit#1197). Here, once no `>` remains nothing later can be a
 * tag, so the tail is copied verbatim; and every `<` between an opener and its
 * `>` belongs to that tag, so the scan resumes after the `>`.
 */
export function replaceTags(html: string, replacement: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break; // no `>` left: no later `<` can open a tag either
    if (gt === lt + 1) {
      // `<>` is not a tag (`[^>]+` needs one character); keep the `<` and
      // retry from the `>`.
      out += html.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    out += html.slice(i, lt) + replacement;
    i = gt + 1;
  }
  return out + html.slice(i);
}
