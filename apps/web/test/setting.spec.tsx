import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { routes } from '../src/app';
import type { SettingClient, SettingRow } from '../src/features/setting/setting.client';
import { ApiError } from '../src/infrastructure/http.client';
import { fakeAuth, fakeServices, renderRoutes, type Viewer } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const auth = () => fakeAuth({ session: () => Promise.resolve(session) });
const viewer: Viewer = {
  userId: session.userId,
  menus: ['settings'],
  employee: null,
  companyScope: false,
};

const rule = (
  patch: Partial<Extract<SettingRow, { kind: 'int' }>> & { key: string },
): SettingRow => ({
  group: 'rule',
  kind: 'int',
  unit: 'days',
  value: 4,
  default: 4,
  min: 0,
  max: 31,
  version: '0',
  isDefault: true,
  updatedAt: null,
  ...patch,
});
const wfh = rule({ key: 'hr.wfhMonthLimit' });
const exportRows = rule({
  key: 'export.maxRows',
  unit: 'rows',
  value: 3000,
  default: 5000,
  min: 1,
  max: 5000,
  version: '2',
  isDefault: false,
});
const company: SettingRow = {
  key: 'company.name',
  group: 'profile',
  kind: 'text',
  value: 'Công ty Giả',
  default: '',
  maxLength: 120,
  version: '1',
  isDefault: false,
  updatedAt: '2026-11-02T02:00:00.000000Z',
};
const locale: SettingRow = {
  key: 'company.defaultLocale',
  group: 'profile',
  kind: 'enum',
  values: ['vi', 'en'],
  value: 'vi',
  default: 'vi',
  version: '0',
  isDefault: true,
  updatedAt: null,
};

type Spies = { [K in keyof SettingClient]: Mock<SettingClient[K]> };

function setup(
  options: {
    readonly overrides?: Partial<Spies>;
    readonly canUpdate?: { rule: boolean; profile: boolean };
    readonly menus?: Viewer['menus'];
    readonly entry?: string;
  } = {},
) {
  const setting: Spies = {
    list: vi.fn<SettingClient['list']>(() =>
      Promise.resolve({
        settings: [wfh, exportRows, company, locale],
        canUpdate: options.canUpdate ?? { rule: true, profile: true },
      }),
    ),
    profile: vi.fn<SettingClient['profile']>(() =>
      Promise.reject(new ApiError(404, 'error.notFound')),
    ),
    security: vi.fn<SettingClient['security']>(() =>
      Promise.resolve({
        freshAuthenticationSeconds: 300,
        sessionHours: 12,
        rateLimitWindowMinutes: 15,
        oidcAttemptMinutes: 5,
        idleMinutes: 30,
      }),
    ),
    history: vi.fn<SettingClient['history']>(() =>
      Promise.resolve({
        items: [
          { version: '2', oldValue: 5000, newValue: 3000, changedAt: '2026-11-02T02:00:00Z' },
        ],
        total: '1',
      }),
    ),
    update: vi.fn<SettingClient['update']>(() => Promise.resolve({ version: '3' })),
    ...options.overrides,
  };
  const view = renderRoutes(
    routes,
    auth(),
    options.entry ?? '/settings',
    {},
    fakeServices({ viewer: { ...viewer, menus: options.menus ?? ['settings'] }, setting }),
  );
  return { setting, ...view };
}

