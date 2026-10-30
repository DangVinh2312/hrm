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
import { fakeAuth, fakeServices, renderRoutes } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const accountId = '11111111-1111-4111-8111-111111111111';
const grant = (permission: string, template: string, effect: 'allow' | 'deny' = 'allow') => ({
  permission,
  effect,
  template,
  version: 1,
  parameters: {},
});
const matrix: RoleMatrix = {
  roles: [
    { key: 'hr.admin', label: 'Admin', source: 'code', holders: 1, grants: [] },
    { key: 'hr.employee', label: 'Employee', source: 'code', holders: 3, grants: [] },
    {
      key: 'custom.approver',
      label: 'Approver',
      source: 'runtime',
      holders: 0,
      grants: [
        grant('hrCompany.approvals', 'company'),
        grant('workRequest.decideFinal', 'finalQueue'),
      ],
    },
  ],
  truncated: false,
};
const packagePermissions = [
  'account.assignRole',
  'account.bindBoundary',
  'account.provision',
  'account.reactivate',
  'account.revokeRole',
  'account.suspend',
  'account.unbindBoundary',
  'role.delete',
  'role.update',
];
const bound = (permissions: string[], seeded = false) =>
  permissions.map((permission) => ({
    permission,
    key: 'accountAdministration',
    version: 1,
    seeded,
  }));
const detail = (patch: Partial<AccountPermissions> = {}): AccountPermissions => ({
  roles: [{ key: 'hr.employee', label: 'Employee', source: 'code' }],
  grants: [],
  boundaries: [],
  truncated: false,
  ...patch,
});

type Spies = { [K in keyof AdministrationClient]: Mock<AdministrationClient[K]> };

function setup(overrides: Partial<Spies> = {}) {
  const administration: Spies = {
    list: vi.fn<AdministrationClient['list']>(() =>
      Promise.resolve({
        items: [{ userId: accountId, email: 'an@example.test', state: 'active', enrollment: null }],
        total: '1',
      }),
    ),
    provision: vi.fn<AdministrationClient['provision']>(() =>
      Promise.reject(new ApiError(404, 'error.notFound')),
    ),
    suspend: vi.fn<AdministrationClient['suspend']>(() => Promise.resolve()),
    reactivate: vi.fn<AdministrationClient['reactivate']>(() => Promise.resolve()),
    roles: vi.fn<AdministrationClient['roles']>(() => Promise.resolve(matrix)),
    accountPermissions: vi.fn<AdministrationClient['accountPermissions']>(() =>
      Promise.resolve(detail()),
    ),
    assignRole: vi.fn<AdministrationClient['assignRole']>(() => Promise.resolve()),
    revokeRole: vi.fn<AdministrationClient['revokeRole']>(() => Promise.resolve()),
    bindBoundary: vi.fn<AdministrationClient['bindBoundary']>(() => Promise.resolve()),
    unbindBoundary: vi.fn<AdministrationClient['unbindBoundary']>(() => Promise.resolve()),
    deleteRole: vi.fn<AdministrationClient['deleteRole']>(() => Promise.resolve()),
    ...overrides,
  };
  const view = renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    '/accounts',
    {},
    fakeServices({
      viewer: { userId: session.userId, menus: ['accounts'], employee: null, companyScope: false },
      administration,
    }),
  );
  return { administration, ...view };
}

async function openDialog() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Xem quyền an@example.test' }));
  const dialog = await screen.findByRole('dialog', { name: 'Quyền của tài khoản' });
  await within(dialog).findByText('Employee');
  return { user, dialog };
}

