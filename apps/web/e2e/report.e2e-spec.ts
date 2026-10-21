import { expect, test, type Page } from '@playwright/test';
import { startStack, type TestStack } from './stack.helper.ts';
import { stableStep, totp } from './totp.helper.ts';

// T9 web acceptance in the browser: HR/Admin (fresh after enrolling 2FA) creates a profile, opens
// the reports from the menu, reads the attendance rows and downloads the XLSX; an over-long range
// is refused on the page. Own stack: one OIDC begin.
let stack: TestStack;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

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

test('HR reads the attendance report and downloads its XLSX', async ({ page }) => {
  const email = 'hr-report-e2e@example.test';
  await stack.grantRole(await stack.enrollByEmail(email), 'hr.admin');
  stack.idp.subject = 'hr-report-e2e';
  stack.idp.email = email;
  stack.idp.cancel = false;
  await page.goto(`${stack.webOrigin}/login`);
  await page.getByRole('button', { name: 'Đăng nhập bằng Google' }).click();
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });
  await enrollTwoStep(page);

  await page.goto(`${stack.webOrigin}/employees`);
  await page.getByRole('button', { name: 'Thêm nhân viên' }).click();
  const create = page.getByRole('dialog', { name: 'Thêm hồ sơ nhân viên' });
  await create.getByLabel(/Mã nhân viên/).fill('RPT001');
  await create.getByLabel(/Họ và tên/).fill('Nhân Viên Báo Cáo');
  await create.getByLabel(/Ngày vào làm/).fill('05/01/2026');
  await create.getByLabel(/Ngày vào làm/).press('Tab');
  await create.getByRole('button', { name: 'Tạo hồ sơ' }).click();
  await page.waitForURL(/\/employees\/[0-9a-f-]{36}$/);

  await page.goto(`${stack.webOrigin}/`);
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('link', { name: 'Báo cáo' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Báo cáo' })).toBeVisible();
  const table = page.getByRole('table', { name: 'Bảng công' });
  await expect(table.getByRole('row', { name: /RPT001 Nhân Viên Báo Cáo/ })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Tải XLSX' }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^hrm-report-attendance-\d{4}-\d{2}_\d{4}-\d{2}\.xlsx$/,
  );

  // A range over 12 months is refused on the page itself.
  await page.getByLabel('Từ tháng').fill('2024-01');
  await expect(page.getByText('Khoảng thời gian tối đa 12 tháng.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tải XLSX' })).toBeDisabled();
});
