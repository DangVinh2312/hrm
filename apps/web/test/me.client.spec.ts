import { describe, expect, it, vi } from 'vitest';
import { createMeClient } from '../src/features/auth/me.client';
import { createEmployeeClient } from '../src/features/employee/employee.client';
import { ResponseShapeError, createHttpClient } from '../src/infrastructure/http.client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const userId = '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11';
const employee = { id: '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f', code: 'NV001', fullName: 'An' };

function http(answer: (path: string) => Response) {
  const paths: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    paths.push(path);
    return Promise.resolve(answer(path));
  });
  return { client: createHttpClient(fetchImpl), paths };
}

describe('me client (GET /api/auth/me)', () => {
  it('reads the account and its server-granted menus', async () => {
    const { client, paths } = http(() => json({ userId, menus: ['employees', 'reports'] }));
    await expect(createMeClient(client).me()).resolves.toEqual({
      userId,
      menus: ['employees', 'reports'],
    });
    expect(paths).toEqual(['/api/auth/me']);
  });

  it('keeps an account without menus', async () => {
    const { client } = http(() => json({ userId, menus: [] }));
    await expect(createMeClient(client).me()).resolves.toEqual({ userId, menus: [] });
  });

  it('fails on a server error or a broken contract', async () => {
    await expect(createMeClient(http(() => json({}, 503)).client).me()).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      createMeClient(http(() => json({ userId, menus: ['x'] })).client).me(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });
});

describe('employee client me (GET /api/hr/employees/me)', () => {
  it('reads the linked employee and the company scope hint', async () => {
    const { client, paths } = http(() => json({ employee, companyScope: true }));
    await expect(createEmployeeClient(client).me()).resolves.toEqual({
      employee,
      companyScope: true,
    });
    expect(paths).toEqual(['/api/hr/employees/me']);
  });

  it('keeps an account without an employee (employee null)', async () => {
    const { client } = http(() => json({ employee: null, companyScope: false }));
    await expect(createEmployeeClient(client).me()).resolves.toEqual({
      employee: null,
      companyScope: false,
    });
  });

  it('fails on a server error or a broken contract', async () => {
    await expect(createEmployeeClient(http(() => json({}, 503)).client).me()).rejects.toMatchObject(
      { status: 503 },
    );
    await expect(
      createEmployeeClient(http(() => json({ employee: null })).client).me(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });
});
