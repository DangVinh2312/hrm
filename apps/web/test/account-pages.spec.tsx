import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { routes } from '../src/app';
import type { OwnAccount } from '../src/features/account/account.client';
import { ApiError, ResponseShapeError } from '../src/infrastructure/http.client';
import { fakeAccount, fakeAuth, fakeServices, renderRoutes } from './render.helper';

const user = { userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11', method: 'oidc', assurance: 'oidc' };
const google = 'https://accounts.google.com';
const reference = '0b6f2d1e-8c4a-4f7b-9d3e-2a5c7e9f1b40';
const page = '/account/sign-in-methods';

const own = (identities: OwnAccount['identities']): OwnAccount => ({
  email: 'person@example.test',
  identities,
  mfa: { status: 'none', recoveryCodesRemaining: 0 },
});

const signedIn = (overrides = {}) =>
  fakeAuth({ session: () => Promise.resolve(user), ...overrides });

describe('sign-in methods page', () => {
  it('is reachable from the sidebar of every signed-in user', async () => {
    const { router } = renderRoutes(routes, signedIn(), '/');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    await userEvent.click(await within(nav).findByRole('link', { name: 'Phương thức đăng nhập' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(page));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Phương thức đăng nhập' }),
    ).toBeInTheDocument();
  });

  it('shows the one Google account by short reference, read only', async () => {
    const account = fakeAccount({
      account: () => Promise.resolve(own([{ issuer: google, reference }])),
    });
    renderRoutes(routes, signedIn(), page, {}, fakeServices(), account);
    expect(await screen.findByText('Google')).toBeInTheDocument();
    expect(screen.getByText('0b6f2d1e')).toBeInTheDocument();
    expect(screen.queryByText(reference)).toBeNull();
    expect(screen.getByText('person@example.test')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Mỗi tài khoản HRM dùng đúng một tài khoản Google. Muốn đổi sang tài khoản Google khác, hãy liên hệ quản trị hệ thống.',
      ),
    ).toBeInTheDocument();
    // No password row (no local credential exists), nothing to link or remove.
    expect(screen.queryByText('Mật khẩu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gỡ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Liên kết thêm' })).toBeNull();
  });

  it('ignores the link parameters of the removed link flow', async () => {
    for (const search of ['?link=confirm', '?link=failed']) {
      const { unmount } = renderRoutes(
        routes,
        signedIn(),
        page + search,
        {},
        fakeServices(),
        fakeAccount(),
      );
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Phương thức đăng nhập' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Xác nhận' })).toBeNull();
      unmount();
    }
  });

  it('shows an empty state without a Google account and a retryable error', async () => {
    const { unmount } = renderRoutes(routes, signedIn(), page, {}, fakeServices(), fakeAccount());
    expect(await screen.findByText('Chưa có tài khoản Google nào.')).toBeInTheDocument();
    unmount();
    renderRoutes(
      routes,
      signedIn(),
      page,
      {},
      fakeServices(),
      fakeAccount({ account: () => Promise.reject(new ApiError(403, 'error.accessDenied')) }),
    );
    expect(await screen.findByText('Không tải được dữ liệu')).toBeInTheDocument();
    expect(screen.getByText(/Không thực hiện được thao tác này/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  });

  it('treats a response that breaks the contract as unavailable', async () => {
    renderRoutes(
      routes,
      signedIn(),
      page,
      {},
      fakeServices(),
      fakeAccount({ account: () => Promise.reject(new ResponseShapeError()) }),
    );
    expect(await screen.findByText(/Hệ thống tạm thời không phản hồi/)).toBeInTheDocument();
  });
});

describe('login notices and locale', () => {
  it('shows no notice for the parameters of the removed link and unlink flows', async () => {
    for (const search of ['?linked=1', '?unlinked=1']) {
      const { unmount } = renderRoutes(routes, fakeAuth(), `/login${search}`);
      await screen.findByRole('button', { name: 'Đăng nhập bằng Google' });
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      unmount();
    }
  });

  it('renders the page in English', async () => {
    const account = fakeAccount({
      account: () => Promise.resolve(own([{ issuer: google, reference }])),
    });
    renderRoutes(routes, signedIn(), page, { locale: 'en' }, fakeServices(), account);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign-in methods' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Reference code')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Google account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
