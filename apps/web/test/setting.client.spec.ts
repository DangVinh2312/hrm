import { describe, expect, it, vi } from 'vitest';
import { createMeClient } from '../src/features/auth/me.client';
import { createSettingClient } from '../src/features/setting/setting.client';
import { ResponseShapeError, createHttpClient } from '../src/infrastructure/http.client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function http(answer: (path: string) => Response) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      path,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(answer(path));
  });
  return { client: createHttpClient(fetchImpl), calls };
}

const wfh = {
  key: 'hr.wfhMonthLimit',
  group: 'rule',
  kind: 'int',
  unit: 'days',
  value: 4,
  default: 4,
  min: 0,
  max: 31,
  version: '0',
  isDefault: true,
  updatedAt: null,
};
const locale = {
  key: 'company.defaultLocale',
  group: 'profile',
  kind: 'enum',
  values: ['vi', 'en'],
  value: 'vi',
  default: 'vi',
  version: '0',
  isDefault: true,
  updatedAt: null,
};

describe('setting client', () => {
  it('reads the list with the groups the caller may update', async () => {
    const body = { settings: [wfh, locale], canUpdate: { rule: true, profile: false } };
    const { client, calls } = http(() => json(body));
    await expect(createSettingClient(client).list()).resolves.toEqual(body);
    expect(calls[0]?.path).toBe('/api/administration/settings');
  });

  it('maps update to the route of the key group, sending value and the version that was shown', async () => {
    const { client, calls } = http((path) =>
      path === '/api/auth/csrf' ? json({ csrfToken: 't' }) : json({ version: '2' }),
    );
    const settings = createSettingClient(client);
    await settings.update('rule', 'hr.wfhMonthLimit', 6, '1');
    await settings.update('profile', 'company.name', 'Công ty Giả', '0');
    expect(calls.filter((c) => c.path !== '/api/auth/csrf')).toEqual([
      {
        path: '/api/administration/settings/rule/hr.wfhMonthLimit',
        method: 'PUT',
        body: { value: 6, expectedVersion: '1' },
      },
      {
        path: '/api/administration/settings/profile/company.name',
        method: 'PUT',
        body: { value: 'Công ty Giả', expectedVersion: '0' },
      },
    ]);
  });

  it('pages the history of a key and reads the profile and the security view', async () => {
    const { client, calls } = http((path) =>
      path.endsWith('/profile')
        ? json({ companyName: 'Công ty Giả', defaultLocale: 'en' })
        : path.endsWith('/security')
          ? json({
              freshAuthenticationSeconds: 300,
              sessionHours: 12,
              rateLimitWindowMinutes: 15,
              oidcAttemptMinutes: 5,
              idleMinutes: 30,
            })
          : json({
              items: [
                { version: '1', oldValue: 4, newValue: 6, changedAt: '2026-11-02T02:00:00Z' },
              ],
              total: '11',
            }),
    );
    const settings = createSettingClient(client);
    await expect(settings.profile()).resolves.toEqual({
      companyName: 'Công ty Giả',
      defaultLocale: 'en',
    });
    expect((await settings.security()).sessionHours).toBe(12);
    expect((await settings.history('hr.wfhMonthLimit', 2)).total).toBe('11');
    expect(calls.map((c) => c.path)).toEqual([
      '/api/administration/settings/profile',
      '/api/administration/settings/security',
      '/api/administration/settings/hr.wfhMonthLimit/history?limit=10&offset=10',
    ]);
  });

  it('rejects a broken contract: unknown kind, missing bounds, a version that is not a decimal', async () => {
    const list = (body: unknown) => createSettingClient(http(() => json(body)).client).list();

    const canUpdate = { rule: true, profile: true };
    await expect(list({ settings: [{ ...wfh, kind: 'blob' }], canUpdate })).rejects.toBeInstanceOf(
      ResponseShapeError,
    );
    await expect(
      list({ settings: [{ ...wfh, min: undefined }], canUpdate }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(list({ settings: [{ ...wfh, version: 'x' }], canUpdate })).rejects.toBeInstanceOf(
      ResponseShapeError,
    );
    await expect(list({ settings: [wfh] })).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('the menu schema accepts settings', async () => {
    const userId = '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11';
    const { client } = http(() => json({ userId, menus: ['accounts', 'settings'] }));
    await expect(createMeClient(client).me()).resolves.toEqual({
      userId,
      menus: ['accounts', 'settings'],
    });
  });
});
