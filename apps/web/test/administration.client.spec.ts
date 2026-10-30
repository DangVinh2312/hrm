import { describe, expect, it, vi } from 'vitest';
import { createAdministrationClient } from '../src/features/administration/administration.client';
import { createMeClient } from '../src/features/auth/me.client';
import { ResponseShapeError, createHttpClient } from '../src/infrastructure/http.client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const id = '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f';
const account = { userId: id, email: 'an@example.test', state: 'suspended', enrollment: null };

function http(answer: (path: string, init?: RequestInit) => Response) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      path,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(answer(path, init));
  });
  return { client: createHttpClient(fetchImpl), calls };
}

describe('administration client', () => {
  it('lists one bounded page of accounts', async () => {
    const { client, calls } = http(() => json({ items: [account], total: '41' }));
    await expect(createAdministrationClient(client).list({ page: 3 })).resolves.toEqual({
      items: [account],
      total: '41',
    });
    expect(calls[0]?.path).toBe('/api/administration/accounts?limit=20&offset=40');
  });

  it('provisions by email and maps suspend and reactivate to their routes', async () => {
    const { client, calls } = http((path) =>
      path === '/api/auth/csrf'
        ? json({ csrfToken: 't' })
        : path.endsWith('/accounts')
          ? json({ userId: id, email: 'an@example.test', state: 'pending' }, 201)
          : json({ status: 'ok' }),
    );
    const admin = createAdministrationClient(client);
    await admin.provision('an@example.test');
    await admin.suspend(id);
    await admin.reactivate(id);
    expect(calls.filter((c) => c.path !== '/api/auth/csrf').map((c) => [c.method, c.path])).toEqual(
      [
        ['POST', '/api/administration/accounts'],
        ['POST', `/api/administration/users/${id}/suspend`],
        ['POST', `/api/administration/users/${id}/reactivate`],
      ],
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ email: 'an@example.test' });
  });

  it('rejects a broken contract and an unknown state', async () => {
    const admin = (body: unknown) => createAdministrationClient(http(() => json(body)).client);

    await expect(
      admin({ items: [{ ...account, state: 'gone' }], total: '1' }).list({ page: 1 }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(admin({ items: [] }).list({ page: 1 })).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('the menu schema accepts accounts', async () => {
    const userId = '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11';
    const { client } = http(() => json({ userId, menus: ['reports', 'accounts'] }));
    await expect(createMeClient(client).me()).resolves.toEqual({
      userId,
      menus: ['reports', 'accounts'],
    });
  });

  it('reads the role matrix and the permissions of one account from their routes', async () => {
    const grant = {
      permission: 'employee.read',
      effect: 'allow',
      template: 'allEmployees',
      version: 1,
      parameters: {},
    };
    const matrix = {
      roles: [
        {
          key: 'hr.admin',
          label: 'Admin',
          source: 'code',
          holders: 2,
          digest: 'a'.repeat(64),
          capabilities: ['selfApproval', 'accountLink'],
          grants: [grant],
        },
      ],
      catalog: [{ permission: 'employee.read', template: { key: 'allEmployees', version: 1 } }],
      truncated: false,
    };
    const detail = {
      roles: [{ key: 'hr.admin', label: 'Admin', source: 'code' }],
      grants: [{ ...grant, source: 'role' }],
      boundaries: [
        { permission: 'account.suspend', key: 'accountAdministration', version: 1, seeded: false },
      ],
      truncated: true,
    };
    const { client, calls } = http((path) => json(path.endsWith('/roles') ? matrix : detail));
    const admin = createAdministrationClient(client);
    await expect(admin.roles()).resolves.toEqual(matrix);
    await expect(admin.accountPermissions(id)).resolves.toEqual(detail);
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/api/administration/roles'],
      ['GET', `/api/administration/accounts/${id}/permissions`],
    ]);
  });

  it('rejects a role matrix with an unknown source, effect or a missing field', async () => {
    const admin = (body: unknown) => createAdministrationClient(http(() => json(body)).client);

    const role = {
      key: 'hr.admin',
      label: 'Admin',
      source: 'code',
      holders: 0,
      digest: 'a'.repeat(64),
      capabilities: [],
      grants: [],
    };
    const catalog: unknown[] = [];
    const full = { roles: [role], catalog, truncated: false };
    await expect(
      admin({ ...full, roles: [{ ...role, source: 'system' }] }).roles(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(
      admin({ ...full, roles: [{ ...role, holders: -1 }] }).roles(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    // `truncated` is required: an answer that cannot say whether it was cut is refused.
    await expect(admin({ roles: [role], catalog }).roles()).rejects.toBeInstanceOf(
      ResponseShapeError,
    );
    await expect(
      admin({
        ...full,
        roles: [
          {
            ...role,
            grants: [
              {
                permission: 'a.b',
                effect: 'maybe',
                template: 't',
                version: 1,
                parameters: {},
              },
            ],
          },
        ],
      }).roles(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    // `digest`, `capabilities` and `catalog` are required: the form cannot be built without them.
    const noDigest = { ...role, digest: undefined };
    const noCapabilities = { ...role, capabilities: undefined };
    await expect(admin({ ...full, roles: [noDigest] }).roles()).rejects.toBeInstanceOf(
      ResponseShapeError,
    );
    await expect(admin({ ...full, roles: [noCapabilities] }).roles()).rejects.toBeInstanceOf(
      ResponseShapeError,
    );
    await expect(
      admin({ ...full, roles: [{ ...role, digest: 'abc' }] }).roles(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(
      admin({ ...full, roles: [{ ...role, capabilities: ['superuser'] }] }).roles(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(admin({ roles: [role], truncated: false }).roles()).rejects.toBeInstanceOf(
      ResponseShapeError,
    );
    await expect(
      admin({
        ...full,
        catalog: [{ permission: 'a.b', template: { key: 't', version: 0 } }],
      }).roles(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(admin({}).accountPermissions(id)).rejects.toBeInstanceOf(ResponseShapeError);
    const detail = { roles: [], grants: [], truncated: false };
    // `boundaries` is required: an answer that cannot say what the account is bound to is refused.
    await expect(admin(detail).accountPermissions(id)).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(
      admin({
        ...detail,
        boundaries: [{ permission: 'account.suspend', key: 'b', version: 0, seeded: false }],
      }).accountPermissions(id),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('maps role and boundary writes to their routes and bodies', async () => {
    const { client, calls } = http((path, init) => {
      if (path === '/api/auth/csrf') return json({ csrfToken: 't' });
      const written =
        (init?.method === 'POST' && path === '/api/administration/roles') || init?.method === 'PUT';
      return json(written ? { key: 'custom.helper', digest: 'c'.repeat(64) } : { status: 'ok' });
    });
    const admin = createAdministrationClient(client);
    await admin.assignRole(id, 'hr.admin');
    await admin.revokeRole(id, 'custom.helper');
    await admin.bindBoundary(id, { key: 'accountAdministration', version: 1 });
    await admin.unbindBoundary(id, { key: 'accountAdministration', version: 1 });
    await admin.deleteRole('custom.helper');
    const grants = [{ permission: 'employee.read', template: { key: 'allEmployees', version: 1 } }];
    const written = { key: 'custom.helper', digest: 'c'.repeat(64) };
    await expect(
      admin.createRole({ key: 'custom.helper', label: 'Helper', grants }),
    ).resolves.toEqual(written);
    await expect(
      admin.updateRole('custom.helper', {
        label: 'Helper',
        grants,
        expectedDigest: 'a'.repeat(64),
      }),
    ).resolves.toEqual(written);
    expect(
      calls.filter((c) => c.path !== '/api/auth/csrf').map((c) => [c.method, c.path, c.body]),
    ).toEqual([
      ['POST', `/api/administration/accounts/${id}/roles`, { roleKey: 'hr.admin' }],
      ['DELETE', `/api/administration/accounts/${id}/roles/custom.helper`, undefined],
      [
        'POST',
        `/api/administration/accounts/${id}/boundaries`,
        { key: 'accountAdministration', version: 1 },
      ],
      [
        'DELETE',
        `/api/administration/accounts/${id}/boundaries/accountAdministration/1`,
        undefined,
      ],
      ['DELETE', '/api/administration/roles/custom.helper', undefined],
      ['POST', '/api/administration/roles', { key: 'custom.helper', label: 'Helper', grants }],
      [
        'PUT',
        '/api/administration/roles/custom.helper',
        { label: 'Helper', grants, expectedDigest: 'a'.repeat(64) },
      ],
    ]);
  });

  it('encodes a role key or boundary key that carries reserved characters', async () => {
    const { client, calls } = http((path) =>
      path === '/api/auth/csrf' ? json({ csrfToken: 't' }) : json({ status: 'ok' }),
    );
    const admin = createAdministrationClient(client);
    await admin.revokeRole(id, 'a/b?c');
    await admin.unbindBoundary(id, { key: 'x/y', version: 2 });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      `/api/administration/accounts/${id}/roles/a%2Fb%3Fc`,
      `/api/administration/accounts/${id}/boundaries/x%2Fy/2`,
    ]);
  });

  it('the menu schema accepts roles', async () => {
    const userId = '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11';
    const { client } = http(() => json({ userId, menus: ['accounts', 'settings', 'roles'] }));
    await expect(createMeClient(client).me()).resolves.toEqual({
      userId,
      menus: ['accounts', 'settings', 'roles'],
    });
  });
});
