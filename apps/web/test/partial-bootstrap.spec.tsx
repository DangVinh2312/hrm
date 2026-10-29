import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { AttendanceClient } from '../src/features/attendance/attendance.client';
import type { ReportClient } from '../src/features/report/report.client';
import { ApiError } from '../src/infrastructure/http.client';
import { fakeAuth, fakeServices, renderRoutes, type Viewer } from './render.helper';

// `GET /api/auth/me` and `GET /api/hr/employees/me` are independent: one failing must
// not take the other's consumers down with it.
const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const viewer = (patch: Partial<Viewer> = {}): Viewer => ({
  userId: session.userId,
  employee: { id: '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22', code: 'NV001', fullName: 'Giả' },
  menus: ['reports', 'attendance'],
  companyScope: true,
  ...patch,
});
const failure = () => Promise.reject(new ApiError(403, 'error.accessDenied'));
const render = (path: string, services: Parameters<typeof fakeServices>[0]) =>
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    path,
    {},
    fakeServices(services),
  );

describe('one bootstrap request failing', () => {
  it('report: menus failing shows its own error and asks for no rows', async () => {
    const page = vi.fn<ReportClient['page']>();
    render('/reports', { viewer: viewer(), me: { me: failure }, report: { page } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Không thực hiện được thao tác này');
    expect(page).not.toHaveBeenCalled();
  });

  it('attendance: own employee failing shows an error while the menu stays', async () => {
    const sheet = vi.fn<AttendanceClient['sheet']>();
    render('/attendance', {
      viewer: viewer(),
      employees: { me: failure },
      attendance: { sheet },
    });
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByRole('link', { name: 'Bảng công' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(sheet).not.toHaveBeenCalled();
  });

  it('shell: menus failing still shows what every signed-in user has', async () => {
    render('/', { viewer: viewer(), me: { me: failure } });
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(
      await within(nav).findByRole('link', { name: 'Phương thức đăng nhập' }),
    ).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Báo cáo' })).not.toBeInTheDocument();
  });
});
