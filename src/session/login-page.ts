/**
 * "Did the site just hand me its login page?" — the session-expiry predicate
 * for sites that answer an expired cookie session with an HTTP 200 (or a
 * redirect) rather than a 401.
 *
 * Three fleet servers decided this locally, each differently (fleet-audit#1155):
 * artsonia-mcp's `looksUnauthenticated` (final URL, a manual 3xx `Location`, or
 * the login form rendered in place), signupgenius-mcp's `isSessionExpired`
 * (401, or a non-JSON 200 carrying the login form's markers), and
 * canvas-parent-mcp (401 only). artsonia's first version matched body PROSE and
 * a fan comment reading "You need to log in…" forced a needless re-login on
 * every read of that artwork — so the rules here are STRUCTURAL only:
 *
 *  - a configured status (default `401`);
 *  - the response's final URL, or its `Location`, whose path+search matches
 *    `url` — a login URL merely mentioned in an (encoded) query parameter of
 *    another page does not count;
 *  - a `<form>` whose `action` matches `form.action`, containing (before its
 *    `</form>` or the next `<form>`) an input named `form.field` — or, with no
 *    field named, any `type=password` input. User-generated text arrives
 *    HTML-escaped, so it cannot forge that structure. The body is only scanned
 *    when the response is HTML (or says nothing about its type): JSON carries
 *    user text too (signupgenius' lesson).
 *
 * Every scan is linear in the body — this runs on every response of the
 * session — and the body considered is capped at {@link LOGIN_PAGE_SCAN_MAX}.
 */

/** A response as {@link looksLikeLoginPage} sees it. Every field is optional. */
export interface LoginPageView {
  status?: number;
  /** The final URL (after any followed redirects). */
  url?: string;
  /** A `Location` header, for a redirect that was not followed. */
  location?: string | null;
  /** The body text, when the caller has it. */
  body?: string;
  /** The `content-type`; a non-HTML type skips the form scan. */
  contentType?: string | null;
}

/** What identifies a site's login page. Omitted rules are not checked. */
export interface LoginPageSignals {
  /** Matched against the path + search of the final URL and of `Location`. */
  url?: RegExp;
  /**
   * The login form. `action` filters forms by their `action` attribute (any
   * form when omitted); `field` names the input that must sit inside it
   * (case-insensitive), defaulting to any `type=password` input.
   */
  form?: { action?: RegExp; field?: string };
  /** Statuses that mean expired by themselves. Default `[401]`; `[]` for none. */
  statuses?: readonly number[];
}

/** Bytes of body {@link looksLikeLoginPage} considers. A login page is small. */
export const LOGIN_PAGE_SCAN_MAX = 512 * 1024;

/** Longest form open tag read for its `action` (a real one is far shorter). */
const MAX_TAG = 4096;

const FORM_OPEN = /<form\b/gi;
const FORM_CLOSE = /<\/form\s*>/gi;
const ACTION_ATTR = /\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i;
const PASSWORD_INPUT = /\btype\s*=\s*["']?password(?=["'\s/>])/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Path + search of `u` (relative values resolved against a dummy origin); `u` itself if unparseable. */
function pathAndSearch(u: string): string {
  try {
    const parsed = new URL(u, 'http://localhost');
    return parsed.pathname + parsed.search;
  } catch {
    return u;
  }
}

function indicesOf(re: RegExp, body: string): number[] {
  const out: number[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) out.push(m.index);
  return out;
}

function rendersLoginForm(body: string, form: NonNullable<LoginPageSignals['form']>): boolean {
  const fieldRe =
    form.field !== undefined
      ? new RegExp(`\\bname\\s*=\\s*["']?${escapeRegExp(form.field)}(?=["'\\s/>])`, 'i')
      : PASSWORD_INPUT;
  const opens = indicesOf(FORM_OPEN, body);
  const closes = indicesOf(FORM_CLOSE, body);
  let c = 0;
  for (let i = 0; i < opens.length; i++) {
    const start = opens[i]!;
    // Forms do not nest: a form's content ends at its `</form>` or the next `<form>`.
    while (c < closes.length && closes[c]! < start) c++;
    const nextOpen = opens[i + 1] ?? body.length;
    const end = Math.min(closes[c] ?? body.length, nextOpen);
    const region = body.slice(start, end);
    if (form.action !== undefined) {
      const tagEnd = region.indexOf('>');
      const tag = region.slice(0, tagEnd === -1 ? Math.min(region.length, MAX_TAG) : Math.min(tagEnd, MAX_TAG));
      const m = ACTION_ATTR.exec(tag);
      const action = m === null ? undefined : (m[1] ?? m[2] ?? m[3]);
      if (action === undefined || !form.action.test(action)) continue;
    }
    if (fieldRe.test(region)) return true;
  }
  return false;
}

/**
 * Whether `page` is the site's login page by `signals` — sync and pure, for a
 * caller that already has the pieces (a custom transport, a fetchproxy result,
 * a signed-out check outside the session manager).
 */
export function looksLikeLoginPage(page: LoginPageView, signals: LoginPageSignals): boolean {
  const statuses = signals.statuses ?? [401];
  if (page.status !== undefined && statuses.includes(page.status)) return true;
  if (signals.url !== undefined) {
    const re = signals.url;
    if (page.url && re.test(pathAndSearch(page.url))) return true;
    if (page.location && re.test(pathAndSearch(page.location))) return true;
  }
  if (signals.form !== undefined && page.body) {
    const ct = page.contentType;
    if (ct && !/html/i.test(ct)) return false;
    const body = page.body.length > LOGIN_PAGE_SCAN_MAX ? page.body.slice(0, LOGIN_PAGE_SCAN_MAX) : page.body;
    return rendersLoginForm(body, signals.form);
  }
  return false;
}

/**
 * An `isExpired` for {@link CookieSessionManager}: true when the response is
 * the login page by `signals` (see {@link looksLikeLoginPage}).
 *
 * Takes a web `Response` — its body read from a CLONE, and only when a `form`
 * rule needs it, so the caller can still read the original — or any object
 * with the {@link LoginPageView} fields (artsonia's `{ url, location, body }`).
 */
export function expiredByLoginPage(
  signals: LoginPageSignals,
): (res: Response | LoginPageView) => Promise<boolean> {
  return async (res) => {
    if (res instanceof Response) {
      const view: LoginPageView = {
        status: res.status,
        url: res.url,
        location: res.headers.get('location'),
        contentType: res.headers.get('content-type'),
      };
      if (looksLikeLoginPage(view, { ...signals, form: undefined })) return true;
      if (signals.form === undefined || res.body === null) return false;
      if (view.contentType && !/html/i.test(view.contentType)) return false;
      try {
        view.body = await res.clone().text();
      } catch {
        return false;
      }
      return looksLikeLoginPage(view, signals);
    }
    return looksLikeLoginPage(res, signals);
  };
}
