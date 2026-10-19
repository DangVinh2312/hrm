import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startStack, type TestStack } from './stack.helper.ts';

let stack: TestStack;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

const signedIn = (page: Page) => expect(page.getByText('Bạn đã đăng nhập.')).toBeVisible();

async function signInWithGoogle(page: Page, subject: string, email?: string) {
  stack.idp.subject = subject;
  stack.idp.email = email;
  stack.idp.cancel = false;
  await page.goto(`${stack.webOrigin}/login`);
  await page.getByRole('button', { name: 'Đăng nhập bằng Google' }).click();
}

test('activation link: token leaves the URL, Google activation by the Root email signs the Root in', async ({
  page,
  context,
}) => {
  const email = 'root@example.test';
  const token = await stack.bootstrapRoot(email);
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  stack.idp.subject = 'root-google';
  stack.idp.email = email;
  await page.goto(`${stack.webOrigin}/activate#token=${token}`);
  await expect(page).toHaveURL(`${stack.webOrigin}/activate`);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await page.waitForURL(`${stack.webOrigin}/`);
  await signedIn(page);
  // The secret only travelled in the activation request body, never in a URL.
  expect(requested.filter((url) => url.includes(token))).toEqual([]);
  const session = (await context.cookies()).find((c) => c.name === '__Host-authz_session');
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  // One-time use: the API refuses a consumed code before any redirect to the IdP.
  await context.clearCookies();
  await page.goto(`${stack.webOrigin}/activate#token=${token}`);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await expect(page.getByText(/không hợp lệ hoặc đã hết hạn/)).toBeVisible();
  await expect(page).toHaveURL(`${stack.webOrigin}/activate`);
  expect((await context.cookies()).map((c) => c.name)).not.toContain('__Host-authz_session');
});

test('login, reload, logout and the back button', async ({ page }) => {
  // The employee is enrolled by email: the first verified Google login of it activates the account.
  await stack.enrollByEmail('employee-a@example.test');
  await signInWithGoogle(page, 'employee-a', 'employee-a@example.test');
  await page.waitForURL(`${stack.webOrigin}/`);
  await signedIn(page);
  await page.reload();
  await signedIn(page);
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await page.waitForURL(`${stack.webOrigin}/login`);
  await page.goBack();
  await page.waitForURL(`${stack.webOrigin}/login`);
  await expect(page.getByText('Bạn đã đăng nhập.')).toHaveCount(0);
});

test('an identity that was never invited cannot sign in', async ({ page, context }) => {
  await signInWithGoogle(page, 'stranger');
  await page.waitForURL(`${stack.webOrigin}/login?error=oidc`);
  await expect(page.getByText('Đăng nhập không thành công')).toBeVisible();
  expect((await context.cookies()).map((c) => c.name)).not.toContain('__Host-authz_session');
});

test('a replayed callback URL is rejected', async ({ page }) => {
  let callback = '';
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/oidc/callback')) callback = request.url();
  });
  await signInWithGoogle(page, 'employee-a');
  await page.waitForURL(`${stack.webOrigin}/`);
  expect(callback).not.toBe('');
  const replay = await page.request.get(callback, { maxRedirects: 0 });
  expect(replay.status()).toBe(303);
  expect(replay.headers().location).toBe('/login?error=oidc');
});

test('a session revoked on the server sends the browser back to login', async ({
  page,
  browser,
}) => {
  await signInWithGoogle(page, 'employee-a');
  await page.waitForURL(`${stack.webOrigin}/`);
  // Same employee on a second device revokes every session (POST /api/auth/logout-all).
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const second = await other.newPage();
  await signInWithGoogle(second, 'employee-a');
  await second.waitForURL(`${stack.webOrigin}/`);
  const status = await second.evaluate(async () => {
    const csrf = (await (await fetch('/api/auth/csrf')).json()) as { csrfToken: string };
    const response = await fetch('/api/auth/logout-all', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf.csrfToken },
    });
    return response.status;
  });
  expect(status).toBe(200);
  await other.close();
  await page.reload();
  await page.waitForURL(`${stack.webOrigin}/login`);
});

test('a logout lost to the network is sent once and can be retried by the user', async ({
  page,
}) => {
  await signInWithGoogle(page, 'employee-a');
  await page.waitForURL(`${stack.webOrigin}/`);
  let attempts = 0;
  await page.route('**/api/auth/logout', async (route) => {
    attempts += 1;
    await route.abort('internetdisconnected');
  });
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.getByText('Không đăng xuất được. Vui lòng thử lại.')).toBeVisible();
  await signedIn(page);
  expect(attempts).toBe(1);
  // The server session was untouched; the user's own second click logs out.
  await page.unroute('**/api/auth/logout');
  await page.reload();
  await signedIn(page);
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await page.waitForURL(`${stack.webOrigin}/login`);
  expect(attempts).toBe(1);
});

test('mutations without the CSRF header are refused', async ({ page }) => {
  await signInWithGoogle(page, 'employee-a');
  await page.waitForURL(`${stack.webOrigin}/`);
  const response = await page.request.post(`${stack.webOrigin}/api/auth/logout`, {
    headers: { origin: stack.webOrigin },
  });
  expect(response.status()).toBe(403);
  await page.reload();
  await signedIn(page);
});

test('sign-in methods: the one Google account is shown read only; link, unlink and Google step-up are gone', async ({
  page,
}, testInfo) => {
  const email = 'single@example.test';
  const methods = `${stack.webOrigin}/account/sign-in-methods`;
  await stack.enrollByEmail(email);
  await signInWithGoogle(page, 'single-google', email);
  await page.waitForURL(`${stack.webOrigin}/`);
  await page.goto(methods);
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tài khoản Google' })).toBeVisible();
  // The fake IdP is not accounts.google.com, so its issuer is shown as configured.
  await expect(page.getByText(stack.idp.issuer, { exact: true })).toBeVisible();
  await expect(page.getByText(/Mỗi tài khoản HRM dùng đúng một tài khoản Google/)).toBeVisible();
  for (const name of ['Gỡ', 'Liên kết thêm', 'Xác thực lại với Google'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  // The old link callback targets show the plain page.
  await page.goto(`${methods}?link=failed`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Phương thức đăng nhập' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The API routes of the removed flows answer 404, with the session and CSRF header present.
  const status = await page.evaluate(async () => {
    const csrf = (await (await fetch('/api/auth/csrf')).json()) as { csrfToken: string };
    const statuses: number[] = [];
    for (const path of [
      '/api/auth/oidc/link',
      '/api/auth/oidc/reauthenticate',
      '/api/auth/oidc/unlink',
    ])
      statuses.push(
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'x-csrf-token': csrf.csrfToken, 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      );
    return statuses;
  });
  expect(status).toEqual([404, 404, 404]);

  // UI checklist (docs/hrm-ui-design-system.md §7): real screenshots, no horizontal overflow.
  await page.goto(methods);
  await expect(page.getByText(email)).toBeVisible();
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`sign-in-methods-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('the browser bundle carries no server secret', () => {
  const files = readdirSync(stack.webAssets, { recursive: true, encoding: 'utf8' }).filter((f) =>
    /\.(js|html|css)$/.test(f),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(join(stack.webAssets, file), 'utf8');
    for (const secret of stack.secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/PRODUCT_[A-Z_]+_(PASSWORD|DATABASE_URL)|DATABASE_ADMIN_URL/);
  }
});
