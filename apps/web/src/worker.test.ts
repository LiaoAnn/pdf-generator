import { apiErrorSchema } from '@pdf-generator/contract';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
} from 'jose';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { AccessConfig } from './access/verify.ts';
import { createFetchHandler } from './worker.ts';

const origin = 'https://web.example.test';
const env = {} as Env;
const issuer = 'https://example.cloudflareaccess.com';
const audience = 'web-app-aud';
let config: AccessConfig;
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let pssPrivateKey: CryptoKey | Uint8Array;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  pssPrivateKey = await importJWK(await exportJWK(pair.privateKey), 'PS256');
  otherKey = (await generateKeyPair('RS256')).privateKey;
  config = {
    issuer,
    audience,
    keys: createLocalJWKSet({ keys: [await exportJWK(pair.publicKey)] }),
  };
});

async function token(
  claims: Record<string, unknown> = { email: 'reader@example.test' },
  key: CryptoKey | Uint8Array = privateKey,
  algorithm = 'RS256',
) {
  return new SignJWT({ iss: issuer, aud: [audience], ...claims })
    .setProtectedHeader({ alg: algorithm })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

function request(path: string, jwt?: string, method = 'GET') {
  return new Request(new URL(path, origin), {
    method,
    headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : undefined,
  });
}

function setup(access: () => AccessConfig | undefined = () => config) {
  const pages = vi.fn(
    async (_request: Request) => new Response('TanStack page'),
  );
  return { pages, fetch: createFetchHandler({ pages, access }) };
}

async function expectApiError(
  response: Response,
  status: number,
  code: string,
) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toMatch(/^application\/json\b/i);
  const body: unknown = await response.json();
  expect(apiErrorSchema.parse(body).error.code).toBe(code);
}

async function expectHtmlError(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect.soft(response.headers.get('content-type')).toMatch(/^text\/html\b/i);
  expect(await response.text()).toMatch(/<[^>]+>/);
}

