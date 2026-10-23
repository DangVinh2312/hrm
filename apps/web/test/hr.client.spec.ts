import { describe, expect, it, vi } from 'vitest';
import { createHrClient } from '../src/features/hr/hr.client';
import { ResponseShapeError, createHttpClient } from '../src/infrastructure/http.client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const userId = '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11';
const employee = { id: '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f', code: 'NV001', fullName: 'An' };

function client(answer: (path: string) => Response) {
  const paths: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    paths.push(path);
    return Promise.resolve(answer(path));
  });
  return { hr: createHrClient(createHttpClient(fetchImpl)), paths };
}

const answers = (profile: Response, auth: Response) => (path: string) =>
  path === '/api/auth/me' ? auth : profile;

describe('hr client', () => {
  it('merges GET /api/auth/me (account, menus) and GET /api/hr/employees/me (profile)', async () => {
    const { hr, paths } = client(
      answers(
        json({ employee, companyScope: true }),
        json({ userId, menus: ['employees', 'reports'] }),
      ),
    );
    await expect(hr.me()).resolves.toEqual({
      userId,
      employee,
      menus: ['employees', 'reports'],
      companyScope: true,
    });
    expect([...paths].sort()).toEqual(['/api/auth/me', '/api/hr/employees/me']);
    expect(paths).not.toContain('/api/hr/me');
  });

  it('keeps an account without an employee (employee null)', async () => {
    const { hr } = client(
      answers(json({ employee: null, companyScope: false }), json({ userId, menus: [] })),
    );
    await expect(hr.me()).resolves.toEqual({
      userId,
      employee: null,
      menus: [],
      companyScope: false,
    });
  });

  it('fails when either endpoint fails or breaks its contract', async () => {
    await expect(
      client(answers(json({}, 503), json({ userId, menus: [] }))).hr.me(),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      client(
        answers(json({ employee: null, companyScope: false }), json({ userId, menus: ['x'] })),
      ).hr.me(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    await expect(
      client(answers(json({ employee: null }), json({ userId, menus: [] }))).hr.me(),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });
});
