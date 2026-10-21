import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { AccountClient, OwnAccount } from '../src/features/account/account.client';
import { ApiError } from '../src/infrastructure/http.client';
import { navigateToExternal } from '../src/infrastructure/external-navigation.helper';
import { fakeAccount, fakeAuth, fakeHr, renderRoutes } from './render.helper';

vi.mock('../src/infrastructure/external-navigation.helper', () => ({
  navigateToExternal: vi.fn(),
  reloadAt: vi.fn(),
}));

afterEach(() => vi.mocked(navigateToExternal).mockReset());

const user = { userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11', method: 'oidc', assurance: 'oidc' };
const page = '/account/sign-in-methods';
const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const codes = Array.from({ length: 10 }, (_, i) => `ABCD-EFGH-IJKL-MN${'ABCDEFGHIJ'[i]}A`);
const signedIn = (overrides = {}) =>
  fakeAuth({ session: () => Promise.resolve(user), ...overrides });

const own = (status: OwnAccount['mfa']['status'], remaining = 0): OwnAccount => ({
  email: 'person@example.test',
  identities: [],
  mfa: { status, recoveryCodesRemaining: remaining },
});

/** An account whose status follows the calls, like the server; spies returned as functions. */
function serverLike(overrides: Partial<AccountClient> = {}) {
  let status: OwnAccount['mfa']['status'] = 'none';
  let remaining = 0;
  const confirmMfa = vi.fn(() => {
    status = 'enabled';
    remaining = 10;
    return Promise.resolve(codes);
  });
  const removeMfa = vi.fn(() => {
    status = 'none';
    remaining = 0;
    return Promise.resolve();
  });
  const client = fakeAccount({
    account: () => Promise.resolve(own(status, remaining)),
    setupMfa: vi.fn(() => {
      status = 'pending';
      return Promise.resolve({
        uri: `otpauth://totp/HRM:person%40example.test?secret=${secret}&issuer=HRM&algorithm=SHA1&digits=6&period=30`,
        secret,
      });
    }),
    confirmMfa,
    removeMfa,
    ...overrides,
  });
  return { client, confirmMfa, removeMfa };
}

const card = async () =>
  (await screen.findByRole('heading', { level: 2, name: 'Xác thực 2 lớp' })).closest(
    '.mantine-Card-root',
  ) as HTMLElement;

describe('two-step verification on the sign-in methods page', () => {
  it('enrolls with QR and key, shows the recovery codes once, then shows the factor as on', async () => {
    const { client: account, confirmMfa } = serverLike();
    renderRoutes(routes, signedIn(), page, {}, fakeHr(), account);
    const section = await card();
    expect(within(section).getByText('Chưa bật')).toBeInTheDocument();
    await userEvent.click(
      within(section).getByRole('button', { name: 'Thiết lập xác thực 2 lớp' }),
    );
    expect(
      await within(section).findByRole('img', {
        name: 'Mã QR để thêm HRM vào ứng dụng xác thực',
      }),
    ).toBeInTheDocument();
    // The key is shown in groups of four for manual entry.
    expect(within(section).getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeVisible();
    const input = within(section).getByLabelText('Mã 6 chữ số');
    await userEvent.type(input, '12a');
    await userEvent.click(within(section).getByRole('button', { name: 'Bật xác thực 2 lớp' }));
    expect(await within(section).findByText('Nhập đúng 6 chữ số.')).toBeInTheDocument();
    expect(confirmMfa).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, '123456');
    await userEvent.click(within(section).getByRole('button', { name: 'Bật xác thực 2 lớp' }));
    expect(await within(section).findByRole('heading', { name: 'Mã khôi phục' })).toBeVisible();
    expect(confirmMfa).toHaveBeenCalledExactlyOnceWith('123456');
    for (const code of codes) expect(within(section).getByText(code)).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Sao chép mã' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Tải về' })).toBeInTheDocument();
    await userEvent.click(within(section).getByRole('button', { name: 'Tôi đã lưu các mã' }));
    await waitFor(() => expect(within(section).queryByText(codes[0] ?? '')).toBeNull());
    expect(await within(section).findByText('Đã bật')).toBeInTheDocument();
    expect(within(section).getByText('10')).toBeInTheDocument();
    expect(screen.queryByText(secret)).toBeNull();
  });

  it('keeps the setup open with a clear message when the code is refused', async () => {
    const { client: account } = serverLike({
      confirmMfa: () => Promise.reject(new ApiError(401, 'error.authenticationFailed')),
    });
    renderRoutes(routes, signedIn(), page, {}, fakeHr(), account);
    const section = await card();
    await userEvent.click(
      within(section).getByRole('button', { name: 'Thiết lập xác thực 2 lớp' }),
    );
    await userEvent.type(await within(section).findByLabelText('Mã 6 chữ số'), '000000');
    await userEvent.click(within(section).getByRole('button', { name: 'Bật xác thực 2 lớp' }));
    expect(
      await within(section).findByText(
        'Mã không đúng. Hãy kiểm tra giờ trên điện thoại và nhập mã mới.',
      ),
    ).toBeInTheDocument();
    expect(within(section).getByLabelText('Mã 6 chữ số')).toBeInTheDocument();
  });

  it('asks for a code when regenerating needs a step-up, then regenerates on the next try', async () => {
    let fresh = false;
    const verifyMfa = vi.fn(() => {
      fresh = true;
      return Promise.resolve();
    });
    const regenerateRecoveryCodes = vi.fn(() =>
      fresh ? Promise.resolve(codes) : Promise.reject(new ApiError(403, 'error.accessDenied')),
    );
    renderRoutes(
      routes,
      signedIn(),
      page,
      {},
      fakeHr(),
      fakeAccount({
        account: () => Promise.resolve(own('enabled', 3)),
        verifyMfa,
        regenerateRecoveryCodes,
      }),
    );
    const section = await card();
    expect(within(section).getByText('3')).toBeInTheDocument();
    await userEvent.click(within(section).getByRole('button', { name: 'Tạo mã khôi phục mới' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nhập mã xác thực' });
    await userEvent.type(within(dialog).getByLabelText('Mã 6 chữ số'), '654321');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác thực' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(verifyMfa).toHaveBeenCalledExactlyOnceWith({ code: '654321' });
    expect(
      await within(section).findByText('Đã xác thực. Hãy thực hiện lại thao tác trong 5 phút.'),
    ).toBeInTheDocument();
    // No automatic retry: the user repeats the action.
    expect(regenerateRecoveryCodes).toHaveBeenCalledTimes(1);
    await userEvent.click(within(section).getByRole('button', { name: 'Tạo mã khôi phục mới' }));
    expect(await within(section).findByText(codes[0] ?? '')).toBeInTheDocument();
  });

  it('steps up with a recovery code and reports a refused code without signing out', async () => {
    const verifyMfa = vi
      .fn<AccountClient['verifyMfa']>()
      .mockRejectedValueOnce(new ApiError(401, 'error.authenticationFailed'))
      .mockResolvedValueOnce(undefined);
    const { router } = renderRoutes(
      routes,
      signedIn(),
      page,
      {},
      fakeHr(),
      fakeAccount({
        account: () => Promise.resolve(own('enabled', 10)),
        removeMfa: () => Promise.reject(new ApiError(403, 'error.accessDenied')),
        verifyMfa,
      }),
    );
    const section = await card();
    await userEvent.click(within(section).getByRole('button', { name: 'Gỡ xác thực 2 lớp' }));
    const confirm = await screen.findByRole('dialog', { name: 'Gỡ xác thực 2 lớp?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Xác nhận gỡ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nhập mã xác thực' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dùng mã khôi phục' }));
    const input = within(dialog).getByLabelText('Mã khôi phục');
    await userEvent.type(input, 'not a code');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác thực' }));
    expect(
      await within(dialog).findByText('Mã khôi phục gồm 16 ký tự: chữ A–Z và số 2–7.'),
    ).toBeInTheDocument();
    expect(verifyMfa).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, 'abcd-efgh-ijkl-mnop');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác thực' }));
    expect(
      await within(dialog).findByText(
        'Mã không đúng hoặc đã được dùng. Nhập sai nhiều lần liên tiếp sẽ đăng xuất bạn khỏi mọi thiết bị.',
      ),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(page);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác thực' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(verifyMfa).toHaveBeenLastCalledWith({ recoveryCode: 'abcd-efgh-ijkl-mnop' });
  });

  it('removes the factor after confirmation and a fresh step-up', async () => {
    const { client: account, removeMfa } = serverLike();
    renderRoutes(routes, signedIn(), page, {}, fakeHr(), account);
    const section = await card();
    await userEvent.click(
      within(section).getByRole('button', { name: 'Thiết lập xác thực 2 lớp' }),
    );
    await userEvent.type(await within(section).findByLabelText('Mã 6 chữ số'), '123456');
    await userEvent.click(within(section).getByRole('button', { name: 'Bật xác thực 2 lớp' }));
    await userEvent.click(
      await within(section).findByRole('button', { name: 'Tôi đã lưu các mã' }),
    );
    await userEvent.click(
      await within(section).findByRole('button', { name: 'Gỡ xác thực 2 lớp' }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Gỡ xác thực 2 lớp?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Xác nhận gỡ' }));
    expect(await within(section).findByText('Chưa bật')).toBeInTheDocument();
    expect(removeMfa).toHaveBeenCalledTimes(1);
  });
});

describe('step-up after a refused HR write', () => {
  it('offers the two-step code when the account has a factor', async () => {
    const verifyMfa = vi.fn(() => Promise.resolve());
    const create = vi.fn(() => Promise.reject(new ApiError(403, 'error.accessDenied')));
    renderRoutes(
      routes,
      fakeAuth({ session: () => Promise.resolve(user) }),
      '/employees',
      {},
      fakeHr({
        hr: {
          me: () =>
            Promise.resolve({
              userId: user.userId,
              employee: null,
              companyScope: true,
              menus: ['employees'],
            }),
        },
        employees: { create },
      }),
      fakeAccount({ account: () => Promise.resolve(own('enabled', 10)), verifyMfa }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm nhân viên' }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText(/Mã nhân viên/), 'NV002');
    await userEvent.type(within(form).getByLabelText(/Họ và tên/), 'Trần Thị B');
    await userEvent.type(within(form).getByLabelText(/Ngày vào làm/), '05/01/2026');
    await userEvent.click(within(form).getByRole('button', { name: 'Tạo hồ sơ' }));
    expect(await within(form).findByText('Không thực hiện được thao tác')).toBeInTheDocument();
    expect(within(form).queryByRole('button', { name: 'Xác thực lại với Google' })).toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Nhập mã xác thực 2 lớp' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nhập mã xác thực' });
    await userEvent.type(within(dialog).getByLabelText('Mã 6 chữ số'), '112233');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác thực' }));
    await waitFor(() => expect(verifyMfa).toHaveBeenCalledExactlyOnceWith({ code: '112233' }));
    // The refused write is not resubmitted by the step-up: the user repeats it.
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Đã xác thực. Hãy thực hiện lại thao tác trong 5 phút.'),
    ).toBeInTheDocument();
  });

  it('points to the setup, and offers no Google step-up, when the account has no factor', async () => {
    renderRoutes(
      routes,
      fakeAuth({ session: () => Promise.resolve(user) }),
      '/employees',
      {},
      fakeHr({
        hr: {
          me: () =>
            Promise.resolve({
              userId: user.userId,
              employee: null,
              companyScope: true,
              menus: ['employees'],
            }),
        },
        employees: { create: () => Promise.reject(new ApiError(403, 'error.accessDenied')) },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm nhân viên' }));
    const form = await screen.findByRole('dialog');
    await userEvent.type(within(form).getByLabelText(/Mã nhân viên/), 'NV002');
    await userEvent.type(within(form).getByLabelText(/Họ và tên/), 'Trần Thị B');
    await userEvent.type(within(form).getByLabelText(/Ngày vào làm/), '05/01/2026');
    await userEvent.click(within(form).getByRole('button', { name: 'Tạo hồ sơ' }));
    expect(
      await within(form).findByText(/Hãy thiết lập xác thực 2 lớp ở trang Phương thức đăng nhập/),
    ).toBeInTheDocument();
    expect(within(form).queryByRole('button', { name: 'Xác thực lại với Google' })).toBeNull();
    expect(within(form).getByRole('link', { name: 'Thiết lập xác thực 2 lớp' })).toHaveAttribute(
      'href',
      page,
    );
  });
});