describe('roles of one account in the account dialog', () => {
  it('revokes a held role only after a confirmation, then reloads the dialog', async () => {
    const { administration } = setup();
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Thu hồi Employee' }));
    expect(administration.revokeRole).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Hủy' }));
    expect(administration.revokeRole).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Thu hồi Employee' }));
    expect(within(dialog).getByText('Thu hồi vai trò này?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Thu hồi vai trò' }));
    await waitFor(() =>
      expect(administration.revokeRole).toHaveBeenCalledWith(accountId, 'hr.employee'),
    );
    await waitFor(() => expect(administration.accountPermissions).toHaveBeenCalledTimes(2));
  });

  it('assigns a role chosen from the roles the caller can read, leaving out roles already held', async () => {
    const { administration } = setup();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('combobox', { name: 'Vai trò cần gán' }));
    const options = await screen.findAllByRole('option', { hidden: true });
    expect(options.map((option) => option.textContent)).toEqual(['Admin', 'Approver']);
    await user.click(options[0] as HTMLElement);
    await user.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));
    await waitFor(() =>
      expect(administration.assignRole).toHaveBeenCalledWith(accountId, 'hr.admin'),
    );
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Đã gán vai trò');
    await waitFor(() => expect(administration.accountPermissions).toHaveBeenCalledTimes(2));
  });

  it('warns that a role with both approval permissions lets its holder approve their own requests', async () => {
    const { administration } = setup();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('combobox', { name: 'Vai trò cần gán' }));
    const options = await screen.findAllByRole('option', { hidden: true });
    expect(within(dialog).queryByText(/tự duyệt đơn của chính mình/)).toBeNull();
    await user.click(options[1] as HTMLElement);
    expect(await within(dialog).findByText(/tự duyệt đơn của chính mình/)).toBeInTheDocument();
    // The warning does not block: the API decides.
    await user.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));
    await waitFor(() =>
      expect(administration.assignRole).toHaveBeenCalledWith(accountId, 'custom.approver'),
    );
  });

  it('assigns nothing until a role is chosen', async () => {
    const { administration } = setup();
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: 'Gán vai trò' }));
    expect(administration.assignRole).not.toHaveBeenCalled();
  });

  it('shows the shared failure text for a 409 and the step-up wording for a 403', async () => {
    const assignRole = vi
      .fn<AdministrationClient['assignRole']>()
      .mockRejectedValueOnce(new ApiError(409, 'error.conflict'))
      .mockRejectedValueOnce(new ApiError(403, 'error.accessDenied'));
    setup({ assignRole });
    const { user, dialog } = await openDialog();
    for (const expected of [/vừa được người khác thay đổi/, /xác thực 2 lớp/]) {
      await user.click(await within(dialog).findByRole('combobox', { name: 'Vai trò cần gán' }));
      const options = await screen.findAllByRole('option', { hidden: true });
      await user.click(options[0] as HTMLElement);
      await user.click(within(dialog).getByRole('button', { name: 'Gán vai trò' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(expected);
    }
  });

  it('says so when the role list cannot be read and offers no role to assign', async () => {
    setup({ roles: vi.fn(() => Promise.reject(new ApiError(404, 'error.notFound'))) });
    const { dialog } = await openDialog();
    expect(await within(dialog).findByText(/Không tải được danh sách vai trò/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Gán vai trò' })).toBeNull();
  });
});

describe('the caller own row', () => {
  it('shows roles and binding as text without any write control', async () => {
    const own = {
      userId: session.userId,
      email: 'me@example.test',
      state: 'active' as const,
      enrollment: null,
    };
    setup({
      list: vi.fn(() => Promise.resolve({ items: [own], total: '1' })),
      accountPermissions: vi.fn(() =>
        Promise.resolve(detail({ boundaries: bound(packagePermissions) })),
      ),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Xem quyền me@example.test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Quyền của tài khoản' });
    await within(dialog).findByText('Employee');
    expect(within(dialog).queryByRole('button', { name: /^Thu hồi / })).toBeNull();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Gỡ gói' })).toBeNull();
    expect(within(dialog).getByText('Đã bật')).toBeInTheDocument();
  });
});

describe('administration package binding in the account dialog', () => {
  it('says the package is off when nothing is bound, and binds it with the fixed reference', async () => {
    const { administration } = setup();
    const { user, dialog } = await openDialog();
    const section = within(dialog).getByRole('region', { name: 'Gói quyền quản trị' });
    expect(within(section).getByText('Chưa bật')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Gỡ gói' })).toBeNull();
    await user.click(within(section).getByRole('button', { name: 'Bật gói' }));
    await waitFor(() =>
      expect(administration.bindBoundary).toHaveBeenCalledWith(accountId, {
        key: 'accountAdministration',
        version: 1,
      }),
    );
    await waitFor(() => expect(administration.accountPermissions).toHaveBeenCalledTimes(2));
  });

  it('shows a fully bound package and unbinds it only after a confirmation', async () => {
    const { administration } = setup({
      accountPermissions: vi.fn(() =>
        Promise.resolve(detail({ boundaries: bound(packagePermissions) })),
      ),
    });
    const { user, dialog } = await openDialog();
    const section = within(dialog).getByRole('region', { name: 'Gói quyền quản trị' });
    expect(within(section).getByText('Đã bật')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Bật gói' })).toBeNull();
    await user.click(within(section).getByRole('button', { name: 'Gỡ gói' }));
    expect(administration.unbindBoundary).not.toHaveBeenCalled();
    await user.click(within(section).getByRole('button', { name: 'Gỡ gói quyền' }));
    await waitFor(() =>
      expect(administration.unbindBoundary).toHaveBeenCalledWith(accountId, {
        key: 'accountAdministration',
        version: 1,
      }),
    );
  });

  it('names what is missing when only part is bound and offers no bind, since the API refuses a bind over any bound permission', async () => {
    setup({
      accountPermissions: vi.fn(() =>
        Promise.resolve(detail({ boundaries: bound(['account.suspend', 'role.delete']) })),
      ),
    });
    const { dialog } = await openDialog();
    const section = within(dialog).getByRole('region', { name: 'Gói quyền quản trị' });
    expect(within(section).getByText('Bật một phần')).toBeInTheDocument();
    expect(within(section).getByText(/account\.assignRole/)).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Bật gói' })).toBeNull();
  });

  it('offers no unbind for bindings the system owns, and spells that out', async () => {
    setup({
      accountPermissions: vi.fn(() =>
        Promise.resolve(detail({ boundaries: bound(packagePermissions, true) })),
      ),
    });
    const { dialog } = await openDialog();
    const section = within(dialog).getByRole('region', { name: 'Gói quyền quản trị' });
    expect(within(section).getByText('Đã bật')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Gỡ gói' })).toBeNull();
    expect(within(section).getAllByText(/do hệ thống cấp/).length).toBeGreaterThan(0);
  });

  it('lists a binding to another package without treating it as this one', async () => {
    setup({
      accountPermissions: vi.fn(() =>
        Promise.resolve(
          detail({
            boundaries: [
              { permission: 'team.assign', key: 'hrAdministration', version: 1, seeded: true },
            ],
          }),
        ),
      ),
    });
    const { dialog } = await openDialog();
    const section = within(dialog).getByRole('region', { name: 'Gói quyền quản trị' });
    expect(within(section).getByText('Chưa bật')).toBeInTheDocument();
    expect(within(section).getByText(/team\.assign · hrAdministration@1/)).toBeInTheDocument();
  });

  it('shows a 409 from a bind as the shared conflict text', async () => {
    setup({
      bindBoundary: vi.fn(() => Promise.reject(new ApiError(409, 'error.conflict'))),
    });
    const { user, dialog } = await openDialog();
    await user.click(await within(dialog).findByRole('button', { name: 'Bật gói' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /vừa được người khác thay đổi/,
    );
  });
});
