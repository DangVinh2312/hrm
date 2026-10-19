import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import { tokenFromHash } from '../src/auth/activate.page';
import { ApiError } from '../src/infrastructure/http.client';
import { navigateToExternal } from '../src/infrastructure/external-navigation.helper';
import { fakeAuth, renderRoutes } from './render.helper';

vi.mock('../src/infrastructure/external-navigation.helper', () => ({
  navigateToExternal: vi.fn(),
}));

const token = 'A'.repeat(20) + 'b_-'.repeat(7) + 'zz';
const user = { userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11', method: 'oidc', assurance: 'oidc' };

afterEach(() => {
  vi.mocked(navigateToExternal).mockReset();
  window.history.replaceState(null, '', '/');
});

describe('login', () => {
  it('redirects a signed-out visitor to /login and starts Google sign-in', async () => {
    const beginLogin = vi.fn(() => Promise.resolve('https://accounts.google.com/auth?state=s'));
    const { router } = renderRoutes(routes, fakeAuth({ beginLogin }), '/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    const google = await screen.findByRole('button', { name: 'Đăng nhập bằng Google' });
    expect(screen.queryByLabelText(/mật khẩu/i)).toBeNull();
    await userEvent.click(google);
    await waitFor(() =>
      expect(navigateToExternal).toHaveBeenCalledWith('https://accounts.google.com/auth?state=s'),
    );
    expect(beginLogin).toHaveBeenCalledTimes(1);
  });

  it('shows a generic message after a failed callback and when sign-in cannot start', async () => {
    renderRoutes(
      routes,
      fakeAuth({ beginLogin: () => Promise.reject(new ApiError(503)) }),
      '/login?error=oidc',
    );
    expect(await screen.findByText('Đăng nhập không thành công')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập bằng Google' }));
    expect(await screen.findByText('Không bắt đầu được đăng nhập')).toBeInTheDocument();
    expect(screen.getByText(/Hệ thống tạm thời không phản hồi/)).toBeInTheDocument();
    expect(navigateToExternal).not.toHaveBeenCalled();
  });

  it('sends a signed-in user from /login to the home page', async () => {
    const { router } = renderRoutes(
      routes,
      fakeAuth({ session: () => Promise.resolve(user) }),
      '/login',
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByText('Bạn đã đăng nhập.')).toBeInTheDocument();
  });

  it('does not treat a server failure as signed out', async () => {
    const { router } = renderRoutes(
      routes,
      fakeAuth({ session: () => Promise.reject(new ApiError(503)) }),
      '/',
    );
    expect(await screen.findByText('Không kết nối được máy chủ')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('activation', () => {
  it('reads #token once, removes it from the address bar and activates with Google', async () => {
    window.history.replaceState(null, '', `/activate#token=${token}`);
    const beginActivation = vi.fn(() =>
      Promise.resolve('https://accounts.google.com/auth?state=a'),
    );
    renderRoutes(routes, fakeAuth({ beginActivation }), '/activate');
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.href).not.toContain(token);
    expect(screen.getByLabelText('Mã kích hoạt')).toHaveValue(token);
    await userEvent.click(screen.getByRole('button', { name: 'Kích hoạt bằng Google' }));
    await waitFor(() => expect(beginActivation).toHaveBeenCalledWith(token));
    expect(navigateToExternal).toHaveBeenCalledWith('https://accounts.google.com/auth?state=a');
  });

  it('validates a pasted code and explains a rejected one', async () => {
    const beginActivation = vi.fn(() => Promise.reject(new ApiError(401)));
    renderRoutes(routes, fakeAuth({ beginActivation }), '/activate');
    const input = screen.getByLabelText('Mã kích hoạt');
    await userEvent.type(input, 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Kích hoạt bằng Google' }));
    expect(await screen.findByText('Mã kích hoạt không đúng định dạng')).toBeInTheDocument();
    expect(beginActivation).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, ` ${token} `);
    await userEvent.click(screen.getByRole('button', { name: 'Kích hoạt bằng Google' }));
    expect(await screen.findByText(/không hợp lệ hoặc đã hết hạn/)).toBeInTheDocument();
    expect(beginActivation).toHaveBeenCalledWith(token);
    expect(navigateToExternal).not.toHaveBeenCalled();
  });

  it('ignores malformed fragments', () => {
    expect(tokenFromHash(`#token=${token}`)).toBe(token);
    for (const hash of ['', '#token=', '#token=abc', `#other=${token}`, `#token=${token}x`])
      expect(tokenFromHash(hash)).toBe('');
  });
});
