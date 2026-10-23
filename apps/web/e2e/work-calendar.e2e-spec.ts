import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startStack, type TestStack } from './stack.helper.ts';
import { stableStep, totp } from './totp.helper.ts';

// T4 acceptance in the browser: HR/Admin (fresh after enrolling 2FA) adds and removes a paid
// holiday and a makeup Saturday/Sunday; an employee reads the calendar without any change action. Holiday names are fixtures,
// not the legal calendar. Own stack: two OIDC begins (HR, employee).
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

async function signIn(page: Page, subject: string, email: string) {
  stack.idp.subject = subject;
  stack.idp.email = email;
  stack.idp.cancel = false;
  await page.goto(`${stack.webOrigin}/login`);
  await page.getByRole('button', { name: 'Đăng nhập bằng Google' }).click();
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });
}

/** Calendar changes need a step-up from the last 5 minutes; enrolling 2FA leaves it fresh. */
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

async function addMakeup(page: Page, date: string) {
  await page.getByRole('button', { name: 'Thêm ngày làm bù' }).click();
  const dialog = page.getByRole('dialog', { name: 'Thêm ngày làm bù' });
  await dialog.getByLabel(/^Ngày/).fill(date);
  await dialog.getByLabel(/^Ngày/).press('Tab');
  await dialog.getByRole('button', { name: 'Lưu' }).click();
  await expect(dialog).toHaveCount(0);
}

const makeupSection = (page: Page) => page.getByRole('region', { name: 'Ngày làm bù' });

async function addHoliday(page: Page, date: string, name: string) {
  await page.getByRole('button', { name: 'Thêm ngày nghỉ lễ' }).click();
  const dialog = page.getByRole('dialog', { name: 'Thêm ngày nghỉ lễ' });
  await dialog.getByLabel(/Từ ngày/).fill(date);
  await dialog.getByLabel(/Từ ngày/).press('Tab');
  await dialog.getByLabel(/Đến ngày/).fill(date);
  await dialog.getByLabel(/Đến ngày/).press('Tab');
  await dialog.getByLabel(/Tên ngày nghỉ/).fill(name);
  await dialog.getByRole('button', { name: 'Lưu' }).click();
  await expect(dialog).toHaveCount(0);
}

test('HR adds and removes paid holidays; each change is a new calendar version', async ({
  page,
}, testInfo) => {
  const email = 'hr-calendar-e2e@example.test';
  await stack.grantRole(await stack.enrollByEmail(email), 'hr.admin');
  await signIn(page, 'hr-calendar-e2e', email);
  await expect(nav(page).getByRole('link', { name: 'Lịch làm việc' })).toBeVisible();
  await enrollTwoStep(page);

  await page.goto(`${stack.webOrigin}/calendar?year=2026`);
  await expect(page.getByRole('heading', { level: 1, name: 'Lịch làm việc' })).toBeVisible();
  await expect(page.getByText('Chưa có ngày nghỉ lễ nào trong năm này.')).toBeVisible();
  await expect(page.getByText('Phiên bản lịch: 1')).toBeVisible();

  // A Saturday-Sunday range is refused next to the field, before any request.
  await page.getByRole('button', { name: 'Thêm ngày nghỉ lễ' }).click();
  const dialog = page.getByRole('dialog', { name: 'Thêm ngày nghỉ lễ' });
  await dialog.getByLabel(/Từ ngày/).fill('07/11/2026');
  await dialog.getByLabel(/Từ ngày/).press('Tab');
  await dialog.getByLabel(/Đến ngày/).fill('08/11/2026');
  await dialog.getByLabel(/Đến ngày/).press('Tab');
  await dialog.getByLabel(/Tên ngày nghỉ/).fill('Ngày lễ E2E thứ Bảy');
  await dialog.getByRole('button', { name: 'Lưu' }).click();
  await expect(dialog.getByText(/chỉ có thứ Bảy, Chủ nhật/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Hủy' }).click();

  await addHoliday(page, '02/11/2026', 'Ngày lễ E2E A');
  await addHoliday(page, '31/12/2026', 'Ngày lễ E2E B');
  await expect(page.getByRole('cell', { name: 'Ngày lễ E2E A' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '31/12/2026', exact: true })).toBeVisible();
  await expect(page.getByText('Phiên bản lịch: 3')).toBeVisible();

  await page.getByRole('button', { name: 'Bỏ ngày nghỉ 02/11/2026' }).click();
  await expect(page.getByRole('cell', { name: 'Ngày lễ E2E A' })).toHaveCount(0);
  await expect(page.getByText('Phiên bản lịch: 4')).toBeVisible();

  // Makeup days: a Monday is refused next to the field; Saturday/Sunday are listed apart.
  await expect(
    makeupSection(page).getByText('Chưa có ngày làm bù nào trong năm này.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Thêm ngày làm bù' }).click();
  const makeupDialog = page.getByRole('dialog', { name: 'Thêm ngày làm bù' });
  await makeupDialog.getByLabel(/^Ngày/).fill('09/11/2026');
  await makeupDialog.getByLabel(/^Ngày/).press('Tab');
  await makeupDialog.getByRole('button', { name: 'Lưu' }).click();
  await expect(
    makeupDialog.getByText('Chỉ đặt ngày làm bù vào thứ Bảy hoặc Chủ nhật.'),
  ).toBeVisible();
  await makeupDialog.getByRole('button', { name: 'Hủy' }).click();
  await addMakeup(page, '07/11/2026');
  await addMakeup(page, '08/11/2026');
  await expect(makeupSection(page).getByRole('cell', { name: 'Thứ Bảy' })).toBeVisible();
  await expect(page.getByText('Phiên bản lịch: 6')).toBeVisible();
  await page.getByRole('button', { name: 'Bỏ ngày làm bù 08/11/2026' }).click();
  await expect(makeupSection(page).getByRole('cell', { name: '08/11/2026' })).toHaveCount(0);
  await expect(page.getByText('Phiên bản lịch: 7')).toBeVisible();
  await checkLayout(page, testInfo, 'work-calendar-hr');

  await page.getByRole('button', { name: 'Năm sau' }).click();
  await expect(page).toHaveURL(/year=2027/);
  await expect(page.getByText('Chưa có ngày nghỉ lễ nào trong năm này.')).toBeVisible();
});

test('an employee reads the calendar without change actions', async ({ page }, testInfo) => {
  const email = 'employee-calendar-e2e@example.test';
  await stack.grantRole(await stack.enrollByEmail(email), 'hr.employee');
  await signIn(page, 'employee-calendar-e2e', email);
  await nav(page).getByRole('link', { name: 'Lịch làm việc' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Lịch làm việc' })).toBeVisible();
  await page.goto(`${stack.webOrigin}/calendar?year=2026`);
  await expect(page.getByRole('cell', { name: 'Ngày lễ E2E B' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Thứ Năm' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thêm ngày nghỉ lễ' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Bỏ ngày nghỉ/ })).toHaveCount(0);
  await expect(makeupSection(page).getByRole('cell', { name: '07/11/2026' })).toBeVisible();
  await expect(makeupSection(page).getByRole('cell', { name: 'Thứ Bảy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thêm ngày làm bù' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Bỏ ngày làm bù/ })).toHaveCount(0);
  await checkLayout(page, testInfo, 'work-calendar-employee');
});
