import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { routes } from '../src/app';
import type {
  AdministrationClient,
  AccountRow,
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
  menus: ['accounts'],
  employee: null,
  companyScope: false,
};
const row = (patch: Partial<AccountRow> & { userId: string }): AccountRow => ({
  email: null,
  state: 'active',
  enrollment: null,
  ...patch,
});
const rows = {
  self: row({ userId: session.userId, email: 'me@example.test' }),
  active: row({ userId: '11111111-1111-4111-8111-111111111111', email: 'active@example.test' }),
  suspended: row({
    userId: '22222222-2222-4222-8222-222222222222',
    email: 'suspended@example.test',
    state: 'suspended',
  }),
  expired: row({
    userId: '33333333-3333-4333-8333-333333333333',
    email: 'expired@example.test',
    state: 'pending',
    enrollment: 'expired',
  }),
};

/** Every client method as a spy, so assertions never read an unbound method. */
type Spies = { [K in keyof AdministrationClient]: Mock<AdministrationClient[K]> };

function setup(
  overrides: Partial<Spies> = {},
  menus: Viewer['menus'] = ['accounts'],
  entry = '/accounts',
) {
  const administration: Spies = {
    list: vi.fn<AdministrationClient['list']>(() =>
      Promise.resolve({ items: Object.values(rows), total: '4' }),
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

describe('accounts page', () => {
  it('lists accounts with state text, one h1, and no actions on the caller own row', async () => {
    setup();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Quản lý tài khoản' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const table = await screen.findByRole('table');
    const own = within(table).getByRole('row', { name: /me@example\.test/ });
    // The caller may look at their own permissions but can neither suspend nor restore themself.
    expect(within(own).queryByRole('button', { name: /^(Khóa|Khôi phục) / })).toBeNull();
    expect(within(own).getByRole('button', { name: /^Xem quyền / })).toBeInTheDocument();
    expect(within(own).getByText('Đang hoạt động')).toBeInTheDocument();
    expect(within(table).getByText('Đã khóa')).toBeInTheDocument();
    expect(
      within(table).getByRole('button', { name: 'Khóa active@example.test' }),
    ).toBeInTheDocument();
    expect(
      within(table).queryByRole('button', { name: 'Khôi phục active@example.test' }),
    ).toBeNull();
    expect(
      within(table).getByRole('button', { name: 'Khôi phục suspended@example.test' }),
    ).toBeInTheDocument();
    // A pending account whose invitation expired cannot sign in: say so.
    expect(within(table).getByText('Đã hết hạn')).toBeInTheDocument();
  });

  it('is "not found" without the accounts menu and asks the API for nothing', async () => {
    const { administration } = setup({}, ['reports']);
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
    expect(administration.list).not.toHaveBeenCalled();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).queryByRole('link', { name: 'Tài khoản' })).toBeNull();
  });

  it('shows the Tài khoản menu link when the server grants accounts', async () => {
    setup({}, ['accounts'], '/');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByRole('link', { name: 'Tài khoản' })).toHaveAttribute(
      'href',
      '/accounts',
    );
  });

  it('suspends after a confirmation, then reloads the list', async () => {
    const user = userEvent.setup();
    const { administration } = setup();
    await user.click(await screen.findByRole('button', { name: 'Khóa active@example.test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Khóa tài khoản này?' });
    expect(administration.suspend).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Khóa tài khoản' }));
    await waitFor(() =>
      expect(administration.suspend).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111'),
    );
    await waitFor(() => expect(administration.list).toHaveBeenCalledTimes(2));
  });

  it('restores a suspended account after a confirmation; cancel does nothing', async () => {
    const user = userEvent.setup();
    const { administration } = setup();
    await user.click(
      await screen.findByRole('button', { name: 'Khôi phục suspended@example.test' }),
    );
    let dialog = await screen.findByRole('dialog', { name: 'Khôi phục tài khoản này?' });
    await user.click(within(dialog).getByRole('button', { name: 'Hủy' }));
    expect(administration.reactivate).not.toHaveBeenCalled();
    await user.click(
      await screen.findByRole('button', { name: 'Khôi phục suspended@example.test' }),
    );
    dialog = await screen.findByRole('dialog', { name: 'Khôi phục tài khoản này?' });
    await user.click(within(dialog).getByRole('button', { name: 'Khôi phục' }));
    await waitFor(() =>
      expect(administration.reactivate).toHaveBeenCalledWith(
        '22222222-2222-4222-8222-222222222222',
      ),
    );
  });

  it('a 409 on restore shows the shared conflict text; a 403 offers the step-up wording', async () => {
    const user = userEvent.setup();
    const reactivate = vi
      .fn<AdministrationClient['reactivate']>()
      .mockRejectedValueOnce(new ApiError(409, 'error.conflict'))
      .mockRejectedValueOnce(new ApiError(403, 'error.accessDenied'));
    setup({ reactivate });
    for (const expected of [/vừa được người khác thay đổi/, /xác thực 2 lớp/]) {
      await user.click(
        await screen.findByRole('button', { name: 'Khôi phục suspended@example.test' }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Khôi phục tài khoản này?' });
      await user.click(within(dialog).getByRole('button', { name: 'Khôi phục' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(expected);
      await user.click(within(dialog).getByRole('button', { name: 'Hủy' }));
    }
  });

  it('adds an account by email; an invalid email is stopped before any request', async () => {
    const user = userEvent.setup();
    const provision = vi.fn<AdministrationClient['provision']>(() =>
      Promise.resolve({
        userId: '44444444-4444-4444-8444-444444444444',
        email: 'new@example.test',
        state: 'pending',
      }),
    );
    const { administration } = setup({ provision });
    const input = await screen.findByLabelText(/^Email/);
    await user.type(input, 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Cấp tài khoản' }));
    expect(provision).not.toHaveBeenCalled();
    expect(await screen.findByText('Nhập một địa chỉ email hợp lệ.')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, ' New@Example.test ');
    await user.click(screen.getByRole('button', { name: 'Cấp tài khoản' }));
    await waitFor(() => expect(provision).toHaveBeenCalledWith('new@example.test'));
    await waitFor(() => expect(administration.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Đã thêm tài khoản/)).toBeInTheDocument();
  });

  it('keeps the menus fresh for a minute instead of refetching on every focus (Q17)', async () => {
    const { queryClient } = setup({}, ['accounts'], '/');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    await waitFor(() => {
      const [query] = queryClient
        .getQueryCache()
        .findAll({ predicate: (q) => q.queryKey.join('/').endsWith('auth/me') });
      expect(query?.state.status).toBe('success');
      expect(query?.isStale()).toBe(false);
    });
  });
});
