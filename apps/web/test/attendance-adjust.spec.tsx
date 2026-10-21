import { fireEvent, screen, waitFor, within, configure } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import {
  type AttendanceAdjustments,
  type AttendanceClient,
  createAttendanceClient,
} from '../src/features/attendance/attendance.client';
import type { Employee } from '../src/features/employee/employee.client';
import type { HrMe } from '../src/features/hr/hr.client';
import { ApiError, createHttpClient } from '../src/infrastructure/http.client';
import { fakeAuth, fakeHr, renderRoutes } from './render.helper';

// The machine can be heavily loaded: wait longer than the 1 s default before failing.
configure({ asyncUtilTimeout: 8000 });

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const employeeId = '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22';
const entryId = '7c8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a33';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const me = (patch: Partial<HrMe> = {}): HrMe => ({
  userId: session.userId,
  employee: null,
  menus: ['employees'],
  companyScope: true,
  ...patch,
});
const employee: Employee = {
  id: employeeId,
  code: 'NV001',
  fullName: 'Nguyễn Văn A',
  hiredOn: '2026-01-05',
  terminatedOn: null,
  state: 'official',
  version: '3',
  accountId: null,
  position: null,
  classification: null,
  periods: [{ status: 'official', startsOn: '2026-01-05', endsOn: null }],
  teams: [],
};
const list = (patch: Partial<AttendanceAdjustments> = {}): AttendanceAdjustments => ({
  employeeId,
  month: '2026-09',
  periodState: 'open',
  adjustmentMinutes: -60,
  total: '1',
  items: [
    {
      id: entryId,
      workDate: '2026-09-03',
      minutes: -60,
      reason: 'Quên chấm công buổi chiều',
      reference: 'QĐ-2026/09',
      createdAt: '2026-09-04T03:00:00.000000Z',
    },
  ],
  ...patch,
});
const render = (attendance: Partial<AttendanceClient>, hr = me()) =>
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    `/employees/${employeeId}`,
    {},
    fakeHr({
      hr: { me: () => Promise.resolve(hr) },
      employees: { detail: () => Promise.resolve(employee) },
      attendance,
    }),
  );

async function pickMonth(value: string) {
  const input = await screen.findByLabelText('Tháng điều chỉnh');
  fireEvent.change(input, { target: { value } });
}

