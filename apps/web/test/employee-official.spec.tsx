// ADR 0039 and the "official from a later day" display: the leave rate follows the official
// status (create form, detail page) and the confirm form starts from today and warns on a future day.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { Employee } from '../src/features/employee/employee.client';
import { businessToday } from '../src/i18n/format.helper';
import { fakeAuth, fakeServices, renderRoutes, type Viewer } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const auth = () => fakeAuth({ session: () => Promise.resolve(session) });
const id = '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f';
const rateId = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const viewer: Viewer = {
  userId: session.userId,
  employee: null,
  menus: ['employees'],
  companyScope: true,
};
const base: Employee = {
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
const official: Employee = {
  ...base,
  state: 'official',
  periods: [
    { status: 'probation', startsOn: '2026-01-05', endsOn: '2026-03-01' },
    { status: 'official', startsOn: '2026-03-01', endsOn: null },
  ],
};
const scheduled: Employee = {
  ...base,
  periods: [
    { status: 'probation', startsOn: '2026-01-05', endsOn: '2099-01-02' },
    { status: 'official', startsOn: '2099-01-02', endsOn: null },
  ],
};
const identityFixture = () => Promise.reject(new Error('not needed'));

describe('create form leave rate', () => {
  it('has no rate field and sends none for probation; the field appears for official', async () => {
    const create = vi.fn(() => Promise.resolve({ id }));
    renderRoutes(
      routes,
      auth(),
      '/employees',
      {},
      fakeServices({ viewer, employees: { create, detail: () => Promise.resolve(base) } }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm nhân viên' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/Định mức phép năm/)).toBeNull();
    await userEvent.type(within(dialog).getByLabelText(/Mã nhân viên/), 'NV001');
    await userEvent.type(within(dialog).getByLabelText(/Họ và tên/), 'Nguyễn Văn A');
    await userEvent.type(within(dialog).getByLabelText(/Ngày vào làm/), '05/01/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [body] = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(body).toMatchObject({ status: 'probation' });
    expect(Object.hasOwn(body, 'annualLeaveMinutes')).toBe(false);
  }, 20_000);

  it('shows the rate field (12 days by default) once official is chosen and sends it', async () => {
    const create = vi.fn(() => Promise.resolve({ id }));
    renderRoutes(
      routes,
      auth(),
      '/employees',
      {},
      fakeServices({ viewer, employees: { create, detail: () => Promise.resolve(official) } }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm nhân viên' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(
        within(dialog).getByRole('radiogroup', { name: /Trạng thái làm việc/ }),
      ).getByLabelText('Chính thức'),
    );
    expect(await within(dialog).findByLabelText(/Định mức phép năm/)).toHaveValue('12');
    await userEvent.type(within(dialog).getByLabelText(/Mã nhân viên/), 'NV001');
    await userEvent.type(within(dialog).getByLabelText(/Họ và tên/), 'Nguyễn Văn A');
    await userEvent.type(within(dialog).getByLabelText(/Ngày vào làm/), '05/01/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]).toMatchObject([{ status: 'official', annualLeaveMinutes: 5760 }]);
  }, 20_000);
});

describe('create form hidden rate', () => {
  it('official, a bad rate, then back to probation: submits without a rate', async () => {
    const create = vi.fn(() => Promise.resolve({ id }));
    renderRoutes(
      routes,
      auth(),
      '/employees',
      {},
      fakeServices({ viewer, employees: { create, detail: () => Promise.resolve(base) } }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm nhân viên' }));
    const dialog = await screen.findByRole('dialog');
    const status = within(dialog).getByRole('radiogroup', { name: /Trạng thái làm việc/ });
    await userEvent.click(within(status).getByLabelText('Chính thức'));
    const rate = await within(dialog).findByLabelText(/Định mức phép năm/);
    await userEvent.clear(rate);
    // Not a quarter day: invalid, and not clamped by the input on blur.
    await userEvent.type(rate, '12.1');
    // The status group is re-keyed on change: ask for the live one.
    const live = within(dialog).getByRole('radiogroup', { name: /Trạng thái làm việc/ });
    await userEvent.click(within(live).getAllByRole('radio')[0]!);
    await waitFor(() => expect(within(dialog).queryByLabelText(/Định mức phép năm/)).toBeNull());
    await userEvent.type(within(dialog).getByLabelText(/Mã nhân viên/), 'NV001');
    await userEvent.type(within(dialog).getByLabelText(/Họ và tên/), 'Nguyễn Văn A');
    await userEvent.type(within(dialog).getByLabelText(/Ngày vào làm/), '05/01/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [body] = create.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(body).toMatchObject({ status: 'probation' });
    expect(Object.hasOwn(body, 'annualLeaveMinutes')).toBe(false);
  }, 20_000);
});

describe('employee detail around the official date', () => {
  it('hides the leave rate block for probation and shows the note', async () => {
    renderRoutes(
      routes,
      auth(),
      `/employees/${id}`,
      {},
      fakeServices({
        viewer,
        employees: { detail: () => Promise.resolve(base), identity: identityFixture },
      }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Nguyễn Văn A' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Định mức phép năm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thêm định mức mới' })).toBeNull();
    expect(screen.getByText('Định mức phép năm phát sinh khi lên chính thức.')).toBeVisible();
    expect(screen.queryByText(/Sẽ chính thức từ/)).toBeNull();
  });

  it('shows the leave rate block with its add button once official', async () => {
    renderRoutes(
      routes,
      auth(),
      `/employees/${id}`,
      {},
      fakeServices({
        viewer,
        employees: {
          detail: () => Promise.resolve(official),
          identity: identityFixture,
          leaveRates: () =>
            Promise.resolve([{ id: rateId, effectiveFrom: '2026-03-01', annualMinutes: 5760 }]),
        },
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Định mức phép năm' })).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Thêm định mức mới' })).toBeVisible();
    expect(screen.queryByText('Định mức phép năm phát sinh khi lên chính thức.')).toBeNull();
  });

  it('says from when a probation employee becomes official when that day is in the future', async () => {
    renderRoutes(
      routes,
      auth(),
      `/employees/${id}`,
      {},
      fakeServices({
        viewer,
        employees: { detail: () => Promise.resolve(scheduled), identity: identityFixture },
      }),
    );
    expect(await screen.findByText('Sẽ chính thức từ 02/01/2099')).toBeVisible();
    expect(screen.getAllByText('Thử việc').length).toBeGreaterThan(0);
  });
});

describe('confirm official form', () => {
  const open = async (confirmOfficial = vi.fn(() => Promise.resolve({ version: '4' }))) => {
    renderRoutes(
      routes,
      auth(),
      `/employees/${id}`,
      {},
      fakeServices({
        viewer,
        employees: {
          detail: () => Promise.resolve(base),
          identity: identityFixture,
          confirmOfficial,
        },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Xác nhận chính thức' }));
    const dialog = await screen.findByRole('dialog');
    return {
      dialog,
      confirmOfficial,
      input: within(dialog).getByLabelText(/Ngày bắt đầu chính thức/),
    };
  };

  it('starts from today (Asia/Ho_Chi_Minh) without a warning', async () => {
    const { input, dialog } = await open();
    expect(input).toHaveValue(businessToday());
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  it('warns, without blocking, when the day is later than today', async () => {
    const { input, dialog, confirmOfficial } = await open();
    fireEvent.change(input, { target: { value: '2099-01-02' } });
    expect(await within(dialog).findByRole('status')).toHaveTextContent(/ở tương lai/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận chính thức' }));
    await waitFor(() => expect(confirmOfficial).toHaveBeenCalledWith(id, '2099-01-02'));
    fireEvent.change(input, { target: { value: businessToday() } });
    await waitFor(() => expect(within(dialog).queryByRole('status')).toBeNull());
  });
});
