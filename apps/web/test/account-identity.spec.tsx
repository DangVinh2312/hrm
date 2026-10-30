import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { routes } from '../src/app';
import type {
  AccountPermissions,
  AdministrationClient,
} from '../src/features/administration/administration.client';
import { ApiError } from '../src/infrastructure/http.client';
import { fakeAuth, fakeServices, renderRoutes } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const accountId = '11111111-1111-4111-8111-111111111111';
const identityPermissions = [
  'account.changeEmail',
  'account.resetGoogleBinding',
  'account.resetMfa',
];
const bound = (permissions: string[], key: string, seeded = false) =>
  permissions.map((permission) => ({ permission, key, version: 1, seeded }));
const detail = (patch: Partial<AccountPermissions> = {}): AccountPermissions => ({
  roles: [{ key: 'hr.employee', label: 'Employee', source: 'code' }],
  grants: [],
  boundaries: [],
  truncated: false,
  ...patch,
});

type Spies = { [K in keyof AdministrationClient]: Mock<AdministrationClient[K]> };

function setup(overrides: Partial<Spies> = {}, listed = accountId) {
  const administration: Spies = {
    list: vi.fn<AdministrationClient['list']>(() =>
      Promise.resolve({
        items: [{ userId: listed, email: 'an@example.test', state: 'active', enrollment: null }],
        total: '1',
      }),
    ),
    provision: vi.fn<AdministrationClient['provision']>(() =>
      Promise.reject(new ApiError(404, 'error.notFound')),
    ),
    suspend: vi.fn<AdministrationClient['suspend']>(() => Promise.resolve()),
    reactivate: vi.fn<AdministrationClient['reactivate']>(() => Promise.resolve()),
    roles: vi.fn<AdministrationClient['roles']>(() =>
      Promise.reject(new ApiError(403, 'error.accessDenied')),
    ),
    accountPermissions: vi.fn<AdministrationClient['accountPermissions']>(() =>
      Promise.resolve(detail()),
    ),
    assignRole: vi.fn<AdministrationClient['assignRole']>(() => Promise.resolve()),
    revokeRole: vi.fn<AdministrationClient['revokeRole']>(() => Promise.resolve()),
    bindBoundary: vi.fn<AdministrationClient['bindBoundary']>(() => Promise.resolve()),
    unbindBoundary: vi.fn<AdministrationClient['unbindBoundary']>(() => Promise.resolve()),
    changeEmail: vi.fn<AdministrationClient['changeEmail']>(() => Promise.resolve()),
    resetMfa: vi.fn<AdministrationClient['resetMfa']>(() => Promise.resolve()),
    resetGoogleBinding: vi.fn<AdministrationClient['resetGoogleBinding']>(() => Promise.resolve()),
    deleteRole: vi.fn<AdministrationClient['deleteRole']>(() => Promise.resolve()),
    createRole: vi.fn<AdministrationClient['createRole']>(() =>
      Promise.resolve({ key: 'custom.x', digest: 'b'.repeat(64) }),
    ),
    updateRole: vi.fn<AdministrationClient['updateRole']>(() =>
      Promise.resolve({ key: 'custom.x', digest: 'b'.repeat(64) }),
    ),
    ...overrides,
  };
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    '/accounts',
    {},
    fakeServices({
      viewer: { userId: session.userId, menus: ['accounts'], employee: null, companyScope: false },
      administration,
    }),
  );
  return administration;
}

async function openDialog(name = 'Xem quyền an@example.test') {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name }));
  const dialog = await screen.findByRole('dialog', { name: 'Quyền của tài khoản' });
  await within(dialog).findByText('Employee');
  const identity = within(dialog).getByRole('region', { name: 'Danh tính đăng nhập' });
  return { user, dialog, identity };
}

