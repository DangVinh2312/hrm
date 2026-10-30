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
const digest = 'a'.repeat(64);
const catalog: RoleMatrix['catalog'] = [
  { permission: 'employee.read', template: { key: 'allEmployees', version: 1 } },
  { permission: 'employee.update', template: { key: 'allEmployees', version: 1 } },
  { permission: 'team.read', template: { key: 'allTeams', version: 1 } },
  { permission: 'workRequest.read', template: { key: 'ownRequests', version: 1 } },
  { permission: 'hrCompany.approvals', template: { key: 'company', version: 1 } },
  { permission: 'workRequest.decideFinal', template: { key: 'finalQueue', version: 1 } },
];
const matrix: RoleMatrix = {
  roles: [
    {
      key: 'hr.admin',
      label: 'Admin',
      source: 'code',
      holders: 2,
      digest,
      capabilities: [],
      grants: [grant('employee.read'), grant('employee.update'), grant('team.read', 'allTeams')],
    },
    {
      key: 'hr.employee',
      label: 'Employee',
      source: 'code',
      holders: 7,
      digest,
      capabilities: [],
      grants: [],
    },
    {
      key: 'custom.helper',
      label: 'Helper',
      source: 'runtime',
      holders: 0,
      digest,
      capabilities: [],
      grants: [grant('workRequest.read', 'ownRequests', { effect: 'deny' })],
    },
  ],
  catalog,
  truncated: false,
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

  it('warns when the API says the matrix was cut at a read limit, and not otherwise', async () => {
    setup({ roles: vi.fn(() => Promise.resolve({ ...matrix, truncated: true })) });
    expect(await screen.findByRole('status')).toHaveTextContent('chưa đầy đủ');
    expect(screen.getByRole('region', { name: 'Admin' })).toBeInTheDocument();
  });

  it('shows no warning for a complete matrix', async () => {
    setup();
    await screen.findByRole('region', { name: 'Admin' });
    expect(screen.queryByRole('status')).toBeNull();
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

  it('has no input and no button on a role the system owns', async () => {
    setup();
    const admin = await screen.findByRole('region', { name: 'Admin' });
    expect(within(admin).queryByRole('button')).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Employee' })).queryByRole('button'),
    ).toBeNull();
    expect(within(screen.getByRole('main')).queryByRole('textbox')).toBeNull();
  });

  it('marks a role holding both approval permissions as able to approve its own requests', async () => {
    const approver = {
      key: 'custom.approver',
      label: 'Approver',
      source: 'runtime' as const,
      holders: 0,
      digest,
      capabilities: ['selfApproval' as const],
      grants: [
        grant('hrCompany.approvals', 'company'),
        grant('workRequest.decideFinal', 'finalQueue'),
      ],
    };
    const onlyApprovals = {
      key: 'custom.half',
      label: 'Half',
      source: 'runtime' as const,
      holders: 0,
      digest,
      capabilities: [],
      grants: [grant('hrCompany.approvals', 'company')],
    };
    const denied = {
      key: 'custom.denied',
      label: 'Denied',
      source: 'runtime' as const,
      holders: 0,
      digest,
      capabilities: [],
      grants: [
        grant('hrCompany.approvals', 'company'),
        grant('workRequest.decideFinal', 'finalQueue', { effect: 'deny' }),
      ],
    };
    setup({
      roles: vi.fn(() =>
        Promise.resolve({ roles: [approver, onlyApprovals, denied], catalog, truncated: false }),
      ),
    });
    const flagged = await screen.findByRole('region', { name: 'Approver' });
    expect(within(flagged).getByText('Tự duyệt đơn của mình')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Half' })).queryByText('Tự duyệt đơn của mình'),
    ).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Denied' })).queryByText('Tự duyệt đơn của mình'),
    ).toBeNull();
  });
});

describe('deleting a runtime role', () => {
  it('offers delete only on a runtime role nobody holds', async () => {
    const held = { ...matrix.roles[2]!, key: 'custom.held', label: 'Held', holders: 2 };
    setup({
      roles: vi.fn(() => Promise.resolve({ ...matrix, roles: [...matrix.roles, held] })),
    });
    expect(await screen.findByRole('button', { name: 'Xóa vai trò Helper' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Xóa vai trò Held' })).toBeDisabled();
    expect(
      within(screen.getByRole('region', { name: 'Held' })).getByText(/Đang có người giữ/),
    ).toBeInTheDocument();
  });

  it('deletes after a confirmation, then reloads the matrix; cancel does nothing', async () => {
    const user = userEvent.setup();
    const { administration } = setup();
    await user.click(await screen.findByRole('button', { name: 'Xóa vai trò Helper' }));
    let dialog = await screen.findByRole('dialog', { name: 'Xóa vai trò này?' });
    await user.click(within(dialog).getByRole('button', { name: 'Hủy' }));
    expect(administration.deleteRole).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Xóa vai trò Helper' }));
    dialog = await screen.findByRole('dialog', { name: 'Xóa vai trò này?' });
    await user.click(within(dialog).getByRole('button', { name: 'Xóa vai trò' }));
    await waitFor(() => expect(administration.deleteRole).toHaveBeenCalledWith('custom.helper'));
    await waitFor(() => expect(administration.roles).toHaveBeenCalledTimes(2));
  });

  it('shows the shared conflict text on 409 and the step-up wording on 403', async () => {
    const user = userEvent.setup();
    const deleteRole = vi
      .fn<AdministrationClient['deleteRole']>()
      .mockRejectedValueOnce(new ApiError(409, 'error.conflict'))
      .mockRejectedValueOnce(new ApiError(403, 'error.accessDenied'));
    setup({ deleteRole });
    for (const expected of [/vừa được người khác thay đổi/, /xác thực 2 lớp/]) {
      await user.click(await screen.findByRole('button', { name: 'Xóa vai trò Helper' }));
      const dialog = await screen.findByRole('dialog', { name: 'Xóa vai trò này?' });
      await user.click(within(dialog).getByRole('button', { name: 'Xóa vai trò' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(expected);
      await user.click(within(dialog).getByRole('button', { name: 'Hủy' }));
    }
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
    boundaries: [],
    truncated: false,
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

  it('warns in the account dialog when the answer was cut at a read limit', async () => {
    const user = userEvent.setup();
    withAccounts(() => Promise.resolve({ ...detail, truncated: true }));
    await user.click(await screen.findByRole('button', { name: 'Xem quyền an@example.test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Quyền của tài khoản' });
    expect(await within(dialog).findByRole('status')).toHaveTextContent('chưa đầy đủ');
  });

  it('shows no warning in the account dialog for a complete answer', async () => {
    const user = userEvent.setup();
    withAccounts(() => Promise.resolve(detail));
    await user.click(await screen.findByRole('button', { name: 'Xem quyền an@example.test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Quyền của tài khoản' });
    await within(dialog).findByText('Employee');
    expect(within(dialog).queryByRole('status')).toBeNull();
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
