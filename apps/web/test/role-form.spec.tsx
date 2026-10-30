import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type {
  AdministrationClient,
  RoleMatrix,
  RoleRow,
} from '../src/features/administration/administration.client';
import { ApiError } from '../src/infrastructure/http.client';
import { fakeAuth, fakeServices, renderRoutes } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const digest = 'a'.repeat(64);
const pair = (permission: string, key: string) => ({ permission, template: { key, version: 1 } });
const rule = (permission: string, template: string, extra = {}) => ({
  permission,
  effect: 'allow' as const,
  template,
  version: 1,
  parameters: {},
  ...extra,
});
const catalog = [
  pair('employee.read', 'allEmployees'),
  pair('employee.update', 'allEmployees'),
  pair('hrCompany.approvals', 'company'),
  pair('team.read', 'allTeams'),
  pair('workRequest.decideFinal', 'finalQueue'),
];
const helper: RoleRow = {
  key: 'custom.helper',
  label: 'Helper',
  source: 'runtime',
  holders: 0,
  digest,
  capabilities: [],
  grants: [rule('employee.read', 'allEmployees'), rule('team.read', 'allTeams')],
};
const matrix: RoleMatrix = {
  roles: [
    { ...helper, key: 'hr.admin', label: 'Admin', source: 'code' },
    helper,
    {
      ...helper,
      key: 'custom.denies',
      label: 'Denies',
      grants: [rule('employee.read', 'allEmployees', { effect: 'deny' })],
    },
  ],
  catalog,
  truncated: false,
};
const written = { key: 'custom.qa_lead', digest: 'b'.repeat(64) };

function setup(overrides: Partial<AdministrationClient> = {}, data: RoleMatrix = matrix) {
  const administration = {
    roles: vi.fn<AdministrationClient['roles']>(() => Promise.resolve(data)),
    createRole: vi.fn<AdministrationClient['createRole']>(() => Promise.resolve(written)),
    updateRole: vi.fn<AdministrationClient['updateRole']>(() => Promise.resolve(written)),
    ...overrides,
  };
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    '/roles',
    {},
    fakeServices({
      viewer: { userId: session.userId, menus: ['roles'], employee: null, companyScope: false },
      administration,
    }),
  );
  return administration;
}

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Tạo vai trò' }));
  return screen.findByRole('dialog', { name: 'Tạo vai trò mới' });
}

describe('role capabilities on the matrix', () => {
  it('names every capability the API reports, and none it does not', async () => {
    const all = {
      ...helper,
      capabilities: [
        'selfApproval',
        'requestDecision',
        'selfAdjustment',
        'employeeWrite',
        'accountLink',
        'accountAdministration',
      ] as RoleRow['capabilities'],
    };
    setup({}, { ...matrix, roles: [all, { ...helper, key: 'custom.plain', label: 'Plain' }] });
    const card = await screen.findByRole('region', { name: 'Helper' });
    for (const label of [
      'Tự duyệt đơn của mình',
      'Duyệt hoặc hủy đơn',
      'Tự điều chỉnh phép, công',
      'Sửa hồ sơ nhân viên',
      'Liên kết tài khoản và nhóm',
      'Quản trị tài khoản',
    ])
      expect(within(card).getByText(label)).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Plain' })).queryByText('Quản trị tài khoản'),
    ).toBeNull();
  });
});

