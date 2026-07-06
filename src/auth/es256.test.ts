import { createVerify, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signEs256Jwt } from './index.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('signEs256Jwt', () => {
  it('produces a verifiable three-segment ES256 JWS', () => {
    const jwt = signEs256Jwt(privatePem, { iss: 'ABC', aud: 'appstoreconnect-v1', exp: 123 });
    const [h, p, s] = jwt.split('.');
    expect(h && p && s).toBeTruthy();

    const verify = createVerify('SHA256');
    verify.update(`${h}.${p}`);
    const ok = verify.verify(
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s!, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('sets the standard header and merges extras (kid)', () => {
    const jwt = signEs256Jwt(privatePem, { iss: 'x' }, { header: { kid: 'KEY123' } });
    const header = decodeSegment(jwt.split('.')[0]!);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'KEY123' });
  });

  it('round-trips the payload verbatim', () => {
    const payload = { iss: 'ABC', iat: 1, exp: 2, aud: 'aud' };
    const jwt = signEs256Jwt(privatePem, payload);
    expect(decodeSegment(jwt.split('.')[1]!)).toEqual(payload);
  });
});
