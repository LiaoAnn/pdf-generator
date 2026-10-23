// Cloudflare Access: who is calling. In production the Access edge
// authenticates users and service tokens and forwards a signed JWT in
// `Cf-Access-Jwt-Assertion`; the Worker verifies that JWT itself as well, so
// a request that bypasses Access (or a misconfigured policy) is still refused.
import { Data, Effect } from 'effect';
import {
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';

/** Settings of one Access application. */
export interface AccessConfig {
  /** The team domain, e.g. `https://example.cloudflareaccess.com`. */
  issuer: string;
  /** The application's AUD tag. */
  audience: string;
  /** Resolves the key a JWT was signed with (the team's JWKS). */
  keys: JWTVerifyGetKey;
}

/** A verified caller: a person signed in to Access, or a service token. */
export type Identity =
  | { kind: 'user'; email: string }
  | { kind: 'service'; clientId: string };

/** The request carries no valid Access JWT. */
class Unauthenticated extends Data.TaggedError('Unauthenticated')<{
  reason: string;
}> {}

export const accessJwtHeader = 'Cf-Access-Jwt-Assertion';

const remoteKeys = new Map<string, JWTVerifyGetKey>();

/** Access settings from the Worker's vars; undefined until configured. */
export function accessConfigFromEnv(env: Env): AccessConfig | undefined {
  const issuer = env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '');
  const audience = env.ACCESS_AUD;
  if (!issuer || !audience) return undefined;
  let keys = remoteKeys.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteKeys.set(issuer, keys);
  }
  return { issuer, audience, keys };
}

/** Verifies the request's Access JWT and says who sent it. */
export const authenticate = Effect.fn('authenticate')(function* (
  request: Request,
  config: AccessConfig,
) {
  const token = request.headers.get(accessJwtHeader);
  if (!token) {
    return yield* new Unauthenticated({ reason: 'no Access JWT' });
  }
  const { payload } = yield* Effect.tryPromise({
    try: () =>
      jwtVerify(token, config.keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
      }),
    catch: error =>
      new Unauthenticated({ reason: `invalid Access JWT: ${String(error)}` }),
  });
  return yield* identityOf(payload);
});

function identityOf(payload: JWTPayload) {
  if (typeof payload.email === 'string' && payload.email !== '') {
    return Effect.succeed<Identity>({ kind: 'user', email: payload.email });
  }
  // Service-token JWTs carry the token's client ID instead of an email.
  if (typeof payload.common_name === 'string' && payload.common_name !== '') {
    return Effect.succeed<Identity>({
      kind: 'service',
      clientId: payload.common_name,
    });
  }
  return Effect.fail(
    new Unauthenticated({ reason: 'Access JWT names no user or service' }),
  );
}