describe('attendance adjustments (HR)', () => {
  it('is shown only with company scope and asks nothing of the API otherwise', async () => {
    const read = vi.fn(() => Promise.resolve(list()));
    render({ adjustments: read }, me({ companyScope: false }));
    await screen.findByRole('heading', { level: 1, name: 'Nguyễn Văn A' });
    expect(screen.queryByRole('heading', { name: 'Điều chỉnh công' })).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it('lists the month with reasons and the signed total', async () => {
    const read = vi.fn(() => Promise.resolve(list()));
    render({ adjustments: read });
    await pickMonth('2026-09');
    const table = await screen.findByRole('table', { name: 'Điều chỉnh trong tháng' });
    expect(within(table).getByText('Quên chấm công buổi chiều')).toBeInTheDocument();
    expect(within(table).getByText('QĐ-2026/09')).toBeInTheDocument();
    expect(within(table).getByText('-60')).toBeInTheDocument();
    expect(screen.getByText(/Tổng điều chỉnh của tháng: -60 phút/)).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith(employeeId, '2026-09', expect.anything());
  });

  it('a closed month shows its state and blocks the button', async () => {
    render({ adjustments: () => Promise.resolve(list({ periodState: 'closed', items: [] })) });
    await pickMonth('2026-09');
    expect(await screen.findByText(/Kỳ công của tháng này đã chốt/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thêm điều chỉnh' })).toBeDisabled();
  });

  it('adds an adjustment: validated first, one idempotency key, reloaded after', async () => {
    let state = list({ items: [], adjustmentMinutes: 0, total: '0' });
    const add = vi.fn(() => {
      state = list();
      return Promise.resolve({ id: entryId });
    });
    const read = vi.fn(() => Promise.resolve(state));
    render({ adjustments: read, adjust: add });
    await pickMonth('2026-09');
    expect(await screen.findByText('Chưa có điều chỉnh nào trong tháng này.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Thêm điều chỉnh' }));
    const dialog = await screen.findByRole('dialog');
    // Nothing valid yet: no call, every field says what is wrong.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu điều chỉnh' }));
    expect(await within(dialog).findByText('Chọn ngày điều chỉnh.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Nhập số phút khác 0/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Nhập lý do, tối đa 300 ký tự/)).toBeInTheDocument();
    expect(add).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/^Ngày/), { target: { value: '2026-09-03' } });
    await userEvent.type(within(dialog).getByLabelText(/^Số phút/), '0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu điều chỉnh' }));
    expect(await within(dialog).findByText(/Nhập số phút khác 0/)).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText(/^Số phút/));
    await userEvent.type(within(dialog).getByLabelText(/^Số phút/), '-60');
    await userEvent.type(within(dialog).getByLabelText(/^Lý do/), '  Quên chấm công buổi chiều ');
    await userEvent.type(within(dialog).getByLabelText(/^Số tham chiếu/), '<script>');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu điều chỉnh' }));
    expect(await within(dialog).findByText(/chỉ gồm chữ, số/)).toBeInTheDocument();
    expect(add).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText(/^Số tham chiếu/));
    await userEvent.type(within(dialog).getByLabelText(/^Số tham chiếu/), 'QĐ-2026/09');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu điều chỉnh' }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add).toHaveBeenCalledWith(
      employeeId,
      {
        workDate: '2026-09-03',
        minutes: -60,
        reason: 'Quên chấm công buổi chiều',
        reference: 'QĐ-2026/09',
      },
      expect.stringMatching(uuidV4),
    );
    // The list is read again and shows the new entry; the dialog is gone.
    expect(
      await screen.findByRole('table', { name: 'Điều chỉnh trong tháng' }),
    ).toBeInTheDocument();
    expect(read.mock.calls.length).toBeGreaterThan(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }, 30_000);

  it('a retry after a refusal reuses the key; changed content gets a new one', async () => {
    const add = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'error.unavailable'))
      .mockResolvedValue({ id: entryId });
    render({ adjustments: () => Promise.resolve(list({ items: [] })), adjust: add });
    await pickMonth('2026-09');
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm điều chỉnh' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Ngày/), { target: { value: '2026-09-03' } });
    await userEvent.type(within(dialog).getByLabelText(/^Số phút/), '30');
    await userEvent.type(within(dialog).getByLabelText(/^Lý do/), 'Làm bù');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu điều chỉnh' }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    await within(dialog).findByRole('alert');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu điều chỉnh' }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(add.mock.calls[1]?.[2]).toBe(add.mock.calls[0]?.[2]);
  }, 30_000);

  it('says what a 409 means here, and keeps the closed-month message for periodClosed', async () => {
    const add = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'error.conflict'))
      .mockRejectedValueOnce(new ApiError(409, 'error.periodClosed'));
    const read = vi.fn(() => Promise.resolve(list({ items: [] })));
    render({ adjustments: read, adjust: add });
    await pickMonth('2026-09');
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm điều chỉnh' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Ngày/), { target: { value: '2026-09-03' } });
    await userEvent.type(within(dialog).getByLabelText(/^Số phút/), '-30');
    await userEvent.type(within(dialog).getByLabelText(/^Lý do/), 'Sai công');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu điều chỉnh' }));
    const conflict = await within(dialog).findByRole('alert');
    expect(conflict).toHaveTextContent('công của tháng sẽ nhỏ hơn 0');
    expect(conflict).not.toHaveTextContent('Thông tin bị trùng');
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu điều chỉnh' }));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/HR chốt công/);
  }, 30_000);
});

describe('attendance client (adjustments)', () => {
  it('uses the adjustment routes, the idempotency header and the read page budget', async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const path = typeof input === 'string' ? input : '';
      return Promise.resolve(
        path === '/api/auth/csrf'
          ? json({ csrfToken: 'csrf' })
          : path.includes('?')
            ? json(list())
            : json({ id: entryId }),
      );
    });
    const client = createAttendanceClient(createHttpClient(fetchImpl));
    await client.adjustments(employeeId, '2026-09');
    await client.adjust(
      employeeId,
      { workDate: '2026-09-03', minutes: -60, reason: 'Sai công' },
      '6d2f0c1e-8a7b-4c3d-9e5f-1a2b3c4d5e6f',
    );
    const calls = fetchImpl.mock.calls.filter(([path]) => path !== '/api/auth/csrf');
    expect(calls.map(([path]) => path)).toEqual([
      `/api/hr/employees/${employeeId}/attendance-adjustments?month=2026-09&limit=50`,
      `/api/hr/employees/${employeeId}/attendance-adjustments`,
    ]);
    const init = calls[1]?.[1] as { method: string; headers: Headers; body: string } | undefined;
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(
      '6d2f0c1e-8a7b-4c3d-9e5f-1a2b3c4d5e6f',
    );
    expect(JSON.parse(init?.body ?? '')).toEqual({
      workDate: '2026-09-03',
      minutes: -60,
      reason: 'Sai công',
    });
  });
});
