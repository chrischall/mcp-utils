import { describe, expect, it } from 'vitest';

import { redactSecrets, truncateErrorMessage } from './index.js';

describe('redactSecrets — JSON-valued secret keys', () => {
  it('redacts the value of common secret keys in a JSON body', () => {
    const body = '{"refresh_token":"1//0gAbCdEfGhIjKlMnOpQr","expires_in":3600}';
    const out = redactSecrets(body);
    expect(out).not.toContain('1//0gAbCdEfGhIjKlMnOpQr');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('"expires_in":3600'); // non-secret keys untouched
  });

  it('covers access_token / client_secret / password / api_key / secret', () => {
    for (const key of ['access_token', 'client_secret', 'password', 'api_key', 'apiKey', 'secret']) {
      const body = `{"${key}":"SUPERSECRETVALUE123456"}`;
      expect(redactSecrets(body)).not.toContain('SUPERSECRETVALUE123456');
    }
  });

  it('tolerates whitespace and single quotes around the colon/value', () => {
    expect(redactSecrets(`{ "refresh_token" : "abc123def456ghi" }`)).not.toContain('abc123def456ghi');
    expect(redactSecrets(`{'password':'hunter2hunter2'}`)).not.toContain('hunter2hunter2');
  });

  it('does not touch a non-secret key that merely contains a secret-ish substring', () => {
    // `token_type` is not a secret value — only exact secret keys are redacted.
    const out = redactSecrets('{"token_type":"Bearer","x":1}');
    expect(out).toContain('"token_type":"Bearer"');
  });

  it('fully redacts a double-quoted value containing an apostrophe (no tail leak)', () => {
    // The value class must stop at the SAME quote that opened it — a shared
    // [^"']* would halt at the apostrophe and leak the suffix.
    const out = redactSecrets(`{"password":"hunter's2secret"}`);
    expect(out).not.toContain("'s2secret");
    expect(out).not.toContain('hunter');
    expect(out).toBe('{"password":"[REDACTED]"}');
  });

  it('leaves client_id visible — a public OAuth identifier, not a credential (RFC 6749 §2.2)', () => {
    const out = redactSecrets('{"client_id":"my-app-1234","client_secret":"realsecretvalue"}');
    expect(out).toContain('"client_id":"my-app-1234"');
    expect(out).not.toContain('realsecretvalue');
  });

  it('still redacts before truncation (order preserved) for JSON bodies', () => {
    const body = '{"refresh_token":"' + 'A'.repeat(600) + '"}';
    const out = truncateErrorMessage(body, 100);
    expect(out).not.toContain('AAAA');
    expect(out).toContain('[REDACTED]');
  });
});

describe('redactSecrets — AWS SigV4 presigned-URL params', () => {
  it('redacts X-Amz-Security-Token / X-Amz-Signature / X-Amz-Credential in a presigned URL', () => {
    const url =
      'https://b.s3.amazonaws.com/k?X-Amz-Credential=AKIAEXAMPLE/20260706/us-east-1/s3/aws4_request' +
      '&X-Amz-Signature=abc123def456deadbeef&X-Amz-Security-Token=FwoGZXIvYXdzEEEsecrettoken';
    const out = redactSecrets(url);
    expect(out).not.toContain('FwoGZXIvYXdzEEEsecrettoken');
    expect(out).not.toContain('abc123def456deadbeef');
    expect(out).toContain('X-Amz-Security-Token=[REDACTED]');
    expect(out).toContain('X-Amz-Signature=[REDACTED]');
    expect(out).toContain('X-Amz-Credential=[REDACTED]');
  });

  it('leaves non-credential X-Amz params (X-Amz-Date, X-Amz-Expires) visible', () => {
    const out = redactSecrets('?X-Amz-Date=20260706T000000Z&X-Amz-Expires=900');
    expect(out).toContain('X-Amz-Date=20260706T000000Z');
    expect(out).toContain('X-Amz-Expires=900');
  });
});

// ---------------------------------------------------------------------------
// audit 2026-09 (SEC-2): camelCase / kebab JSON keys, form passwords, API-key headers
// ---------------------------------------------------------------------------

