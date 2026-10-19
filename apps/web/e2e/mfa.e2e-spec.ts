import { expect, test, type Page } from '@playwright/test';
import { startStack, type TestStack } from './stack.helper.ts';
import { stableStep, totp } from './totp.helper.ts';

// A stack of its own: the shared one's other tests already use the 20 OIDC begins per client
// per 15 minutes (every test browser is one client behind the proxy); this flow needs three more.
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

test('two-step verification: enroll from the shown key, step up for a fresh@1 action, recovery code, new codes, removal', async ({
  page,
}, testInfo) => {
  const subject = 'root-mfa';
  const methods = `${stack.webOrigin}/account/sign-in-methods`;
  const urls: string[] = [];
  const bodies: string[] = [];
  page.on('request', (request) => {
    urls.push(request.url());
    bodies.push(request.postData() ?? '');
  });
  const token = await stack.bootstrapRoot(subject);
  stack.idp.subject = subject;
  stack.idp.email = undefined;
  await page.goto(`${stack.webOrigin}/activate#token=${token}`);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  // toHaveURL, not waitForURL: a refused activation then reports where the browser landed.
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });
  await signedIn(page);

  const checkLayout = async (name: string) => {
    // UI checklist (docs/hrm-ui-design-system.md §7): real screenshots, no horizontal overflow.
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      // Transitions (navbar after the resize, modal fade-in) are finished, not captured midway.
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  };

  // Enrollment: QR drawn in the page, the same key as text; a code from that key confirms it.
  await page.goto(methods);
  await expect(page.getByText('Chưa bật', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Thiết lập xác thực 2 lớp' }).click();
  await expect(
    page.getByRole('img', { name: 'Mã QR để thêm HRM vào ứng dụng xác thực' }),
  ).toBeVisible();
  const key = ((await page.getByText(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/).textContent()) ?? '')
    .split(' ')
    .join('');
  expect(key).toMatch(/^[A-Z2-7]{32}$/);
  await checkLayout('mfa-setup');
  const enrolledAt = await stableStep();
  await page.getByLabel('Mã 6 chữ số').fill(totp(key, enrolledAt - 1n));
  await page.getByRole('button', { name: 'Bật xác thực 2 lớp' }).click();
  await expect(page.getByRole('heading', { name: 'Mã khôi phục', exact: true })).toBeVisible();
  const codeCells = page.getByText(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  await expect(codeCells).toHaveCount(10);
  const codes = await codeCells.allTextContents();
  await checkLayout('mfa-recovery-codes');
  await page.getByRole('button', { name: 'Tôi đã lưu các mã' }).click();
  await expect(codeCells).toHaveCount(0);
  await expect(page.getByText('Đã bật', { exact: true })).toBeVisible();

  // A new sign-in is not fresh: a fresh@1 action (create an employee profile) is refused
  // until the user steps up with the app's code, then repeats the action.
  const signInAgain = async () => {
    await page.getByRole('button', { name: 'Đăng xuất' }).click();
    await page.waitForURL(`${stack.webOrigin}/login`);
    await page.getByRole('button', { name: 'Đăng nhập bằng Google' }).click();
    await page.waitForURL(`${stack.webOrigin}/`);
  };

  await signInAgain();
  await page.goto(`${stack.webOrigin}/employees`);
  await page.getByRole('button', { name: 'Thêm nhân viên' }).click();
  const create = page.getByRole('dialog', { name: 'Thêm hồ sơ nhân viên' });
  await create.getByLabel(/Mã nhân viên/).fill('MFA001');
  await create.getByLabel(/Họ và tên/).fill('Nhân viên Thử');
  await create.getByLabel(/Ngày vào làm/).fill('05/01/2026');
  await create.getByRole('button', { name: 'Tạo hồ sơ' }).click();
  await expect(create.getByText('Không thực hiện được thao tác')).toBeVisible();
  await expect(create.getByRole('button', { name: 'Xác thực lại với Google' })).toHaveCount(0);
  await create.getByRole('button', { name: 'Nhập mã xác thực 2 lớp' }).click();
  const stepUp = page.getByRole('dialog', { name: 'Nhập mã xác thực' });
  await stepUp.getByLabel('Mã 6 chữ số').fill(totp(key, await stableStep()));
  await checkLayout('mfa-step-up');
  await stepUp.getByRole('button', { name: 'Xác thực' }).click();
  await expect(stepUp).toHaveCount(0);
  await expect(
    create.getByText('Đã xác thực. Hãy thực hiện lại thao tác trong 5 phút.'),
  ).toBeVisible();
  await create.getByRole('button', { name: 'Tạo hồ sơ' }).click();
  await page.waitForURL(/\/employees\/[0-9a-f-]{36}$/);

  // Again not fresh: new recovery codes need a step-up, here by one recovery code (typed in lower
  // case without hyphens); the new set replaces the old one.
  await signInAgain();
  await page.goto(methods);
  await expect(page.getByText('Đã bật', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tạo mã khôi phục mới' }).click();
  await expect(stepUp).toBeVisible();
  await stepUp.getByRole('button', { name: 'Dùng mã khôi phục' }).click();
  await stepUp.getByLabel('Mã khôi phục').fill((codes[0] ?? '').replaceAll('-', '').toLowerCase());
  await stepUp.getByRole('button', { name: 'Xác thực' }).click();
  await expect(stepUp).toHaveCount(0);
  await page.getByRole('button', { name: 'Tạo mã khôi phục mới' }).click();
  await expect(codeCells).toHaveCount(10);
  const renewed = await codeCells.allTextContents();
  expect(renewed.filter((code) => codes.includes(code))).toEqual([]);
  await page.getByRole('button', { name: 'Tôi đã lưu các mã' }).click();

  // Removal within the same step-up; the session continues and the setup is offered again.
  await page.getByRole('button', { name: 'Gỡ xác thực 2 lớp' }).click();
  await page.getByRole('button', { name: 'Xác nhận gỡ' }).click();
  await expect(page.getByText('Chưa bật', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thiết lập xác thực 2 lớp' })).toBeVisible();

  // The key never left the page; codes never appeared in a URL; nothing stayed in storage.
  expect([...urls, ...bodies].filter((entry) => entry.includes(key))).toEqual([]);
  for (const code of [...codes, ...renewed])
    expect(urls.filter((url) => url.includes(code.replaceAll('-', '')))).toEqual([]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});
