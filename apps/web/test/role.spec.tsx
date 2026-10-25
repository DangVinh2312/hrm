import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { routes } from '../src/app';
import type {
  AccountPermissions,
  AdministrationClient,
  RoleMatrix,
} from '../src/features/administration/administration.client';
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
  menus: ['roles'],
  employee: null,
  companyScope: false,
};

const grant = (permission: string, template = 'allEmployees', extra = {}) => ({
  permission,
  effect: 'allow' as const,
  template,
  version: 1,
  parameters: {},
  ...extra,
});
const matrix: RoleMatrix = {
  roles: [
    {
      key: 'hr.admin',
      label: 'Admin',
      source: 'code',
      holders: 2,
      grants: [grant('employee.read'), grant('employee.update'), grant('team.read', 'allTeams')],
    },
    { key: 'hr.employee', label: 'Employee', source: 'code', holders: 7, grants: [] },
    {
      key: 'custom.helper',
      label: 'Helper',
      source: 'runtime',
      holders: 0,
      grants: [grant('workRequest.read', 'ownRequests', { effect: 'deny' })],
    },
  ],
};

type Spies = { [K in keyof AdministrationClient]: Mock<AdministrationClient[K]> };

function setup(
  overrides: Partial<Spies> = {},
  menus: Viewer['menus'] = ['roles'],
  entry = '/roles',
) {
  const administration: Spies = {
    list: vi.fn<AdministrationClient['list']>(() => Promise.resolve({ items: [], total: '0' })),
    provision: vi.fn<AdministrationClient['provision']>(() =>
      Promise.reject(new ApiError(404, 'error.notFound')),
    ),
    suspend: vi.fn<AdministrationClient['suspend']>(() => Promise.resolve()),
    reactivate: vi.fn<AdministrationClient['reactivate']>(() => Promise.resolve()),
    roles: vi.fn<AdministrationClient['roles']>(() => Promise.resolve(matrix)),
    accountPermissions: vi.fn<AdministrationClient['accountPermissions']>(() =>
      Promise.reject(new ApiError(404, 'error.notFound')),
    ),
    ...overrides,
  };
  const view = renderRoutes(
    routes,
    auth(),
    entry,
    {},
    fakeServices({ viewer: { ...viewer, menus }, administration }),
  );
  return { administration, ...view };
}

describe('roles page (read-only matrix)', () => {
  it('shows each role with its source, holders and grants grouped by resource, under one h1', async () => {
    setup();
    expect(await screen.findByRole('heading', { level: 1, name: 'Vai trò' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const admin = await screen.findByRole('region', { name: 'Admin' });
    expect(within(admin).getByText('hr.admin')).toBeInTheDocument();
    expect(within(admin).getByText('Do hệ thống cấp')).toBeInTheDocument();
    expect(within(admin).getByText('Người giữ: 2')).toBeInTheDocument();
    // Grouped by resource: employee holds two grants, team one.
    const employee = within(admin).getByRole('group', { name: 'employee' });
    expect(within(employee).getByText('read · allEmployees')).toBeInTheDocument();
    expect(within(employee).getByText('update · allEmployees')).toBeInTheDocument();
    const team = within(admin).getByRole('group', { name: 'team' });
    expect(within(team).getByText('read · allTeams')).toBeInTheDocument();
    // A role without grants says so; a runtime role is marked and a deny is spelled out.
    const none = screen.getByRole('region', { name: 'Employee' });
    expect(within(none).getByText('Chưa có quyền nào.')).toBeInTheDocument();
    const custom = screen.getByRole('region', { name: 'Helper' });
    expect(within(custom).getByText('Tạo trong hệ thống')).toBeInTheDocument();
    expect(within(custom).getByText('read · ownRequests (từ chối)')).toBeInTheDocument();
  });

  it('is "not found" without the roles menu and asks the API for nothing', async () => {
    const { administration } = setup({}, ['accounts']);
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
    expect(administration.roles).not.toHaveBeenCalled();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).queryByRole('link', { name: 'Vai trò' })).toBeNull();
  });

  it('shows the Vai trò menu link when the server grants roles', async () => {
    setup({}, ['roles'], '/');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByRole('link', { name: 'Vai trò' })).toHaveAttribute(
      'href',
      '/roles',
    );
  });

  it('shows a failure with retry when the matrix cannot be read', async () => {
    const roles = vi
      .fn<AdministrationClient['roles']>()
      .mockRejectedValueOnce(new ApiError(403, 'error.accessDenied'))
      .mockResolvedValue(matrix);
    setup({ roles });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByRole('region', { name: 'Admin' })).toBeInTheDocument();
    expect(roles).toHaveBeenCalledTimes(2);
  });

  it('has no write control: no input, no create or delete button', async () => {
    setup();
    const main = await screen.findByRole('main');
    await within(main).findByRole('region', { name: 'Admin' });
    expect(within(main).queryByRole('button')).toBeNull();
    expect(within(main).queryByRole('textbox')).toBeNull();
  });
});

describe('account permissions in the accounts page', () => {
  const accountId = '11111111-1111-4111-8111-111111111111';
  const detail: AccountPermissions = {
    roles: [
      { key: 'hr.employee', label: 'Employee', source: 'code' },
      { key: 'custom.helper', label: 'Helper', source: 'runtime' },
    ],
    grants: [
      { ...grant('workRequest.read', 'ownRequests'), source: 'role' },
      { ...grant('account.read', 'allAccounts'), source: 'user' },
    ],
  };
  const withAccounts = (accountPermissions: AdministrationClient['accountPermissions']) =>
    setup(
      {
        list: vi.fn<AdministrationClient['list']>(() =>
          Promise.resolve({
            items: [
              { userId: accountId, email: 'an@example.test', state: 'active', enrollment: null },
            ],
            total: '1',
          }),
        ),
        accountPermissions: vi.fn(accountPermissions),
      },
      ['accounts'],
      '/accounts',
    );

  it('opens the roles and rules of one account on demand, not for every row', async () => {
    const user = userEvent.setup();
    const { administration } = withAccounts(() => Promise.resolve(detail));
    const button = await screen.findByRole('button', { name: 'Xem quyền an@example.test' });
    expect(administration.accountPermissions).not.toHaveBeenCalled();
    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Quyền của tài khoản' });
    expect(administration.accountPermissions).toHaveBeenCalledWith(accountId, expect.anything());
    expect(await within(dialog).findByText('Employee')).toBeInTheDocument();
    expect(within(dialog).getByText('Helper')).toBeInTheDocument();
    expect(within(dialog).getByText('read · ownRequests')).toBeInTheDocument();
    // A rule attached straight to the account is labelled.
    expect(within(dialog).getByText('read · allAccounts (gắn trực tiếp)')).toBeInTheDocument();
  });

  it('shows "not found" when the API does not reach the account or the viewer lacks the permission', async () => {
    const user = userEvent.setup();
    withAccounts(() => Promise.reject(new ApiError(404, 'error.notFound')));
    await user.click(await screen.findByRole('button', { name: 'Xem quyền an@example.test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Quyền của tài khoản' });
    await waitFor(() =>
      expect(within(dialog).getByText('Không tìm thấy trang')).toBeInTheDocument(),
    );
  });
});