describe('settings page', () => {
  it('lists the HR rules with the value in force, default flag, version and one h1', async () => {
    setup();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cài đặt hệ thống' }),
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(await screen.findByLabelText('Số ngày WFH tối đa mỗi tháng')).toHaveValue('4');
    expect(screen.getByLabelText('Số dòng tối đa khi xuất Excel')).toHaveValue('3000');
    expect(screen.getByText('0–31 ngày')).toBeInTheDocument();
    expect(screen.getByText('1–5000 dòng')).toBeInTheDocument();
    expect(screen.getByText('Phiên bản 2')).toBeInTheDocument();
    expect(screen.getAllByText('Mặc định').length).toBeGreaterThan(0);
  });

  it('is "not found" without the settings menu and asks the API for nothing', async () => {
    const { setting } = setup({ menus: ['reports'] });
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
    expect(setting.list).not.toHaveBeenCalled();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).queryByRole('link', { name: 'Cài đặt' })).toBeNull();
  });

  it('shows the Cài đặt menu link when the server grants settings', async () => {
    setup({ entry: '/' });
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByRole('link', { name: 'Cài đặt' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });

  it('saves one value with the version that was shown, then reloads', async () => {
    const user = userEvent.setup();
    const { setting } = setup();
    const input = await screen.findByLabelText('Số ngày WFH tối đa mỗi tháng');
    const save = screen.getByRole('button', { name: 'Lưu Số ngày WFH tối đa mỗi tháng' });
    expect(save).toBeDisabled();
    await user.clear(input);
    await user.type(input, '6');
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() =>
      expect(setting.update).toHaveBeenCalledWith('rule', 'hr.wfhMonthLimit', 6, '0'),
    );
    await waitFor(() => expect(setting.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Đã lưu.')).toBeInTheDocument();
  });

  it('stops an out-of-range value before any request', async () => {
    const user = userEvent.setup();
    const { setting } = setup();
    const input = await screen.findByLabelText('Số ngày WFH tối đa mỗi tháng');
    await user.clear(input);
    await user.type(input, '99');
    expect(screen.getByRole('button', { name: 'Lưu Số ngày WFH tối đa mỗi tháng' })).toBeDisabled();
    expect(await screen.findAllByText(/không hợp lệ hoặc nằm ngoài phạm vi/)).not.toHaveLength(0);
    expect(setting.update).not.toHaveBeenCalled();
  });

  it('a 409 says it changed meanwhile and reloads; a 403 says it is not allowed (no step-up wording)', async () => {
    const user = userEvent.setup();
    const update = vi
      .fn<SettingClient['update']>()
      .mockRejectedValueOnce(new ApiError(409, 'error.conflict'))
      .mockRejectedValueOnce(new ApiError(403, 'error.accessDenied'));
    const { setting } = setup({ overrides: { update } });
    const input = await screen.findByLabelText('Số ngày WFH tối đa mỗi tháng');
    await user.clear(input);
    await user.type(input, '6');
    const save = screen.getByRole('button', { name: 'Lưu Số ngày WFH tối đa mỗi tháng' });
    await user.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent(/vừa được người khác thay đổi/);
    await waitFor(() => expect(setting.list).toHaveBeenCalledTimes(2));
    await user.click(save);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Không thực hiện được thao tác này/),
    );
    expect(screen.queryByText(/xác thực 2 lớp/)).toBeNull();
  });

  it('a caller who may update only one group sees the other as read-only text, no input', async () => {
    const user = userEvent.setup();
    setup({ canUpdate: { rule: false, profile: true } });
    await screen.findByText('Bạn chỉ có quyền xem nhóm này.');
    expect(screen.queryByLabelText('Số ngày WFH tối đa mỗi tháng')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Lưu / })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Thông tin công ty' }));
    expect(await screen.findByLabelText('Tên công ty')).toHaveValue('Công ty Giả');
    expect(screen.getByRole('button', { name: 'Lưu Tên công ty' })).toBeDisabled();
  });

  it('company information saves through the profile group', async () => {
    const user = userEvent.setup();
    const { setting } = setup();
    await user.click(await screen.findByRole('tab', { name: 'Thông tin công ty' }));
    const input = await screen.findByLabelText('Tên công ty');
    await user.clear(input);
    await user.type(input, 'Công ty Mới');
    await user.click(screen.getByRole('button', { name: 'Lưu Tên công ty' }));
    await waitFor(() =>
      expect(setting.update).toHaveBeenCalledWith('profile', 'company.name', 'Công ty Mới', '1'),
    );
  });

  it('opens the history of one key', async () => {
    const user = userEvent.setup();
    const { setting } = setup();
    await user.click(
      await screen.findByRole('button', { name: 'Lịch sử Số dòng tối đa khi xuất Excel' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(setting.history).toHaveBeenCalledWith('export.maxRows', 1, expect.anything());
    expect(await within(dialog).findByText('3000')).toBeInTheDocument();
    expect(within(dialog).getByText('5000')).toBeInTheDocument();
  });

  it('the security tab is view only: values, no input and no save', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('tab', { name: 'Bảo mật và phiên' }));
    const table = await screen.findByRole('table', { name: 'Bảo mật và phiên' });
    expect(within(table).getByText('300 giây')).toBeInTheDocument();
    expect(within(table).getByText('12 giờ')).toBeInTheDocument();
    expect(within(table).getByText('15 phút')).toBeInTheDocument();
    expect(within(table).getByText('5 phút')).toBeInTheDocument();
    expect(within(table).getByText('30 phút')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Lưu / })).toBeNull();
  });

  it('shows the company name in the shell and adopts the company language for someone who chose none', async () => {
    const profile = vi.fn<SettingClient['profile']>(() =>
      Promise.resolve({ companyName: 'Công ty Giả', defaultLocale: 'en' }),
    );
    window.localStorage.removeItem('hrm.locale');
    setup({ overrides: { profile }, entry: '/' });
    expect(await screen.findByText('Công ty Giả')).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    // Adopting a default is not a personal choice: nothing is remembered.
    expect(window.localStorage.getItem('hrm.locale')).toBeNull();
  });
});
