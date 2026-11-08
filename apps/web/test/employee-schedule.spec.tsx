// ADR-19 own hours on the employee detail page.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { Employee } from '../src/features/employee/employee.client';
import { fakeAuth, fakeServices, renderRoutes, type Viewer } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const auth = () => fakeAuth({ session: () => Promise.resolve(session) });
const id = '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f';
const running = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const planned = '2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const viewer: Viewer = {
  userId: session.userId,
  employee: null,
  menus: ['employees'],
  companyScope: true,
};
const employee: Employee = {
  id,
  code: 'NV001',
  fullName: 'Nguyễn Văn A',
  hiredOn: '2026-01-05',
  terminatedOn: null,
  state: 'probation',
  version: '3',
  accountId: null,
  position: null,
  classification: null,
  periods: [{ status: 'probation', startsOn: '2026-01-05', endsOn: null }],
  teams: [],
};
/** A week with `frame` on one ISO weekday (1 = Monday) and the company's hours elsewhere. */
const only = (weekday: number, frame: number[][]) =>
  Array.from({ length: 7 }, (_, index) => (index === weekday - 1 ? frame : []));

const render = (employees: object) =>
  renderRoutes(
    routes,
    auth(),
    `/employees/${id}`,
    {},
    fakeServices({
      viewer,
      employees: {
        detail: () => Promise.resolve(employee),
        identity: () => Promise.reject(new Error('not needed')),
        ...employees,
      },
    }),
  );

describe('employee own hours', { timeout: 15_000 }, () => {
  it('is hidden when the API answers 404', async () => {
    render({});
    expect(await screen.findByRole('heading', { level: 1, name: 'Nguyễn Văn A' })).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Giờ làm riêng' })).toBeNull(),
    );
  });

  it('lists frames, ends the running one, removes a planned one and adds a whole month', async () => {
    const scheduleFrames = vi.fn(() =>
      Promise.resolve({
        today: '2026-11-04',
        maxMinutes: 480,
        frames: [
          { id: running, validFrom: '2026-10-01', validTo: null, days: only(1, [[480, 720]]) },
          {
            id: planned,
            validFrom: '2027-01-01',
            validTo: '2027-01-31',
            days: only(2, [[600, 900]]),
          },
        ],
      }),
    );
    const endScheduleFrame = vi.fn(() => Promise.resolve());
    const addScheduleFrame = vi.fn(() => Promise.resolve());
    render({ scheduleFrames, endScheduleFrame, addScheduleFrame });

    const frame = await screen.findByRole('table', { name: '01/10/2026 – không hạn' });
    expect(within(frame).getByRole('row', { name: /Thứ Hai/ })).toHaveTextContent('08:00–12:00');
    expect(within(frame).queryByRole('row', { name: /Thứ Ba/ })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Kết thúc giờ làm riêng 01/10/2026 – không hạn' }),
    );
    await waitFor(() => expect(endScheduleFrame).toHaveBeenCalledWith(id, running));
    await userEvent.click(
      screen.getByRole('button', { name: 'Bỏ giờ làm riêng 01/01/2027 – 31/01/2027' }),
    );
    await waitFor(() => expect(endScheduleFrame).toHaveBeenLastCalledWith(id, planned));

    await userEvent.click(screen.getByRole('button', { name: 'Thêm giờ làm riêng' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cả tháng' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Thêm ca Thứ Hai' }));
    fireEvent.change(within(dialog).getByLabelText('Thứ Hai giờ bắt đầu ca 1'), {
      target: { value: '08:00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Thứ Hai giờ kết thúc ca 1'), {
      target: { value: '12:00' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(addScheduleFrame).toHaveBeenCalledWith(id, {
        validFrom: '2026-12-01',
        validTo: '2026-12-31',
        days: only(1, [[480, 720]]),
      }),
    );
  });

  it('refuses a start that is not after today before the API', async () => {
    const addScheduleFrame = vi.fn(() => Promise.resolve());
    render({
      scheduleFrames: () => Promise.resolve({ today: '2026-11-04', maxMinutes: 480, frames: [] }),
      addScheduleFrame,
    });
    expect(await screen.findByText('Nhân viên làm theo giờ chung.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Thêm giờ làm riêng' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Từ ngày/), '04/11/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    expect(await within(dialog).findByText('Ngày áp dụng phải sau hôm nay.')).toBeVisible();
    expect(addScheduleFrame).not.toHaveBeenCalled();
  });
});
