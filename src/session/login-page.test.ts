/**
 * The "login page on HTTP 200" expiry predicate (fleet-audit#1155).
 *
 * artsonia-mcp (`looksUnauthenticated`), signupgenius-mcp (`isSessionExpired`)
 * and canvas-parent-mcp each decided expiry from a response by a local
 * heuristic, and artsonia's first one went wrong by matching body PROSE — a fan
 * comment reading "You need to log in" forced a re-login on every read of that
 * artwork. These pin the structural rules the shared predicate keeps.
 */
import { describe, expect, it, vi } from 'vitest';

import { CookieSessionManager, expiredByLoginPage, looksLikeLoginPage } from './index.js';

const ARTSONIA = { url: /\/members\/login\.asp/i, form: { action: /login\.asp/i, field: 'Password' } };

const LOGIN_FORM =
  '<html><body><form method="post" action="/members/login.asp"><input name="Username"><input type="password" name="Password"></form></body></html>';

describe('looksLikeLoginPage', () => {
  it('flags a final URL on the login page', () => {
    expect(looksLikeLoginPage({ status: 200, url: 'https://www.artsonia.com/members/login.asp?ReturnUrl=%2F' }, ARTSONIA)).toBe(true);
  });

  it('flags a manual 3xx whose Location is the login page, relative or absolute', () => {
    expect(looksLikeLoginPage({ status: 302, url: 'https://x.test/members/', location: '/members/login.asp' }, ARTSONIA)).toBe(true);
    expect(looksLikeLoginPage({ status: 302, location: 'https://x.test/members/login.asp' }, ARTSONIA)).toBe(true);
  });

  it('does not flag a login URL that only appears in the query string of another page', () => {
    // An encoded return URL is not a path.
    expect(looksLikeLoginPage({ status: 200, url: 'https://x.test/art/1?from=%2Fmembers%2Flogin.asp' }, ARTSONIA)).toBe(false);
  });

  it('matches `url` against path + search only, so an anchored pattern works and a fragment never matches', () => {
    const anchored = { url: /^\/members\/login\.asp/i };
    expect(looksLikeLoginPage({ url: 'https://x.test/members/login.asp?x=1' }, anchored)).toBe(true);
    expect(looksLikeLoginPage({ url: 'https://x.test/art/1#/members/login.asp' }, { url: /\/members\/login\.asp/i })).toBe(false);
  });

  it('flags the login form rendered in place', () => {
    expect(looksLikeLoginPage({ status: 200, url: 'https://x.test/members/', body: LOGIN_FORM }, ARTSONIA)).toBe(true);
  });

  it('does not flag prose about logging in (user-generated text)', () => {
    const body = '<div class="comment">You need to log in at /members/login.asp to see the Password!</div>';
    expect(looksLikeLoginPage({ status: 200, url: 'https://x.test/art/1', body }, ARTSONIA)).toBe(false);
  });

  it('requires the password field INSIDE the login form', () => {
    const body =
      '<form action="/members/login.asp"><input name="Username"></form>' +
      '<form action="/settings"><input name="Password"></form>';
    expect(looksLikeLoginPage({ status: 200, body }, ARTSONIA)).toBe(false);
  });

  it('treats an unclosed login form as running to the next form or the end of the body', () => {
    expect(looksLikeLoginPage({ status: 200, body: '<form action=login.asp><input name=Password>' }, ARTSONIA)).toBe(true);
    expect(
      looksLikeLoginPage({ status: 200, body: '<form action=login.asp><input name=User><form action=/x><input name=Password>' }, ARTSONIA),
    ).toBe(false);
  });

  it('with no field named, any password input inside a matching form counts', () => {
    const body = '<form id="loginform" action="/index.cfm?go=c.Login"><input type="password" name="pw"></form>';
    expect(looksLikeLoginPage({ status: 200, body }, { form: { action: /go=c\.Login/i } })).toBe(true);
    expect(looksLikeLoginPage({ status: 200, body: '<form action="/search"><input type="text" name="q"></form>' }, { form: {} })).toBe(false);
  });

  it('flags the expiry statuses (default 401) and nothing else by status', () => {
    expect(looksLikeLoginPage({ status: 401 }, {})).toBe(true);
    expect(looksLikeLoginPage({ status: 403 }, {})).toBe(false);
    expect(looksLikeLoginPage({ status: 403 }, { statuses: [401, 403] })).toBe(true);
    expect(looksLikeLoginPage({ status: 401 }, { statuses: [] })).toBe(false);
  });

  it('does not scan a non-HTML body for a form (signupgenius: JSON carries user text)', () => {
    expect(looksLikeLoginPage({ status: 200, contentType: 'application/json', body: LOGIN_FORM }, ARTSONIA)).toBe(false);
    expect(looksLikeLoginPage({ status: 200, contentType: 'text/html; charset=utf-8', body: LOGIN_FORM }, ARTSONIA)).toBe(true);
  });

  it('stays linear on adversarial markup', () => {
    const big = '<form action="'.repeat(20_000) + ' name='.repeat(20_000) + '<form '.repeat(20_000);
    const started = performance.now();
    looksLikeLoginPage({ status: 200, body: big }, ARTSONIA);
    looksLikeLoginPage({ status: 200, body: big }, { form: {} });
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('expiredByLoginPage — an isExpired for CookieSessionManager', () => {
  it('reads a web Response through a clone, leaving the body for the caller', async () => {
    const isExpired = expiredByLoginPage(ARTSONIA);
    const res = new Response(LOGIN_FORM, { status: 200, headers: { 'content-type': 'text/html' } });
    expect(await isExpired(res)).toBe(true);
    expect(await res.text()).toBe(LOGIN_FORM);
  });

  it('reads Location off a manual-redirect Response', async () => {
    const res = new Response(null, { status: 302, headers: { location: '/members/login.asp' } });
    expect(await expiredByLoginPage(ARTSONIA)(res)).toBe(true);
  });

  it('does not read the body when no form rule is configured', async () => {
    const res = new Response('<p>hi</p>', { status: 200, headers: { 'content-type': 'text/html' } });
    const clone = vi.spyOn(res, 'clone');
    expect(await expiredByLoginPage({ url: /\/login/ })(res)).toBe(false);
    expect(clone).not.toHaveBeenCalled();
    expect(res.bodyUsed).toBe(false);
  });

  it('accepts a custom transport shape (artsonia: { url, location, body })', async () => {
    const isExpired = expiredByLoginPage(ARTSONIA);
    expect(await isExpired({ url: 'https://x.test/members/', location: '/members/login.asp', body: '' })).toBe(true);
    expect(await isExpired({ url: 'https://x.test/members/', body: '<p>hello</p>' })).toBe(false);
  });

  it('drives a CookieSessionManager re-login + single replay', async () => {
    let logins = 0;
    const mgr = new CookieSessionManager<{ cookieHeader: string }>({
      login: async () => ({ cookieHeader: `c${++logins}` }),
      isExpired: expiredByLoginPage(ARTSONIA),
    });
    await mgr.ensure();
    const seen: string[] = [];
    const res = await mgr.withSession(async (s) => {
      seen.push(s.cookieHeader);
      return s.cookieHeader === 'c1'
        ? new Response(LOGIN_FORM, { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    expect(seen).toEqual(['c1', 'c2']);
    expect(await res.json()).toEqual({ ok: true });
  });
});