describe('creating a runtime role', () => {
  it('opens a dialog with the name rule, the key preview and the catalog grouped by resource', async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Tên vai trò'), 'qa_lead');
    expect(within(dialog).getByText('custom.qa_lead')).toBeInTheDocument();
    const employee = within(dialog).getByRole('group', { name: 'employee' });
    expect(
      within(employee).getByRole('checkbox', { name: 'read · allEmployees' }),
    ).not.toBeChecked();
    expect(
      within(employee).getByRole('checkbox', { name: 'update · allEmployees' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'team' })).toBeInTheDocument();
    expect(within(dialog).getByText('Đã chọn: 0 / 300')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('searches the catalog and keeps hidden choices selected', async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await openCreate(user);
    await user.click(within(dialog).getByRole('checkbox', { name: 'read · allEmployees' }));
    await user.type(within(dialog).getByLabelText('Tìm quyền'), 'team');
    expect(within(dialog).queryByRole('group', { name: 'employee' })).toBeNull();
    expect(within(dialog).getByRole('checkbox', { name: 'read · allTeams' })).toBeInTheDocument();
    expect(within(dialog).getByText('Đã chọn: 1 / 300')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Tìm quyền'));
    await user.type(within(dialog).getByLabelText('Tìm quyền'), 'zzz');
    expect(within(dialog).getByText('Không có quyền nào khớp.')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Tìm quyền'));
    expect(within(dialog).getByRole('checkbox', { name: 'read · allEmployees' })).toBeChecked();
  });

  it('refuses an invalid name or label before any request', async () => {
    const user = userEvent.setup();
    const administration = setup();
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Tên vai trò'), 'Qa-Lead');
    await user.click(within(dialog).getByRole('button', { name: 'Tiếp tục' }));
    expect(within(dialog).getByText(/Tên chỉ gồm chữ thường/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Tên hiển thị dài 1 đến 120/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: 'Tạo vai trò này?' })).toBeNull();
    expect(administration.createRole).not.toHaveBeenCalled();
  });

  it('confirms, sends custom.<name> with the chosen pairs, then reloads the matrix', async () => {
    const user = userEvent.setup();
    const administration = setup();
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Tên vai trò'), 'qa_lead');
    await user.type(within(dialog).getByLabelText('Tên hiển thị'), '  Trưởng QA ');
    await user.click(within(dialog).getByRole('checkbox', { name: 'update · allEmployees' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'read · allEmployees' }));
    await user.click(within(dialog).getByRole('button', { name: 'Tiếp tục' }));
    const confirm = await within(dialog).findByRole('group', { name: 'Tạo vai trò này?' });
    expect(within(confirm).getByText('Trưởng QA')).toBeInTheDocument();
    expect(administration.createRole).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Tạo vai trò' }));
    await waitFor(() =>
      expect(administration.createRole).toHaveBeenCalledWith({
        key: 'custom.qa_lead',
        label: 'Trưởng QA',
        grants: [pair('employee.read', 'allEmployees'), pair('employee.update', 'allEmployees')],
      }),
    );
    await waitFor(() => expect(administration.roles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('status')).toHaveTextContent('Đã tạo vai trò.');
  });

  it('can go back from the confirmation without sending', async () => {
    const user = userEvent.setup();
    const administration = setup();
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Tên vai trò'), 'qa_lead');
    await user.type(within(dialog).getByLabelText('Tên hiển thị'), 'QA');
    await user.click(within(dialog).getByRole('button', { name: 'Tiếp tục' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Hủy' }));
    expect(within(dialog).getByLabelText('Tên vai trò')).toHaveValue('qa_lead');
    expect(administration.createRole).not.toHaveBeenCalled();
  });

  it('warns about the self-approval pair and blocks approvals without a final decision', async () => {
    const user = userEvent.setup();
    const administration = setup();
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Tên vai trò'), 'qa_lead');
    await user.type(within(dialog).getByLabelText('Tên hiển thị'), 'QA');
    await user.click(within(dialog).getByRole('checkbox', { name: 'approvals · company' }));
    await user.click(within(dialog).getByRole('button', { name: 'Tiếp tục' }));
    expect(within(dialog).getByText(/phải đi kèm quyền duyệt cuối/)).toBeInTheDocument();
    expect(administration.createRole).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole('group', { name: 'Tạo vai trò này?' })).toBeNull();
    await user.click(within(dialog).getByRole('checkbox', { name: 'decideFinal · finalQueue' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent(/tự duyệt đơn của chính mình/);
    await user.click(within(dialog).getByRole('button', { name: 'Tiếp tục' }));
    expect(
      await within(dialog).findByRole('group', { name: 'Tạo vai trò này?' }),
    ).toBeInTheDocument();
  });

  it('sends once while the request is pending and never retries a failure', async () => {
    const user = userEvent.setup();
    let reject: (error: unknown) => void = () => undefined;
    const createRole = vi.fn<AdministrationClient['createRole']>(
      () => new Promise((_resolve, fail) => (reject = fail)),
    );
    setup({ createRole });
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Tên vai trò'), 'qa_lead');
    await user.type(within(dialog).getByLabelText('Tên hiển thị'), 'QA');
    await user.click(within(dialog).getByRole('button', { name: 'Tiếp tục' }));
    const confirm = await within(dialog).findByRole('group', { name: 'Tạo vai trò này?' });
    const submit = within(confirm).getByRole('button', { name: 'Tạo vai trò' });
    await user.click(submit);
    await user.click(submit);
    expect(createRole).toHaveBeenCalledTimes(1);
    reject(new ApiError(403, 'error.accessDenied'));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/xác thực 2 lớp/);
    expect(createRole).toHaveBeenCalledTimes(1);
  });

  it('shows the shared conflict text when the key is taken', async () => {
    const user = userEvent.setup();
    setup({ createRole: vi.fn(() => Promise.reject(new ApiError(409, 'error.conflict'))) });
    const dialog = await openCreate(user);
    await user.type(within(dialog).getByLabelText('Tên vai trò'), 'qa_lead');
    await user.type(within(dialog).getByLabelText('Tên hiển thị'), 'QA');
    await user.click(within(dialog).getByRole('button', { name: 'Tiếp tục' }));
    const confirm = await within(dialog).findByRole('group', { name: 'Tạo vai trò này?' });
    await user.click(within(confirm).getByRole('button', { name: 'Tạo vai trò' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/bị trùng/);
  });
});

describe('editing a runtime role', () => {
  it('offers edit only on a runtime role made of plain allow rules', async () => {
    setup();
    expect(await screen.findByRole('button', { name: 'Sửa vai trò Helper' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Sửa vai trò Admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sửa vai trò Denies' })).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Denies' })).getByText(/chưa sửa được ở đây/),
    ).toBeInTheDocument();
  });

  it('has no edit button when the matrix was cut', async () => {
    setup({}, { ...matrix, truncated: true });
    await screen.findByRole('region', { name: 'Helper' });
    expect(screen.queryByRole('button', { name: 'Sửa vai trò Helper' })).toBeNull();
  });

  it('starts from the stored label and rules, with no name field, and sends the digest it read', async () => {
    const user = userEvent.setup();
    const administration = setup();
    await user.click(await screen.findByRole('button', { name: 'Sửa vai trò Helper' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa vai trò' });
    expect(within(dialog).queryByLabelText('Tên vai trò')).toBeNull();
    expect(within(dialog).getByLabelText('Tên hiển thị')).toHaveValue('Helper');
    expect(within(dialog).getByRole('checkbox', { name: 'read · allEmployees' })).toBeChecked();
    expect(
      within(dialog).getByRole('checkbox', { name: 'update · allEmployees' }),
    ).not.toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: 'update · allEmployees' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'read · allTeams' }));
    await user.click(within(dialog).getByRole('button', { name: 'Tiếp tục' }));
    const confirm = await within(dialog).findByRole('group', { name: 'Lưu thay đổi vai trò?' });
    await user.click(within(confirm).getByRole('button', { name: 'Lưu vai trò' }));
    await waitFor(() =>
      expect(administration.updateRole).toHaveBeenCalledWith('custom.helper', {
        label: 'Helper',
        grants: [pair('employee.read', 'allEmployees'), pair('employee.update', 'allEmployees')],
        expectedDigest: digest,
      }),
    );
    await waitFor(() => expect(administration.roles).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('status')).toHaveTextContent('Đã lưu vai trò.');
  });

  it('on 409 closes the form, says the role changed and reloads the matrix', async () => {
    const user = userEvent.setup();
    const administration = setup({
      updateRole: vi.fn(() => Promise.reject(new ApiError(409, 'error.conflict'))),
    });
    await user.click(await screen.findByRole('button', { name: 'Sửa vai trò Helper' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa vai trò' });
    await user.click(within(dialog).getByRole('button', { name: 'Tiếp tục' }));
    const confirm = await within(dialog).findByRole('group', { name: 'Lưu thay đổi vai trò?' });
    await user.click(within(confirm).getByRole('button', { name: 'Lưu vai trò' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('vừa được người khác thay đổi');
    await waitFor(() => expect(administration.roles).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(administration.updateRole).toHaveBeenCalledTimes(1);
  });

  it('disables unchecked boxes at the grant limit', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 301 }, (_, i) => pair(`employee.a${i}`, 'allEmployees'));
    const full = {
      ...helper,
      grants: many.slice(0, 300).map((p) => rule(p.permission, 'allEmployees')),
    };
    setup({}, { ...matrix, roles: [full], catalog: many });
    await user.click(await screen.findByRole('button', { name: 'Sửa vai trò Helper' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa vai trò' });
    expect(within(dialog).getByText('Đã chọn: 300 / 300')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'a300 · allEmployees' })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'a0 · allEmployees' })).toBeEnabled();
  }, 60000);
});
