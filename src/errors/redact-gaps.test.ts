import { describe, expect, it } from 'vitest';

import { redactSecrets } from './index.js';

// Fleet audit 2026-09-24 PRIV-1 (fleet-audit#1057): shapes the redactor passed
// through verbatim although they arrive in the same upstream error bodies.
// All values below are synthetic.

describe('redactSecrets — session-id query params', () => {
  it.each(['sessionid', 'session_id', 'session-id', 'PHPSESSID', 'JSESSIONID', 'sessid', 'sid'])(
    'redacts ?%s=…',
    (name) => {
      const out = redactSecrets(`redirected to https://h.example/x?${name}=FAKEsess0123456789&page=2`);
      expect(out).not.toContain('FAKEsess0123456789');
      expect(out).toContain(`${name}=[REDACTED]`);
      expect(out).toContain('&page=2');
    },
  );

  it('leaves look-alike params alone', () => {
    const url = 'https://h.example/x?side=left&sidebar=1&siding=3&session=new';
    expect(redactSecrets(url)).toBe(url);
  });
});

describe('redactSecrets — x-… credential names as query params', () => {
  it.each(['x-api-key', 'X-Api-Key', 'x_api_key', 'x-auth-token', 'X-Goog-Api-Key', 'x-client-secret'])(
    'redacts ?%s=…',
    (name) => {
      const out = redactSecrets(`GET https://h.example/v1?${name}=FAKEkey1111AAAA&q=1`);
      expect(out).not.toContain('FAKEkey1111AAAA');
      expect(out).toContain('&q=1');
    },
  );

  it('leaves a non-credential x- param alone', () => {
    const url = 'https://h.example/v1?x-request-id=abc123&x-trace=1';
    expect(redactSecrets(url)).toBe(url);
  });
});

describe('redactSecrets — JSON cookie / set-cookie values', () => {
  it('redacts every cookie value under a "cookie" key, keeping the names', () => {
    const out = redactSecrets('{"cookie":"session=FAKEabc123; theme=dark","ok":1}');
    expect(out).toBe('{"cookie":"session=[REDACTED]; theme=[REDACTED]","ok":1}');
  });

  it('redacts the cookie value under a "set-cookie" key, keeping the name and attributes', () => {
    const out = redactSecrets('{"set-cookie":"sid=FAKEzzz999; Path=/; HttpOnly"}');
    expect(out).toBe('{"set-cookie":"sid=[REDACTED]; Path=/; HttpOnly"}');
  });

  it('handles "Set-Cookie" as an array of strings and single-quoted keys', () => {
    const out = redactSecrets(`{"Set-Cookie":["a=FAKEone; Path=/","b=FAKEtwo"],'Cookie':'c=FAKEthree'}`);
    expect(out).not.toMatch(/FAKE(one|two|three)/);
    expect(out).toBe(`{"Set-Cookie":["a=[REDACTED]; Path=/","b=[REDACTED]"],'Cookie':'c=[REDACTED]'}`);
  });

  it('leaves a non-cookie key that merely mentions cookies alone', () => {
    const body = '{"cookie_policy":"accept=all","cookies_enabled":true}';
    expect(redactSecrets(body)).toBe(body);
  });
});

describe('redactSecrets — non-string JSON secret values', () => {
  it.each([
    ['{"token": 1234567890}', '{"token": [REDACTED]}'],
    ['{"pin":1,"password":-98765,"x":2}', '{"pin":1,"password":[REDACTED],"x":2}'],
    ["{'api_key': 42.5}", "{'api_key': [REDACTED]}"],
  ])('redacts a numeric value: %s', (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it('leaves numeric non-secret keys alone', () => {
    const body = '{"expires_in":3600,"token_type":"Bearer","count":12}';
    expect(redactSecrets(body)).toBe(body);
  });
});