describe('identity operations in the account dialog', () => {
  it('changes the email only after a confirmation that says what follows, then reloads', async () => {
    const administration = setup();
    const { user, dialog, identity } = await openDialog();
    await user.click(within(identity).getByRole('button', { name: 'Đổi email' }));
    const panel = within(identity).getByRole('group', { name: 'Đổi email của tài khoản này?' });
    expect(panel).toHaveTextContent(/mọi phiên của tài khoản bị đăng xuất/);
    await user.type(within(identity).getByLabelText(/Email mới/), '  New@Example.TEST ');
    expect(administration.changeEmail).not.toHaveBeenCalled();
    await user.click(within(panel).getByRole('button', { name: 'Xác nhận đổi email' }));
    await waitFor(() =>
      expect(administration.changeEmail).toHaveBeenCalledWith(accountId, 'new@example.test'),
    );
    const status = await within(dialog).findByRole('status');
    expect(status).toHaveTextContent('Đã đổi email.');
    expect(status).not.toHaveTextContent('example.test');
    await waitFor(() => expect(administration.accountPermissions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(administration.list).toHaveBeenCalledTimes(2));
  });

  it('stops a malformed email before any request', async () => {
    const administration = setup();
    const { user, identity } = await openDialog();
    await user.click(within(identity).getByRole('button', { name: 'Đổi email' }));
    await user.type(within(identity).getByLabelText(/Email mới/), 'not-an-email');
    await user.click(within(identity).getByRole('button', { name: 'Xác nhận đổi email' }));
    expect(within(identity).getByText('Nhập một địa chỉ email hợp lệ.')).toBeInTheDocument();
    expect(administration.changeEmail).not.toHaveBeenCalled();
  });

  it('resets 2FA behind a confirmation that names the recovery codes', async () => {
    const administration = setup();
    const { user, identity } = await openDialog();
    await user.click(within(identity).getByRole('button', { name: 'Reset 2FA' }));
    const panel = within(identity).getByRole('group', { name: 'Reset 2FA của tài khoản này?' });
    expect(panel).toHaveTextContent(/mã khôi phục và 2FA bị xóa/);
    expect(administration.resetMfa).not.toHaveBeenCalled();
    await user.click(within(panel).getByRole('button', { name: 'Xác nhận reset 2FA' }));
    await waitFor(() => expect(administration.resetMfa).toHaveBeenCalledWith(accountId));
    expect(await within(identity).findByRole('status')).toHaveTextContent('Đã reset 2FA.');
  });

  it('resets the Google binding behind a confirmation that names the new invitation', async () => {
    const administration = setup();
    const { user, identity } = await openDialog();
    await user.click(within(identity).getByRole('button', { name: 'Reset Google' }));
    const panel = within(identity).getByRole('group', {
      name: 'Reset liên kết Google của tài khoản này?',
    });
    expect(panel).toHaveTextContent(/đăng nhập lại bằng Google mới/);
    expect(panel).toHaveTextContent(/7 ngày/);
    await user.click(within(panel).getByRole('button', { name: 'Hủy' }));
    expect(administration.resetGoogleBinding).not.toHaveBeenCalled();
    await user.click(within(identity).getByRole('button', { name: 'Reset Google' }));
    await user.click(within(identity).getByRole('button', { name: 'Xác nhận reset Google' }));
    await waitFor(() => expect(administration.resetGoogleBinding).toHaveBeenCalledWith(accountId));
  });

  it('offers the step-up on a 403 and does not retry', async () => {
    const resetMfa = vi
      .fn<AdministrationClient['resetMfa']>()
      .mockRejectedValue(new ApiError(403, 'error.accessDenied'));
    setup({ resetMfa });
    const { user, identity } = await openDialog();
    await user.click(within(identity).getByRole('button', { name: 'Reset 2FA' }));
    await user.click(within(identity).getByRole('button', { name: 'Xác nhận reset 2FA' }));
    expect(await within(identity).findByRole('alert')).toHaveTextContent(/xác thực 2 lớp/);
    expect(resetMfa).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Đổi email', 'Xác nhận đổi email', 'changeEmail', /Email đã được dùng hoặc không thay đổi/],
    ['Reset 2FA', 'Xác nhận reset 2FA', 'resetMfa', /không có 2FA để reset/],
  ] as const)('shows the page own text for a 409 of %s', async (open, confirm, method, text) => {
    setup({ [method]: vi.fn(() => Promise.reject(new ApiError(409, 'error.conflict'))) });
    const { user, identity } = await openDialog();
    await user.click(within(identity).getByRole('button', { name: open }));
    if (method === 'changeEmail') {
      await user.type(within(identity).getByLabelText(/Email mới/), 'new@example.test');
    }
    await user.click(within(identity).getByRole('button', { name: confirm }));
    const alert = await within(identity).findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent(/người khác thay đổi/);
  });

  it('offers no identity control on the caller own row', async () => {
    setup({}, session.userId);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Xem quyền an@example.test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Quyền của tài khoản' });
    await within(dialog).findByText('Employee');
    expect(within(dialog).queryByRole('button', { name: 'Đổi email' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Reset 2FA' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Reset Google' })).toBeNull();
  });
});

describe('identityAdministration@1 package in the account dialog', () => {
  it('is off when nothing of it is bound, and binds with its own reference', async () => {
    const administration = setup({
      accountPermissions: vi.fn(() =>
        Promise.resolve(
          detail({
            boundaries: bound(['account.suspend'], 'accountAdministration'),
          }),
        ),
      ),
    });
    const { user, dialog } = await openDialog();
    const section = within(dialog).getByRole('region', { name: 'Gói quyền danh tính' });
    expect(within(section).getByText('Chưa bật')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Bật gói' }));
    await waitFor(() =>
      expect(administration.bindBoundary).toHaveBeenCalledWith(accountId, {
        key: 'identityAdministration',
        version: 1,
      }),
    );
    const other = within(dialog).getByRole('region', { name: 'Gói quyền quản trị' });
    expect(within(other).getByText('Bật một phần')).toBeInTheDocument();
  });

  it('shows a full package and unbinds it with its own reference after a confirmation', async () => {
    const administration = setup({
      accountPermissions: vi.fn(() =>
        Promise.resolve(
          detail({ boundaries: bound(identityPermissions, 'identityAdministration') }),
        ),
      ),
    });
    const { user, dialog } = await openDialog();
    const section = within(dialog).getByRole('region', { name: 'Gói quyền danh tính' });
    expect(within(section).getByText('Đã bật')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Bật gói' })).toBeNull();
    const other = within(dialog).getByRole('region', { name: 'Gói quyền quản trị' });
    expect(within(other).getByText('Chưa bật')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Gỡ gói' }));
    expect(administration.unbindBoundary).not.toHaveBeenCalled();
    await user.click(within(section).getByRole('button', { name: 'Gỡ gói quyền' }));
    await waitFor(() =>
      expect(administration.unbindBoundary).toHaveBeenCalledWith(accountId, {
        key: 'identityAdministration',
        version: 1,
      }),
    );
  });

  it('names what is missing when only part is bound and offers no bind', async () => {
    setup({
      accountPermissions: vi.fn(() =>
        Promise.resolve(
          detail({ boundaries: bound(['account.resetMfa'], 'identityAdministration') }),
        ),
      ),
    });
    const { dialog } = await openDialog();
    const section = within(dialog).getByRole('region', { name: 'Gói quyền danh tính' });
    expect(within(section).getByText('Bật một phần')).toBeInTheDocument();
    expect(within(section).getByText(/account\.changeEmail/)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Bật gói' })).toBeNull();
  });
});
