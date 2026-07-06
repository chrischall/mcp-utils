/**
 * `signEs256Jwt` — minimal ES256 (P-256 / SHA-256) JWS signer for APIs that
 * authenticate with a self-minted JWT (App Store Connect's `kid`/`iss`/`aud`
 * scheme). mcp-utils already DECODES JWTs (`decodeJwtExp` and friends); this is
 * the signing counterpart, hoisted from app-store-connect's `signES256` +
 * `mintJwt`.
 *
 * Uses `dsaEncoding: 'ieee-p1363'` (raw `r||s`) — the JOSE signature format —
 * NOT the DER default, which upstreams reject.
 */

import { createSign } from 'node:crypto';

const b64url = (data: string | Buffer): string =>
  (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64url');

/** Options for {@link signEs256Jwt}. */
export interface SignEs256JwtOptions {
  /** Extra header fields merged over `{ alg: 'ES256', typ: 'JWT' }` (e.g. `kid`). */
  header?: Record<string, unknown>;
}

/**
 * Sign a JWT with ES256. `privateKeyPem` is a PEM-encoded P-256 private key
 * (PKCS#8 `.p8` contents); the payload is serialized verbatim — the caller
 * supplies `iss` / `iat` / `exp` / `aud` per its API's rules. Returns the
 * compact `header.payload.signature` JWS.
 */
export function signEs256Jwt(
  privateKeyPem: string,
  payload: Record<string, unknown>,
  opts: SignEs256JwtOptions = {},
): string {
  const header = { alg: 'ES256', typ: 'JWT', ...opts.header };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('SHA256');
  signer.update(signingInput);
  const signature = signer.sign({ key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}
