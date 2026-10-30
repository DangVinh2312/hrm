import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startStack, type TestStack } from './stack.helper.ts';
import { stableStep, totp } from './totp.helper.ts';

// Administration screens in the browser as Root: accounts, roles and settings keep the layout
// checklist of the design system (§7), and the role form works from the keyboard alone.
let stack: TestStack;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

const nav = (page: Page) => page.getByRole('navigation', { name: 'Điều hướng chính' });

async function enrollTwoStep(page: Page) {
  await page.goto(`${stack.webOrigin}/account/sign-in-methods`);
  await page.getByRole('button', { name: 'Thiết lập xác thực 2 lớp' }).click();
  const key = ((await page.getByText(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/).textContent()) ?? '')
    .split(' ')
    .join('');
  await page.getByLabel('Mã 6 chữ số').fill(totp(key, await stableStep()));
  await page.getByRole('button', { name: 'Bật xác thực 2 lớp' }).click();
  await page.getByRole('button', { name: 'Tôi đã lưu các mã' }).click();
  await expect(page.getByText('Đã bật', { exact: true })).toBeVisible();
}

/** UI checklist (design system §7): no horizontal overflow, the h1 visible, real screenshots. */
async function checkLayout(page: Page, testInfo: TestInfo, name: string) {
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
    if (width === 390) await expect(page.getByRole('button', { name: 'Mở menu' })).toBeVisible();
    else await expect(nav(page)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${name}-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

/** The focused element shows an outline, a ring or a border that differs from its blurred one. */
const focusIsVisible = (page: Page) =>
  page.evaluate(async () => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) return false;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const style = getComputedStyle(element);
    if (
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px') ||
      style.boxShadow !== 'none'
    )
      return true;
    const focused = style.borderColor;
    element.blur();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const blurred = getComputedStyle(element).borderColor;
    element.focus();
    return focused !== blurred;
  });

test('Root adds an account, the administration screens fit 390px and 1366px, the role form works from the keyboard', async ({
  page,
}, testInfo) => {
  const email = 'root-admin-e2e@example.test';
  const token = await stack.bootstrapRoot(email);
  stack.idp.subject = 'root-admin-e2e';
  stack.idp.email = email;
  await page.goto(`${stack.webOrigin}/activate#token=${token}`);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });
  await enrollTwoStep(page);

  await page.goto(`${stack.webOrigin}/accounts`);
  await expect(page.getByRole('heading', { level: 1, name: 'Quản lý tài khoản' })).toBeVisible();
  await checkLayout(page, testInfo, 'accounts-empty');

  await page.getByLabel('Email').fill('nguoi-moi@example.test');
  await page.getByRole('button', { name: 'Cấp tài khoản' }).click();
  await expect(page.getByText('Đã thêm tài khoản.')).toBeVisible();
  await expect(page.getByText('nguoi-moi@example.test')).toBeVisible();
  await checkLayout(page, testInfo, 'accounts');

  await page.goto(`${stack.webOrigin}/roles`);
  await expect(page.getByRole('heading', { level: 1, name: 'Vai trò' })).toBeVisible();
  await checkLayout(page, testInfo, 'roles');

  await page.goto(`${stack.webOrigin}/settings`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await checkLayout(page, testInfo, 'settings');

  await page.goto(`${stack.webOrigin}/roles`);
  const create = page.getByRole('button', { name: 'Tạo vai trò' });
  await create.focus();
  expect(await focusIsVisible(page)).toBe(true);
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Tạo vai trò mới' });
  await expect(dialog).toBeVisible();
  await checkLayout(page, testInfo, 'role-form');

  // Focus moves into the dialog and stays visible on every stop of a full Tab cycle.
  for (let stop = 0; stop < 6; stop += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    expect(await focusIsVisible(page)).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(create).toBeFocused();
});
