import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { HrMe } from '../src/hr/hr.client';
import { ApiError, createHttpClient } from '../src/infrastructure/http.client';
import { createLeaveClient, type LeaveBalance, type LeaveClient } from '../src/leave/leave.client';
import { fakeAuth, fakeHr, renderRoutes } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const employeeId = '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22';
const me = (patch: Partial<HrMe> = {}): HrMe => ({
  userId: session.userId,
  employee: { id: employeeId, code: 'NV001', fullName: 'Người dùng giả' },
  menus: ['leave'],
  companyScope: false,
  ...patch,
});
const balance = (patch: Partial<LeaveBalance> = {}): LeaveBalance => ({
  employeeId,
  year: 2026,
  asOn: '2026-11-30',
  annualMinutes: 5760,
  entitledMinutes: 5280,
  usedMinutes: 720,
  futureApprovedMinutes: 480,
  pendingMinutes: 240,
  availableMinutes: 3840,
  ...patch,
});
const render = (path: string, client: Partial<LeaveClient> = {}, hrMe: HrMe = me()) =>
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    path,
    {},
    fakeHr({ hr: { me: () => Promise.resolve(hrMe) }, leave: client }),
  );

describe('annual leave balance', () => {
  it('is in the menu only when the server grants it', async () => {
    render('/', {}, me({ menus: [] }));
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(screen.queryByRole('link', { name: 'Phép năm' })).not.toBeInTheDocument();
  });

  it('links from the menu and shows the five D09 figures in days', async () => {
    const read = vi.fn(() => Promise.resolve(balance()));
    render('/', { balance: read });
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    await userEvent.click(await within(nav).findByRole('link', { name: 'Phép năm' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Phép năm' })).toBeInTheDocument();
    // 5280/480 = 11, 720/480 = 1.5, 480/480 = 1, 240/480 = 0.5, 3840/480 = 8; rate 12 days.
    const card = (label: string) => screen.getByRole('region', { name: label });
    expect(await screen.findByText('Định mức năm')).toBeInTheDocument();
    expect(card('Được cấp')).toHaveTextContent('11 ngày');
    expect(card('Đã dùng')).toHaveTextContent('1,5 ngày');
    expect(card('Đã duyệt cho ngày sau')).toHaveTextContent('1 ngày');
    expect(card('Đang chờ duyệt')).toHaveTextContent('0,5 ngày');
    expect(card('Khả dụng')).toHaveTextContent('8 ngày');
    expect(screen.getByText('Tại ngày 30/11/2026')).toBeInTheDocument();
    // The own profile from the session bootstrap is the only id the page asks for; today by default.
    expect(read).toHaveBeenCalledWith(employeeId, null, expect.anything());
  });

  it('asks for the date in the URL and changes it with the date field', async () => {
    const read = vi.fn(() => Promise.resolve(balance()));
    const view = render('/leave?date=2026-03-31', { balance: read });
    await screen.findByText('Được cấp');
    expect(read).toHaveBeenCalledWith(employeeId, '2026-03-31', expect.anything());
    // A URL that is not a date means today; nothing from it reaches the API.
    view.unmount();
    const other = vi.fn(() => Promise.resolve(balance()));
    render('/leave?date=2026-02-30', { balance: other });
    await screen.findByText('Được cấp');
    expect(other).toHaveBeenCalledWith(employeeId, null, expect.anything());
  });

  it('shows a loading state, then an error with retry that asks again', async () => {
    let calls = 0;
    const read = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new ApiError(403, 'error.accessDenied'))
        : Promise.resolve(balance());
    });
    render('/leave', { balance: read });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Không thực hiện được thao tác này');
    await userEvent.click(within(alert).getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Đang chờ duyệt')).toBeInTheDocument();
  });

  it('shows "not found" without a profile and for a 404 (absent and hidden look the same)', async () => {
    const read = vi.fn(() => Promise.resolve(balance()));
    const view = render('/leave', { balance: read }, me({ employee: null }));
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    view.unmount();
    render('/leave', { balance: () => Promise.reject(new ApiError(404, 'error.notFound')) });
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
  });

  it('never shows a negative figure as available and keeps a negative entitlement visible', async () => {
    render('/leave', {
      balance: () => Promise.resolve(balance({ entitledMinutes: -480, availableMinutes: 0 })),
    });
    const entitled = await screen.findByRole('region', { name: 'Được cấp' });
    expect(entitled).toHaveTextContent('-1 ngày');
    expect(screen.getByRole('region', { name: 'Khả dụng' })).toHaveTextContent('0 ngày');
  });

  it('is shown in English when the language is switched', async () => {
    renderRoutes(
      routes,
      fakeAuth({ session: () => Promise.resolve(session) }),
      '/leave',
      { locale: 'en' },
      fakeHr({
        hr: { me: () => Promise.resolve(me()) },
        leave: { balance: () => Promise.resolve(balance()) },
      }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Annual leave' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Available' })).toHaveTextContent('8 days');
  });
});

describe('leave client', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('reads the balance of one employee, with the report date only when given', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(balance())));
    const client = createLeaveClient(createHttpClient(fetchImpl));
    await client.balance(employeeId, null);
    await client.balance(employeeId, '2026-03-31');
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      `/api/hr/employees/${employeeId}/leave-balance`,
      `/api/hr/employees/${employeeId}/leave-balance?date=2026-03-31`,
    ]);
  });

  it('rejects a response that does not match the contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json({ ...balance(), availableMinutes: -1 })),
    );
    await expect(
      createLeaveClient(createHttpClient(fetchImpl)).balance(employeeId, null),
    ).rejects.toThrow();
  });
});
