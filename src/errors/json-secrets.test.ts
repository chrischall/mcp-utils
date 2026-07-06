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
