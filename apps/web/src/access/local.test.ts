import { apiErrorSchema } from '@pdf-generator/contract';
import { generateKeyPair, SignJWT } from 'jose';
import { expect, test, vi } from 'vitest';
import { createFetchHandler } from '../worker.ts';
import { createLocalAccess, localServiceToken } from './local.ts';

const origin = 'https://web.example.test';
const env = {} as Env;

function setup() {
  const local = createLocalAccess();
  const pages = vi.fn(async (_request: Request) => new Response('home page'));
  return {
    local,
    pages,
    fetch: createFetchHandler({
      pages,
      access: () => local.config,
      edge: local.edge,
    }),
  };
}

function request(path: string, init?: RequestInit) {
  return new Request(new URL(path, origin), init);
}

async function expectUnauthenticated(response: Response) {
  expect(response.status).toBe(401);
  expect(response.headers.get('content-type')).toMatch(/^application\/json\b/i);
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
    'unauthenticated',
  );
}

test('authenticates a Mac script using the local service token headers through the gate', async () => {
  const { fetch, pages } = setup();
  const response = await fetch(
    request('/api/me', {
      headers: {
        'CF-Access-Client-Id': localServiceToken.clientId,
        'CF-Access-Client-Secret': localServiceToken.clientSecret,
      },
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    identity: { kind: 'service', clientId: 'local-dev.access' },
  });
  expect(pages).not.toHaveBeenCalled();
});

test.each([
  ['missing', undefined, undefined],
  ['wrong id', 'another.access', localServiceToken.clientSecret],
  ['wrong secret', localServiceToken.clientId, 'incorrect'],
  ['missing secret', localServiceToken.clientId, undefined],
])('refuses %s local service credentials', async (_label, id, secret) => {
  const { fetch, pages } = setup();
  const headers = new Headers();
  if (id !== undefined) headers.set('CF-Access-Client-Id', id);
  if (secret !== undefined) headers.set('CF-Access-Client-Secret', secret);
  await expectUnauthenticated(
    await fetch(request('/api/me', { headers }), env),
  );
  expect(pages).not.toHaveBeenCalled();
});

test('serves the local login form before authentication without invoking TanStack', async () => {
  const { fetch, pages } = setup();
  const response = await fetch(request('/__access/login'), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/html\b/i);
  const html = await response.text();
  expect(html).toMatch(/<form\b/i);
  expect(html).toMatch(/name\s*=\s*["']email["']/i);
  expect(pages).not.toHaveBeenCalled();
});

test('signs in with a cookie, reaches home as a user, and clears that cookie on logout', async () => {
  const { fetch, pages } = setup();
  const email = 'local-reader@example.test';
  const login = await fetch(
    request('/__access/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }).toString(),
    }),
    env,
  );
  expect(login.status).toBe(303);
  expect(login.headers.get('location')).toBe('/');
  const setCookie = login.headers.get('set-cookie') ?? '';
  expect(setCookie).toMatch(/CF_Authorization=[^;]+/);
  expect(setCookie).toMatch(/;\s*HttpOnly\b/i);
  expect(setCookie).toMatch(/;\s*Path=\/(?:;|$)/i);
  const cookie = setCookie.split(';')[0] ?? '';
  const me = await fetch(request('/api/me', { headers: { cookie } }), env);
  expect(me.status).toBe(200);
  expect(await me.json()).toEqual({ identity: { kind: 'user', email } });
  const home = await fetch(request('/', { headers: { cookie } }), env);
  expect(await home.text()).toBe('home page');
  expect(pages).toHaveBeenCalledTimes(1);
  const logout = await fetch(
    request('/__access/logout', { headers: { cookie } }),
    env,
  );
  expect(logout.status).toBeGreaterThanOrEqual(300);
  expect(logout.status).toBeLessThan(400);
  expect(logout.headers.get('location')).toBe('/');
  const cleared = logout.headers.get('set-cookie') ?? '';
  expect(cleared).toMatch(/CF_Authorization=/);
  expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  await expectUnauthenticated(
    await fetch(
      request('/api/me', { headers: { cookie: cleared.split(';')[0] ?? '' } }),
      env,
    ),
  );
  expect(pages).toHaveBeenCalledTimes(1);
});

test.each(['assertion', 'cookie'])(
  'rejects a JWT signed outside the local edge from the %s',
  async source => {
    const { local, fetch, pages } = setup();
    const { privateKey } = await generateKeyPair('RS256');
    const jwt = await new SignJWT({ email: 'forged@example.test' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(local.config.issuer)
      .setAudience([local.config.audience])
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const headers = new Headers();
    headers.set(
      source === 'assertion' ? 'Cf-Access-Jwt-Assertion' : 'cookie',
      source === 'assertion' ? jwt : `CF_Authorization=${jwt}`,
    );
    await expectUnauthenticated(
      await fetch(request('/api/me', { headers }), env),
    );
    expect(pages).not.toHaveBeenCalled();
  },
);
