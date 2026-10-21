import { describe, expect, it, vi } from 'vitest';
import { createAccountClient } from '../src/features/account/account.client';
import { ResponseShapeError, createHttpClient } from '../src/infrastructure/http.client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const issuer = 'https://accounts.google.com';
const reference = '0b6f2d1e-8c4a-4f7b-9d3e-2a5c7e9f1b40';

function client(answer: (path: string, method: string, body: unknown) => Response) {
  const fetchImpl = vi.fn<typeof fetch>((path, init) =>
    Promise.resolve(
      path === '/api/auth/csrf'
        ? json({ csrfToken: 't' })
        : answer(
            typeof path === 'string' ? path : path instanceof URL ? path.href : path.url,
            init?.method ?? 'GET',
            typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
          ),
    ),
  );
  return createAccountClient(createHttpClient(fetchImpl));
}

describe('account client', () => {
  it('reads the own account and rejects a body that breaks the contract', async () => {
    const identities = [{ issuer, reference }];
    const mfa = { status: 'enabled', recoveryCodesRemaining: 9 };
    await expect(
      client(() => json({ email: 'a@example.test', identities, mfa })).account(),
    ).resolves.toEqual({ email: 'a@example.test', identities, mfa });
    const none = { status: 'none', recoveryCodesRemaining: 0 };
    for (const bad of [
      {
        email: null,
        identities: [{ issuer, reference: 'x' }],
        mfa: none,
      },
      {
        email: null,
        identities: [{ issuer, subject: 's' }],
        mfa: none,
      },
      { email: null, mfa: none },
      { email: null, identities: [] },
      {
        email: null,
        identities: [],
        mfa: { status: 'on', recoveryCodesRemaining: 0 },
      },
      {
        email: null,
        identities: [],
        mfa: { status: 'none', recoveryCodesRemaining: 11 },
      },
      {
        email: null,
        identities: [],
        mfa: { ...none, secret: 'JBSWY3DPEHPK3PXP' },
      },
      {
        email: null,
        identities: Array.from({ length: 17 }, () => ({ issuer, reference })),
        mfa: none,
      },
    ])
      await expect(client(() => json(bad)).account()).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('second factor: exact routes and bodies, and only well-formed secrets and codes', async () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const uri = `otpauth://totp/HRM:a%40example.test?secret=${secret}&issuer=HRM&algorithm=SHA1&digits=6&period=30`;
    const codes = Array.from({ length: 10 }, (_, i) => `ABCD-EFGH-IJKL-MNO${'ABCDEFGHIJ'[i]}`);
    const seen: unknown[] = [];
    const account = client((path, method, body) => {
      seen.push([method, path, body]);
      if (path === '/api/auth/mfa/totp/setup') return json({ uri, secret });
      if (path === '/api/auth/mfa/totp/confirm')
        return json({ expiresAt: '2026-10-18T09:05:00.000Z', recoveryCodes: codes });
      if (path === '/api/auth/mfa/recovery-codes') return json({ recoveryCodes: codes });
      return json({ expiresAt: '2026-10-18T09:05:00.000Z' });
    });
    await expect(account.setupMfa()).resolves.toEqual({ uri, secret });
    await expect(account.confirmMfa('123456')).resolves.toEqual(codes);
    await account.verifyMfa({ code: '654321' });
    await account.verifyMfa({ recoveryCode: 'abcd-efgh-ijkl-mnop' });
    await expect(account.regenerateRecoveryCodes()).resolves.toEqual(codes);
    await account.removeMfa();
    expect(seen).toEqual([
      ['POST', '/api/auth/mfa/totp/setup', undefined],
      ['POST', '/api/auth/mfa/totp/confirm', { code: '123456' }],
      ['POST', '/api/auth/mfa/verify', { code: '654321' }],
      ['POST', '/api/auth/mfa/verify', { recoveryCode: 'abcd-efgh-ijkl-mnop' }],
      ['POST', '/api/auth/mfa/recovery-codes', undefined],
      ['DELETE', '/api/auth/mfa/totp', undefined],
    ]);
    for (const bad of [
      { uri: uri.replace('otpauth://totp/', 'https://evil.test/'), secret },
      { uri: uri.replace(secret, 'OTHERSECRETOTHERSECRETOTHERSECRE'), secret },
      { uri, secret: 'not base32!' },
    ])
      await expect(client(() => json(bad)).setupMfa()).rejects.toBeInstanceOf(ResponseShapeError);
    for (const bad of [
      codes.slice(1),
      [...codes.slice(1), 'not-a-code'],
      [...codes.slice(1), codes[1]],
    ])
      await expect(
        client(() => json({ recoveryCodes: bad })).regenerateRecoveryCodes(),
      ).rejects.toBeInstanceOf(ResponseShapeError);
  });
});
