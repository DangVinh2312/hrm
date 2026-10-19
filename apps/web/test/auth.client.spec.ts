import { describe, expect, it, vi } from 'vitest';
import { createAuthClient } from '../src/auth/auth.client';
import { readWebConfig } from '../src/app/app.config';
import { ResponseShapeError, createHttpClient } from '../src/infrastructure/http.client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const issuer = 'https://accounts.google.com';

function client(answer: (path: string, body: unknown) => Response) {
  const fetchImpl = vi.fn<typeof fetch>((path, init) =>
    Promise.resolve(
      path === '/api/auth/csrf'
        ? json({ csrfToken: 't' })
        : answer(
            typeof path === 'string' ? path : path instanceof URL ? path.href : path.url,
            typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
          ),
    ),
  );
  return { auth: createAuthClient(createHttpClient(fetchImpl), issuer), fetchImpl };
}

describe('auth client', () => {
  it('maps 401 on /api/auth/session to signed out and propagates other failures', async () => {
    await expect(client(() => json({}, 401)).auth.session()).resolves.toBeNull();
    await expect(client(() => json({}, 503)).auth.session()).rejects.toMatchObject({
      status: 503,
    });
    const userId = '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11';
    await expect(
      client(() => json({ userId, method: 'oidc', assurance: 'oidc' })).auth.session(),
    ).resolves.toEqual({ userId, method: 'oidc', assurance: 'oidc' });
  });

  it('starts login and activation with the configured issuer only', async () => {
    const seen: unknown[] = [];
    const { auth } = client((path, body) => {
      seen.push([path, body]);
      return json({ authorizationUrl: 'https://accounts.google.com/auth?state=x' });
    });
    await auth.beginLogin();
    await auth.beginActivation('a'.repeat(43));
    expect(seen).toEqual([
      ['/api/auth/oidc/begin', { issuer }],
      ['/api/auth/oidc/activate', { issuer, token: 'a'.repeat(43) }],
    ]);
  });

  it('refuses to follow a non-HTTPS authorization URL', async () => {
    for (const authorizationUrl of ['http://idp.test/auth', 'javascript:alert(1)', '/relative'])
      await expect(
        client(() => json({ authorizationUrl })).auth.beginLogin(),
      ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('treats logout of an already ended session as done', async () => {
    await expect(client(() => json({}, 401)).auth.logout()).resolves.toBeUndefined();
    await expect(client(() => json({}, 503)).auth.logout()).rejects.toMatchObject({ status: 503 });
  });
});

describe('web config', () => {
  it('requires a fixed HTTPS issuer', () => {
    expect(readWebConfig({ VITE_OIDC_ISSUER: issuer })).toEqual({ oidcIssuer: issuer });
    for (const value of [
      undefined,
      '',
      'http://accounts.google.com',
      `${issuer}?x=1`,
      `${issuer}#f`,
    ])
      expect(() => readWebConfig({ VITE_OIDC_ISSUER: value })).toThrow();
  });
});