describe('Access gate at the Worker request boundary', () => {
  test.each(['/api/me', '/api/templates'])(
    'blocks anonymous %s with a contract API error before pages',
    async path => {
      const { fetch, pages } = setup();
      await expectApiError(
        await fetch(request(path), env),
        401,
        'unauthenticated',
      );
      expect(pages).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['GET', '/'],
    ['GET', '/other'],
    ['GET', '/health/details'],
    ['GET', '/healthcheck'],
    ['GET', '/health/'],
    ['POST', '/health'],
  ])('blocks anonymous %s %s with HTML before pages', async (method, path) => {
    const { fetch, pages } = setup();
    await expectHtmlError(
      await fetch(request(path, undefined, method), env),
      401,
    );
    expect(pages).not.toHaveBeenCalled();
  });

  test('keeps GET /health public when Access is absent, without calling edge or pages', async () => {
    const { pages } = setup();
    const edge = vi.fn(async (input: Request) => input);
    const fetch = createFetchHandler({ pages, access: () => undefined, edge });
    const response = await fetch(request('/health'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(
      /^application\/json\b/i,
    );
    expect(await response.json()).toEqual({ status: 'ok', service: 'web' });
    expect(pages).not.toHaveBeenCalled();
    expect(edge).not.toHaveBeenCalled();
  });

  test.each(['/api/me', '/'])(
    'fails closed with 503 on %s when Access is not configured, even with a signed JWT',
    async path => {
      const { fetch, pages } = setup(() => undefined);
      const response = await fetch(request(path, await token()), env);
      if (path.startsWith('/api/')) {
        await expectApiError(response, 503, 'access_not_configured');
      } else {
        await expectHtmlError(response, 503);
      }
      expect(pages).not.toHaveBeenCalled();
    },
  );

  test.each([
    {
      claims: { email: 'reader@example.test' },
      identity: { kind: 'user', email: 'reader@example.test' },
    },
    {
      claims: { common_name: 'mac-script.access' },
      identity: { kind: 'service', clientId: 'mac-script.access' },
    },
  ])(
    'returns the verified $identity.kind identity from GET /api/me',
    async ({ claims, identity }) => {
      const { fetch, pages } = setup();
      const response = await fetch(
        request('/api/me', await token(claims)),
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(
        /^application\/json\b/i,
      );
      expect(await response.json()).toEqual({ identity });
      expect(pages).not.toHaveBeenCalled();
    },
  );

  test.each(['/api/unknown', '/api/me/details'])(
    'returns a contract 404 for authenticated unknown API %s without invoking pages',
    async path => {
      const { fetch, pages } = setup();
      await expectApiError(
        await fetch(request(path, await token()), env),
        404,
        'not_found',
      );
      expect(pages).not.toHaveBeenCalled();
    },
  );

  test('preserves authenticated page requests and the exact TanStack response', async () => {
    const { fetch, pages } = setup();
    const jwt = await token();
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/other'],
      ['POST', '/health'],
    ] as const) {
      const input = request(path, jwt, method);
      const page = new Response('TanStack response', {
        status: 207,
        headers: { 'x-page-handler': 'preserved' },
      });
      pages.mockClear();
      pages.mockResolvedValue(page);
      expect(await fetch(input, env)).toBe(page);
      expect(pages).toHaveBeenCalledExactlyOnceWith(input);
    }
  });

  test.each([
    'expired',
    'other key',
    'wrong issuer',
    'wrong audience',
    'PS256',
    'none',
    'malformed',
  ])('rejects a %s JWT on API and page requests', async invalid => {
    let jwt: string;
    switch (invalid) {
      case 'expired':
        jwt = await new SignJWT({ email: 'reader@example.test' })
          .setProtectedHeader({ alg: 'RS256' })
          .setIssuer(issuer)
          .setAudience([audience])
          .setIssuedAt(1)
          .setExpirationTime(2)
          .sign(privateKey);
        break;
      case 'other key':
        jwt = await token(undefined, otherKey);
        break;
      case 'wrong issuer':
        jwt = await token({
          email: 'reader@example.test',
          iss: 'https://other.cloudflareaccess.com',
        });
        break;
      case 'wrong audience':
        jwt = await token({ email: 'reader@example.test', aud: ['other-app'] });
        break;
      case 'PS256': {
        jwt = await token(undefined, pssPrivateKey, 'PS256');
        break;
      }
      case 'none': {
        const payload = {
          iss: issuer,
          aud: [audience],
          email: 'reader@example.test',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
        };
        jwt = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
        break;
      }
      default:
        jwt = 'not.a.valid-jwt';
    }
    const { fetch, pages } = setup();
    await expectApiError(
      await fetch(request('/api/me', jwt), env),
      401,
      'unauthenticated',
    );
    await expectHtmlError(await fetch(request('/', jwt), env), 401);
    expect(pages).not.toHaveBeenCalled();
  });

  test('verifies the request returned by edge before resolving the API identity', async () => {
    const { pages } = setup();
    const jwt = await token({ common_name: 'edge-issued.access' });
    const fetch = createFetchHandler({
      pages,
      access: () => config,
      edge: async input => {
        const forwarded = new Request(input);
        forwarded.headers.set('Cf-Access-Jwt-Assertion', jwt);
        return forwarded;
      },
    });
    const response = await fetch(request('/api/me'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(
      /^application\/json\b/i,
    );
    expect(await response.json()).toEqual({
      identity: { kind: 'service', clientId: 'edge-issued.access' },
    });
    expect(pages).not.toHaveBeenCalled();
  });

  test('returns an edge response unchanged instead of passing a local login to pages', async () => {
    const { pages } = setup();
    const response = new Response('local login', {
      status: 303,
      headers: { location: '/' },
    });
    const fetch = createFetchHandler({
      pages,
      access: () => undefined,
      edge: async () => response,
    });
    expect(
      await fetch(request('/__access/login', undefined, 'POST'), env),
    ).toBe(response);
    expect(pages).not.toHaveBeenCalled();
  });
});
