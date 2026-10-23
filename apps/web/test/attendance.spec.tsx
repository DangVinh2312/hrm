import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import {
  type AttendanceClient,
  type AttendanceSheet,
  createAttendanceClient,
} from '../src/features/attendance/attendance.client';
import { ApiError, createHttpClient } from '../src/infrastructure/http.client';
import { fakeAuth, fakeServices, renderRoutes, type Viewer } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const employeeId = '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22';
const me = (patch: Partial<Viewer> = {}): Viewer => ({
  userId: session.userId,
  employee: { id: employeeId, code: 'NV001', fullName: 'Người dùng giả' },
  menus: ['attendance'],
  companyScope: false,
  ...patch,
});
const sheet = (patch: Partial<AttendanceSheet> = {}): AttendanceSheet => ({
  employeeId,
  month: '2026-11',
  periodState: 'open',
  scheduledMinutes: 10080,
  paidHolidayMinutes: 480,
  unpaidMinutes: 120,
  annualLeaveMinutes: 480,
  paidMinutes: 10440,
  wfhDays: 2,
  lateCount: 1,
  lateMinutes: 60,
  earlyCount: 0,
  earlyMinutes: 0,
  adjustmentMinutes: 0,
  ...patch,
});
const render = (path: string, client: Partial<AttendanceClient> = {}, viewer: Viewer = me()) =>
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    path,
    {},
    fakeServices({ viewer, attendance: client }),
  );

describe('attendance sheet', () => {
  it('is in the menu only when the server grants it', async () => {
    render('/', {}, me({ menus: [] }));
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(screen.queryByRole('link', { name: 'Bảng công' })).not.toBeInTheDocument();
  });

  it('links from the menu and shows the D05 figures in days, minutes and counts', async () => {
    const read = vi.fn(() => Promise.resolve(sheet()));
    render('/', { sheet: read });
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    await userEvent.click(await within(nav).findByRole('link', { name: 'Bảng công' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Bảng công' })).toBeInTheDocument();
    // 10080/480 = 21, 480/480 = 1, 120/480 = 0,25, 10440/480 = 21,75.
    const card = (label: string) => screen.getByRole('region', { name: label });
    expect(await screen.findByText('Đang mở')).toBeInTheDocument();
    expect(card('Công theo lịch')).toHaveTextContent('21 ngày');
    expect(card('Công theo lịch')).toHaveTextContent('10080 phút');
    expect(card('Công hưởng lương')).toHaveTextContent('21,75 ngày');
    expect(card('Nghỉ lễ hưởng lương')).toHaveTextContent('1 ngày');
    expect(card('Nghỉ không lương')).toHaveTextContent('0,25 ngày');
    expect(card('Nghỉ phép năm')).toHaveTextContent('1 ngày');
    expect(card('Làm việc tại nhà')).toHaveTextContent('2 ngày');
    expect(card('Đi muộn')).toHaveTextContent('1 lần · 60 phút');
    expect(card('Về sớm')).toHaveTextContent('0 lần · 0 phút');
    // The own profile from the session bootstrap is the only id the page asks for; this month by default.
    expect(read).toHaveBeenCalledWith(employeeId, null, expect.anything());
  });

  it('shows a closed month as closed', async () => {
    render('/attendance', { sheet: () => Promise.resolve(sheet({ periodState: 'closed' })) });
    expect(await screen.findByText('Đã chốt')).toBeInTheDocument();
  });

  it('asks for the month in the URL; a URL that is not a month means this month', async () => {
    const read = vi.fn(() => Promise.resolve(sheet()));
    const view = render('/attendance?month=2026-03', { sheet: read });
    await screen.findByText('Công theo lịch');
    expect(read).toHaveBeenCalledWith(employeeId, '2026-03', expect.anything());
    view.unmount();
    const other = vi.fn(() => Promise.resolve(sheet()));
    render('/attendance?month=2026-13', { sheet: other });
    await screen.findByText('Công theo lịch');
    expect(other).toHaveBeenCalledWith(employeeId, null, expect.anything());
  });

  it('shows an error with retry that asks again', async () => {
    let calls = 0;
    const read = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new ApiError(403, 'error.accessDenied'))
        : Promise.resolve(sheet());
    });
    render('/attendance', { sheet: read });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Không thực hiện được thao tác này');
    await userEvent.click(within(alert).getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Công hưởng lương')).toBeInTheDocument();
  });

  it('shows "not found" without a profile and for a 404 (absent and hidden look the same)', async () => {
    const read = vi.fn(() => Promise.resolve(sheet()));
    const view = render('/attendance', { sheet: read }, me({ employee: null }));
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    view.unmount();
    render('/attendance', { sheet: () => Promise.reject(new ApiError(404, 'error.notFound')) });
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
  });

  it('is shown in English when the language is switched', async () => {
    renderRoutes(
      routes,
      fakeAuth({ session: () => Promise.resolve(session) }),
      '/attendance',
      { locale: 'en' },
      fakeServices({
        viewer: me(),
        attendance: { sheet: () => Promise.resolve(sheet()) },
      }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Timesheet' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Paid time' })).toHaveTextContent(
      '21.75 days',
    );
    expect(screen.getByRole('region', { name: 'Late arrival' })).toHaveTextContent(
      '1 times · 60 min',
    );
  });
});

describe('attendance client', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('reads the sheet of one employee, with the month only when given', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(sheet())));
    const client = createAttendanceClient(createHttpClient(fetchImpl));
    await client.sheet(employeeId, null);
    await client.sheet(employeeId, '2026-03');
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      `/api/hr/employees/${employeeId}/attendance`,
      `/api/hr/employees/${employeeId}/attendance?month=2026-03`,
    ]);
  });

  it('rejects a response that does not match the contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json({ ...sheet(), periodState: 'maybe' })),
    );
    await expect(
      createAttendanceClient(createHttpClient(fetchImpl)).sheet(employeeId, null),
    ).rejects.toThrow();
  });
});