describe('redactSecrets — separator- and case-insensitive secret keys', () => {
  const V = 'SUPERSECRETVALUE123456';
  for (const key of [
    'accessToken',
    'refreshToken',
    'clientSecret',
    'sessionToken',
    'idToken',
    'authToken',
    'access-token',
    'client-secret',
    'API_KEY',
    'x-api-key',
    'privateKey',
  ]) {
    it(`redacts "${key}" in a JSON body`, () => {
      const out = redactSecrets(`{"${key}":"${V}","ok":1}`);
      expect(out).not.toContain(V);
      expect(out).toContain('"ok":1');
    });
  }

  it('redacts a JSON value containing escaped quotes, all the way to the real closing quote', () => {
    const out = redactSecrets('{"password":"abc\\"defSECRETTAIL","ok":1}');
    expect(out).not.toContain('SECRETTAIL');
    expect(out).toBe('{"password":"[REDACTED]","ok":1}');
  });

  it('still leaves non-secret keys alone', () => {
    const body = '{"token_type":"Bearer","tokenType":"Bearer","sessionId":"s-1","expires_in":3600}';
    expect(redactSecrets(body)).toBe(body);
  });
});

describe('redactSecrets — form and query passwords', () => {
  it('redacts a password field in an echoed form body', () => {
    const out = redactSecrets('username=a&password=hunter2xyz&remember=1');
    expect(out).not.toContain('hunter2xyz');
    expect(out).toContain('username=a');
    expect(out).toContain('remember=1');
  });

  it('redacts a password that is the first form field', () => {
    expect(redactSecrets('password=hunter2xyz&username=a')).not.toContain('hunter2xyz');
    expect(redactSecrets('body: passwd=hunter2xyz')).not.toContain('hunter2xyz');
  });

  it('redacts camelCase secret query params and an OAuth code', () => {
    const out = redactSecrets('https://x.test/cb?accessToken=AAA111BBB&clientSecret=CCC222&code=DDD333EEE444FFF555&page=2');
    expect(out).not.toMatch(/AAA111BBB|CCC222|DDD333/);
    expect(out).toContain('page=2');
  });
});

describe('redactSecrets — API-key and token headers', () => {
  for (const header of ['X-Api-Key', 'x-api-key', 'Api-Key', 'X-Auth-Token', 'X-Access-Token', 'X-Goog-Api-Key']) {
    it(`redacts a ${header} header value`, () => {
      const out = redactSecrets(`${header}: 0123456789abcdef\nContent-Type: text/plain`);
      expect(out).not.toContain('0123456789abcdef');
      expect(out).toContain('Content-Type: text/plain');
    });
  }

  it('does not mangle an ordinary Authorization: Bearer header', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer [REDACTED]');
  });
});

// Review follow-up: header-named JSON keys, x_api_key, quoted form bodies,
// apiSecret/csrfToken, and no over-redaction of short `code=` values.
describe('redactSecrets — review follow-up gaps', () => {
  const V = 'SUPERSECRETVALUE123456';
  for (const key of ['x-auth-token', 'X-Goog-Api-Key', 'x_api_key', 'apiSecret', 'api_secret', 'csrfToken', 'xsrf-token']) {
    it(`redacts JSON key "${key}"`, () => {
      const out = redactSecrets(`{"${key}":"${V}","ok":1}`);
      expect(out).not.toContain(V);
      expect(out).toContain('"ok":1');
    });
  }

  it('redacts a JSON authorization value including the Basic credential', () => {
    const out = redactSecrets('{"authorization":"Basic dXNlcjpwYXNzd29yZA==","ok":1}');
    expect(out).not.toContain('dXNlcjpwYXNzd29yZA');
    expect(out).toContain('"ok":1');
  });

  it('redacts an x_api_key header-style line', () => {
    expect(redactSecrets(`x_api_key: ${V}`)).not.toContain(V);
  });

  it('redacts a form body that starts right after a quote', () => {
    const out = redactSecrets(`body was "password=hunter2xyz&u=a"`);
    expect(out).not.toContain('hunter2xyz');
    expect(out).toContain('u=a');
  });

  it('redacts query apiSecret / csrfToken', () => {
    const out = redactSecrets('https://x.test/?apiSecret=AAA111BBB&csrfToken=CCC222DDD&page=1');
    expect(out).not.toMatch(/AAA111BBB|CCC222DDD/);
  });

  it('keeps a short non-OAuth code= value', () => {
    expect(redactSecrets('GET /x?code=E123&page=2 failed')).toContain('code=E123');
  });

  it('still redacts an OAuth authorization code', () => {
    const out = redactSecrets('https://app.test/cb?code=4/0AbCdEfGhIjKlMnOpQrStUv&state=xyz');
    expect(out).not.toContain('4/0AbCdEfGhIjKlMnOpQrStUv');
  });
});
