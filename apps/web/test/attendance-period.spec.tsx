import { fireEvent, screen, waitFor, within, configure } from '@testing-library/react';

import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import {
  type AttendanceClient,
  type AttendancePeriod,
  createAttendanceClient,
} from '../src/features/attendance/attendance.client';
import { ApiError, createHttpClient } from '../src/infrastructure/http.client';
import { fakeAuth, fakeServices, renderRoutes, type Viewer } from './render.helper';

// The machine can be heavily loaded: wait longer than the 1 s default before failing.
configure({ asyncUtilTimeout: 8000 });

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const me = (patch: Partial<Viewer> = {}): Viewer => ({
  userId: session.userId,
  employee: null,
  menus: ['attendance'],
  companyScope: true,
  ...patch,
});
const period = (patch: Partial<AttendancePeriod> = {}): AttendancePeriod => ({
  month: '2026-09',
  state: 'open',
  version: '1',
  events: [],
  ...patch,
});
const render = (client: Partial<AttendanceClient>, viewer = me()) =>
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    '/attendance',
    {},
    fakeServices({ viewer, attendance: client }),
  );

async function pickMonth(value: string) {
  const input = await screen.findByLabelText('Tháng chốt kỳ');
  fireEvent.change(input, { target: { value } });
}

describe('attendance period panel (HR)', () => {
  it('is shown only with company scope', async () => {
    const read = vi.fn(() => Promise.resolve(period()));
    render({ period: read }, me({ companyScope: false }));
    await screen.findByRole('heading', { level: 1, name: 'Bảng công' });
    expect(screen.queryByLabelText('Tháng chốt kỳ')).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it('closes an open month after confirmation and shows the history', async () => {
    let state: AttendancePeriod = period();
    const close = vi.fn(() => {
      state = period({
        state: 'closed',
        version: '2',
        events: [
          { event: 'close', version: '2', reason: null, occurredAt: '2026-10-21T03:00:00.000000Z' },
        ],
      });
      return Promise.resolve({ month: '2026-09', state: 'closed' as const, version: '2' });
    });
    render({ period: () => Promise.resolve(state), closePeriod: close });
    await pickMonth('2026-09');
    expect(await screen.findByText('Đang mở')).toBeInTheDocument();
    expect(screen.getByText('Chưa có lần chốt hay mở lại nào.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Chốt kỳ' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận chốt' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith('2026-09'));
    expect(await screen.findByText('Đã chốt')).toBeInTheDocument();
    const history = await screen.findByRole('table', { name: 'Lịch sử chốt và mở lại' });
    expect(within(history).getByText('Chốt')).toBeInTheDocument();
  });

  it('reopens a closed month only with a reason and lists the reason', async () => {
    let state = period({
      state: 'closed',
      version: '2',
      events: [
        { event: 'close', version: '2', reason: null, occurredAt: '2026-10-21T03:00:00.000000Z' },
      ],
    });
    const reopen = vi.fn(() => {
      state = period({
        version: '3',
        events: [
          {
            event: 'reopen',
            version: '3',
            reason: 'Sửa đơn nhập nhầm',
            occurredAt: '2026-10-21T04:00:00.000000Z',
          },
          ...state.events,
        ],
      });
      return Promise.resolve({ month: '2026-09', state: 'open' as const, version: '3' });
    });
    render({ period: () => Promise.resolve(state), reopenPeriod: reopen });
    await pickMonth('2026-09');
    await userEvent.click(await screen.findByRole('button', { name: 'Mở lại kỳ' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận mở lại' }));
    expect(await within(dialog).findByText('Nhập lý do mở lại kỳ công.')).toBeInTheDocument();
    expect(reopen).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Lý do mở lại/ }),
      'Sửa đơn nhập nhầm',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận mở lại' }));
    await waitFor(() => expect(reopen).toHaveBeenCalledWith('2026-09', 'Sửa đơn nhập nhầm'));
    expect(await screen.findByText('Sửa đơn nhập nhầm')).toBeInTheDocument();
  });

  it('offers the step-up when the session is not fresh', async () => {
    const close = vi.fn(() => Promise.reject(new ApiError(403, 'error.accessDenied')));
    render({ period: () => Promise.resolve(period()), closePeriod: close });
    await pickMonth('2026-09');
    await userEvent.click(await screen.findByRole('button', { name: 'Chốt kỳ' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận chốt' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Không thực hiện được thao tác',
    );
  });
});

describe('attendance client: periods', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('reads a period and posts close and reopen to the month path', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const path = typeof input === 'string' ? input : '';
      return Promise.resolve(
        path === '/api/auth/csrf'
          ? json({ csrfToken: 'tok' })
          : path.endsWith('/close') || path.endsWith('/reopen')
            ? json({ month: '2026-09', state: 'open', version: '3' })
            : json(period()),
      );
    });
    const client = createAttendanceClient(createHttpClient(fetchImpl));
    await client.period('2026-09');
    await client.closePeriod('2026-09');
    await client.reopenPeriod('2026-09', 'Lý do');
    const calls = fetchImpl.mock.calls.filter(([path]) => path !== '/api/auth/csrf');
    expect(calls.map(([path]) => path)).toEqual([
      '/api/hr/attendance/periods/2026-09',
      '/api/hr/attendance/periods/2026-09/close',
      '/api/hr/attendance/periods/2026-09/reopen',
    ]);
    const reopenBody = calls[2]?.[1]?.body;
    expect(JSON.parse(typeof reopenBody === 'string' ? reopenBody : '')).toEqual({
      reason: 'Lý do',
    });
  });

  it('says what a 409 means for a close or a reopen instead of the generic conflict, and reloads the month', async () => {
    const read = vi.fn(() => Promise.resolve(period()));
    const close = vi.fn(() => Promise.reject(new ApiError(409, 'error.conflict')));
    render({ period: read, closePeriod: close });
    await pickMonth('2026-09');
    await userEvent.click(await screen.findByRole('button', { name: 'Chốt kỳ' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận chốt' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Kỳ này đã đổi trạng thái hoặc chưa thể chốt');
    expect(alert).not.toHaveTextContent('Thông tin bị trùng');
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
  });
});
