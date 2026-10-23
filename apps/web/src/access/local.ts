// Local stand-in for the Cloudflare Access edge, used only by `vite dev`
// (server.ts loads it behind import.meta.env.DEV, so production builds drop
// it). It signs Access-shaped JWTs with a key pair made at startup, so the
// Worker's real verification runs unchanged. Not a security boundary: anyone
// who can reach the dev server can sign in.
import { generateKeyPair, SignJWT } from 'jose';
import { type AccessConfig, accessJwtHeader } from './verify.ts';

/** The service token the local edge accepts. Dev only. */
export const localServiceToken = {
  clientId: 'local-dev.access',
  clientSecret: 'local-dev-secret',
} as const;

export interface LocalAccess {
  config: AccessConfig;
  /**
   * Plays the Access edge for one request: answers its own login pages, or
   * returns the request with `Cf-Access-Jwt-Assertion` set when it carries a
   * valid credential.
   */
  edge(request: Request): Promise<Request | Response>;
}

const cookieName = 'CF_Authorization';
const loginPath = '/__access/login';
const logoutPath = '/__access/logout';

export function createLocalAccess(): LocalAccess {
  const issuer = 'https://access.localhost';
  const audience = 'pdf-generator-web-local';
  const keyPair = generateKeyPair('RS256');

  const sign = async (claims: Record<string, string>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setAudience([audience])
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign((await keyPair).privateKey);

  const withJwt = (request: Request, jwt: string) => {
    const headers = new Headers(request.headers);
    headers.set(accessJwtHeader, jwt);
    return new Request(request, { headers });
  };

  return {
    config: {
      issuer,
      audience,
      keys: async () => (await keyPair).publicKey,
    },

    async edge(request) {
      const { pathname } = new URL(request.url);
      if (pathname === loginPath) {
        if (request.method !== 'POST') return html(loginPage);
        const email = (await request.formData()).get('email');
        if (typeof email !== 'string' || !email.includes('@')) {
          return html(loginPage, 400);
        }
        const jwt = await sign({ email, sub: email, type: 'app' });
        return redirect(
          `${cookieName}=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/`,
        );
      }
      if (pathname === logoutPath) {
        return redirect(
          `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
        );
      }

      const id = request.headers.get('CF-Access-Client-Id');
      const secret = request.headers.get('CF-Access-Client-Secret');
      if (id !== null || secret !== null) {
        // Like the real edge: a service token is used only when it matches.
        if (
          id !== localServiceToken.clientId ||
          secret !== localServiceToken.clientSecret
        ) {
          return request;
        }
        return withJwt(request, await sign({ common_name: id, sub: '' }));
      }

      const cookie = readCookie(request.headers.get('cookie'), cookieName);
      if (cookie && !request.headers.has(accessJwtHeader)) {
        return withJwt(request, cookie);
      }
      return request;
    },
  };
}

function readCookie(header: string | null, name: string) {
  for (const part of header?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

function redirect(cookie: string) {
  return new Response(null, {
    status: 303,
    headers: { location: '/', 'set-cookie': cookie },
  });
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const loginPage = `<!doctype html>
<html lang="zh-Hant-TW">
<head><meta charset="utf-8"><title>本機登入（Access 替身）</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto">
  <h1>本機登入</h1>
  <p>這是開發用的 Cloudflare Access 替身，只在 <code>vite dev</code> 出現。</p>
  <form method="post" action="${loginPath}">
    <label>Email <input type="email" name="email" required value="dev@example.com"></label>
    <button type="submit">登入</button>
  </form>
</body>
</html>`;
