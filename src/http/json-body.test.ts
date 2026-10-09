import { describe, expect, it, vi } from 'vitest';

import { McpToolError, UpstreamFormatError, wrapToolError } from '../errors/index.js';
import { EdgeBlockedError, createApiClient, parseJsonBody } from './index.js';

const HTML_INTERSTITIAL = `<!DOCTYPE html><html><head><title>Sign in</title></head>
<body><form action="/login"><input name="csrf" value="abc"></form></body></html>`;

const CLOUDFLARE_CHALLENGE = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><script>window._cf_chl_opt={cvId:'3'}</script></body></html>`;

function stubFetch(res: Response) {
  return vi.fn(async () => res) as unknown as typeof fetch;
}

function client(res: Response) {
  return createApiClient({
    baseUrl: 'https://api.example.test',
    getToken: () => 't',
    serviceName: 'Example',
    fetchImpl: stubFetch(res),
  });
}

describe('UpstreamFormatError', () => {
  it('is an McpToolError carrying what was received, with a hint', () => {
    const err = new UpstreamFormatError({
      service: 'Example',
      method: 'get',
      path: '/v1/me',
      status: 200,
      contentType: 'text/html',
      received: 'non-json',
    });
    expect(err).toBeInstanceOf(McpToolError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UpstreamFormatError');
    expect(err.message).toBe('Example returned a non-JSON response to GET /v1/me (HTTP 200, text/html).');
    expect(err.status).toBe(200);
    expect(err.contentType).toBe('text/html');
    expect(err.received).toBe('non-json');
    expect(err.expected).toBeUndefined();
    expect(err.hint).toMatch(/sign-in|interstitial|changed/i);
  });

  it('describes a wrong-shape body against what was expected', () => {
    const err = new UpstreamFormatError({ service: 'Example', received: 'null', expected: 'object' });
    expect(err.message).toBe('Example returned null where a JSON object was expected.');
    expect(err.expected).toBe('object');
    expect(new UpstreamFormatError({ received: 'empty', expected: 'array' }).message).toBe(
      'The upstream service returned an empty body where a JSON array was expected.',
    );
  });

  it('redacts a credential that rode in on the path', () => {
    const err = new UpstreamFormatError({
      service: 'Example',
      method: 'GET',
      path: '/v1/me?access_token=supersecretvalue123',
      received: 'non-json',
    });
    expect(err.message).not.toContain('supersecretvalue123');
  });

  it('survives wrapToolError with its hint', () => {
    const wrapped = wrapToolError('example_get', new UpstreamFormatError({ received: 'non-json' }));
    expect(wrapped.hint).toBeDefined();
  });
});

describe('parseJsonBody', () => {
  it('parses valid JSON of any shape when no expect is given', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonBody('[1,2]')).toEqual([1, 2]);
    expect(parseJsonBody('null')).toBeNull();
    expect(parseJsonBody('3')).toBe(3);
  });

  it('returns undefined for an empty body when no expect is given (the fetchJson contract)', () => {
    expect(parseJsonBody('')).toBeUndefined();
    expect(parseJsonBody(' \n ')).toBeUndefined();
  });

  it('throws UpstreamFormatError (not SyntaxError) for a non-JSON body, without echoing it', () => {
    let err: unknown;
    try {
      parseJsonBody(HTML_INTERSTITIAL, { service: 'Example', method: 'GET', path: '/v1/me', status: 200, contentType: 'text/html' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UpstreamFormatError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as UpstreamFormatError).received).toBe('non-json');
    expect((err as Error).message).toBe('Example returned a non-JSON response to GET /v1/me (HTTP 200, text/html).');
    expect((err as Error).message).not.toContain('csrf');
    expect((err as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('reads the content type from headers when none is passed', () => {
    const err = (() => {
      try {
        parseJsonBody('nope', { headers: new Headers({ 'content-type': 'text/plain' }), status: 200 });
      } catch (e) {
        return e as UpstreamFormatError;
      }
      return undefined;
    })();
    expect(err?.contentType).toBe('text/plain');
  });

  it('reports an edge challenge as EdgeBlockedError, not a format error', () => {
    expect(() => parseJsonBody(CLOUDFLARE_CHALLENGE, { service: 'Example', status: 200 })).toThrow(EdgeBlockedError);
    expect(() =>
      parseJsonBody('<html></html>', { status: 200, headers: { 'cf-mitigated': 'challenge' } }),
    ).toThrow(EdgeBlockedError);
  });

  it("enforces expect: 'object'", () => {
    expect(parseJsonBody('{"a":1}', { expect: 'object' })).toEqual({ a: 1 });
    for (const [text, received] of [
      ['null', 'null'],
      ['[]', 'array'],
      ['"x"', 'string'],
      ['1', 'number'],
      ['true', 'boolean'],
      ['', 'empty'],
      ['   ', 'empty'],
    ] as const) {
      let err: unknown;
      try {
        parseJsonBody(text, { expect: 'object', service: 'Example' });
      } catch (e) {
        err = e;
      }
      expect(err, text).toBeInstanceOf(UpstreamFormatError);
      expect((err as UpstreamFormatError).received, text).toBe(received);
      expect((err as UpstreamFormatError).expected, text).toBe('object');
    }
  });

  it("enforces expect: 'array'", () => {
    expect(parseJsonBody('[1]', { expect: 'array' })).toEqual([1]);
    expect(() => parseJsonBody('{}', { expect: 'array' })).toThrow(/returned an object where a JSON array was expected/);
    expect(() => parseJsonBody('null', { expect: 'array' })).toThrow(UpstreamFormatError);
  });
});

describe('createApiClient.fetchJson body format', () => {
  it('throws UpstreamFormatError for an HTML 200 instead of a raw SyntaxError', async () => {
    const err = await client(
      new Response(HTML_INTERSTITIAL, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    )
      .fetchJson('GET', '/v1/me')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamFormatError);
    expect((err as Error).message).toBe(
      'Example returned a non-JSON response to GET /v1/me (HTTP 200, text/html; charset=utf-8).',
    );
  });

  it('throws EdgeBlockedError for a Cloudflare challenge served with a 200', async () => {
    const err = await client(new Response(CLOUDFLARE_CHALLENGE, { status: 200, headers: { 'content-type': 'text/html' } }))
      .fetchJson('GET', '/v1/me')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect((err as EdgeBlockedError).status).toBe(200);
  });

  it('keeps returning null / undefined / scalars when no expect is given', async () => {
    await expect(client(new Response('null', { status: 200 })).fetchJson('GET', '/a')).resolves.toBeNull();
    await expect(client(new Response('', { status: 200 })).fetchJson('GET', '/a')).resolves.toBeUndefined();
    await expect(client(new Response(null, { status: 204 })).fetchJson('GET', '/a')).resolves.toBeUndefined();
    await expect(client(new Response('7', { status: 200 })).fetchJson('GET', '/a')).resolves.toBe(7);
  });

  it('applies a per-request expect to null, empty and 204 bodies', async () => {
    const nullErr = await client(new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }))
      .fetchJson('GET', '/a', { expect: 'object' })
      .catch((e: unknown) => e);
    expect(nullErr).toBeInstanceOf(UpstreamFormatError);
    expect((nullErr as Error).message).toBe('Example returned null where a JSON object was expected for GET /a (HTTP 200, application/json).');

    const emptyErr = await client(new Response('', { status: 200 }))
      .fetchJson('GET', '/a', { expect: 'array' })
      .catch((e: unknown) => e);
    expect((emptyErr as UpstreamFormatError).received).toBe('empty');

    const noContent = await client(new Response(null, { status: 204 }))
      .fetchJson('GET', '/a', { expect: 'object' })
      .catch((e: unknown) => e);
    expect(noContent).toBeInstanceOf(UpstreamFormatError);
    expect((noContent as UpstreamFormatError).status).toBe(204);

    await expect(
      client(new Response('[{"id":1}]', { status: 200 })).fetchJson('GET', '/a', { expect: 'array' }),
    ).resolves.toEqual([{ id: 1 }]);
  });

  it('does not send expect upstream', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: 'https://x.test', getToken: () => 't', fetchImpl });
    await api.fetchJson('GET', '/a', { expect: 'object' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.test/a');
    expect(init.body).toBeUndefined();
  });
});
