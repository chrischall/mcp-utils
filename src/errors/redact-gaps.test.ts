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

// Fleet audit library-candidates §16 (cluster 15): a PKCE `code_verifier` and
// Canvas's `?verifier=` file capability are bearer secrets carried in a URL or
// a form-encoded token exchange, and both reached tool errors verbatim
// (canvas-parent #380 quoted the file URL in a 404 message).
describe('redactSecrets — verifier query params', () => {
  it.each(['verifier', 'code_verifier', 'code-verifier', 'codeVerifier', 'VERIFIER'])('redacts ?%s=…', (name) => {
    const out = redactSecrets(`GET https://h.example/files/1/download?${name}=FAKEverif0123456789&wrap=1 → 404`);
    expect(out).not.toContain('FAKEverif0123456789');
    expect(out).toContain(`${name}=[REDACTED]`);
    expect(out).toContain('&wrap=1');
  });

  it('redacts a code_verifier in a form-encoded token-exchange body', () => {
    const out = redactSecrets(
      'token exchange failed: grant_type=authorization_code&code_verifier=FAKEpkce0123456789abcdef&client_id=app',
    );
    expect(out).not.toContain('FAKEpkce0123456789abcdef');
    expect(out).toContain('&client_id=app');
  });

  it('leaves look-alike params alone', () => {
    expect(redactSecrets('https://h.example/x?verified=true&unverifiable=1')).toBe(
      'https://h.example/x?verified=true&unverifiable=1',
    );
  });
});

describe('redactSecrets — code_verifier JSON values', () => {
  it.each(['code_verifier', 'codeVerifier', 'code-verifier'])('redacts "%s": "…"', (key) => {
    const out = redactSecrets(`{"grant_type":"authorization_code","${key}":"FAKEpkce0123456789abcdef"}`);
    expect(out).not.toContain('FAKEpkce0123456789abcdef');
    expect(out).toContain(`"${key}":"[REDACTED]"`);
    expect(out).toContain('"grant_type":"authorization_code"');
  });
});

// fleet-audit#1297: shapes still passed verbatim after #1057 — an OAuth
// implicit-flow fragment, `;` path params, `api_token` / bare `secret` / bare
// `auth` query params, and an AWS secret access key as a JSON value.
describe('redactSecrets — fragments, path params and more key names (fleet-audit#1297)', () => {
  it.each([
    ['an implicit-grant fragment', 'https://x.example/cb#access_token=FAKEtok0123456789XYZ&token_type=bearer', '&token_type=bearer'],
    ['a bare #token= fragment', 'https://x.example/cb#token=FAKEtok0123456789XYZ', 'x.example/cb#token='],
    ['a ;access_token= path param', 'https://x.example/p;access_token=FAKEtok0123456789XYZ', 'x.example/p;access_token='],
    ['?api_token=', 'https://x.example/v1?api_token=FAKEtok0123456789XYZ&q=1', '&q=1'],
    ['?apiToken=', 'https://x.example/v1?apiToken=FAKEtok0123456789XYZ&q=1', '&q=1'],
    ['?api-token=', 'https://x.example/v1?api-token=FAKEtok0123456789XYZ', 'api-token='],
    ['?secret=', 'https://x.example/v1?secret=FAKEtok0123456789XYZ&q=1', '&q=1'],
    ['?auth=', 'https://x.example/v1?q=1&auth=FAKEtok0123456789XYZ', '?q=1'],
    ['an aws_secret_access_key JSON value', '{"aws_secret_access_key":"FAKEtok0123456789XYZ","region":"us-east-1"}', '"region":"us-east-1"'],
    ['an AwsSecretAccessKey JSON value', "{'AwsSecretAccessKey': 'FAKEtok0123456789XYZ'}", 'AwsSecretAccessKey'],
  ])('redacts %s', (_label, input, kept) => {
    const out = redactSecrets(input);
    expect(out).not.toContain('FAKEtok0123456789XYZ');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain(kept);
  });

  it('leaves non-secret look-alikes alone', () => {
    for (const s of [
      'https://x.example/docs#section=2&authors=3',
      'https://x.example/v1?author=jo&secretary=no&authority=x',
      'see &#39;quoted&#39; text; token_type=bearer',
      '{"aws_region":"us-east-1","access_key_id_hint":"AKIA…"}',
    ]) {
      expect(redactSecrets(s)).toBe(s);
    }
  });
});
