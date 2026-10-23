import { expect, test } from 'vitest';
import { accessConfigFromEnv } from './verify.ts';

test.each([
  {},
  { ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com' },
  { ACCESS_AUD: 'web-app' },
  { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: 'web-app' },
  {
    ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    ACCESS_AUD: '',
  },
])('leaves Access unconfigured for incomplete vars %j', vars => {
  expect(accessConfigFromEnv(vars as Env)).toBeUndefined();
});

test.each([
  'https://example.cloudflareaccess.com',
  'https://example.cloudflareaccess.com/',
])(
  'builds a usable issuer and audience from %s without fetching JWKS',
  domain => {
    const config = accessConfigFromEnv({
      ACCESS_TEAM_DOMAIN: domain,
      ACCESS_AUD: 'web-app',
    } as Env);
    expect(config).toMatchObject({
      issuer: 'https://example.cloudflareaccess.com',
      audience: 'web-app',
    });
  },
);
