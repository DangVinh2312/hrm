import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startStack, type TestStack } from './stack.helper.ts';
import { stableStep, totp } from './totp.helper.ts';

// T5 acceptance in the browser: an employee with a linked profile and a team submits a late
// arrival and an unpaid-leave slot, tracks them, and sees the server's refusals (overlap, probation
// WFH) through error keys. Root prepares the profile (HR roles have no team assignment yet). Own
// stack: two OIDC begins (Root activation, employee).
let stack: TestStack;
const employeeEmail = 'employee-request-e2e@example.test';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

const nav = (page: Page) => page.getByRole('navigation', { name: 'Điều hướng chính' });

/** Business weekdays after today (Asia/Ho_Chi_Minh), as `dd/mm/yyyy` and `yyyy-mm-dd`: inside the D06 window, no calendar rows. */
function weekdays(count: number) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
    new Date(),
  );
  const start = new Date(`${today}T00:00:00Z`);
  const days: { ui: string; iso: string }[] = [];
  for (let offset = 3; days.length < count; offset++) {
    const day = new Date(start.getTime() + offset * 86_400_000);
    if ([0, 6].includes(day.getUTCDay())) continue;
    const iso = day.toISOString().slice(0, 10);
    days.push({ ui: `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`, iso });
  }
  return days;
}

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
    // Polled: the layout settles a frame after the viewport changes (a real overflow stays).
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
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

async function pick(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
}

test('Root prepares an employee profile linked to an account, in a team', async ({ page }) => {
  const accountId = await stack.enrollByEmail(employeeEmail);
  await stack.grantRole(accountId, 'hr.employee');
  const rootEmail = 'root-request-e2e@example.test';
  const token = await stack.bootstrapRoot(rootEmail);
  stack.idp.subject = 'root-request-e2e';
  stack.idp.email = rootEmail;
  await page.goto(`${stack.webOrigin}/activate#token=${token}`);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });
  await enrollTwoStep(page);

  await page.goto(`${stack.webOrigin}/employees`);
  await page.getByRole('button', { name: 'Thêm nhân viên' }).click();
  const create = page.getByRole('dialog', { name: 'Thêm hồ sơ nhân viên' });
  await create.getByLabel(/Mã nhân viên/).fill('REQ001');
  await create.getByLabel(/Họ và tên/).fill('Nhân Viên Gửi Đơn');
  await create.getByLabel(/Ngày vào làm/).fill('05/01/2026');
  await create.getByLabel(/Ngày vào làm/).press('Tab');
  await create.getByRole('button', { name: 'Tạo hồ sơ' }).click();
  await page.waitForURL(/\/employees\/[0-9a-f-]{36}$/);
  await pick(page, 'Chọn tài khoản', employeeEmail);
  await page.getByRole('button', { name: 'Liên kết', exact: true }).click();
  await expect(page.getByText('Đã liên kết', { exact: true })).toBeVisible();

  await page.goto(`${stack.webOrigin}/teams`);
  await page.getByRole('button', { name: 'Thêm team' }).click();
  await page
    .getByRole('dialog', { name: 'Thêm team' })
    .getByLabel(/Tên team/)
    .fill('Team Đơn E2E');
  await page.getByRole('button', { name: 'Tạo team' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Team Đơn E2E' })).toBeVisible();
  await pick(page, 'Thêm thành viên', 'REQ001 · Nhân Viên Gửi Đơn');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'REQ001' })).toBeVisible();
});

test('the employee submits requests, tracks them and sees the refusals', async ({
  page,
}, testInfo) => {
  stack.idp.subject = 'employee-request-e2e';
  stack.idp.email = employeeEmail;
  stack.idp.cancel = false;
  await page.goto(`${stack.webOrigin}/login`);
  await page.getByRole('button', { name: 'Đăng nhập bằng Google' }).click();
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });

  const [late, leave] = weekdays(2);
  await nav(page).getByRole('link', { name: 'Đơn của tôi' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Đơn của tôi' })).toBeVisible();
  await expect(page.getByText('Bạn chưa gửi đơn nào.')).toBeVisible();
  await checkLayout(page, testInfo, 'request-list-empty');

  // Late arrival: date + expected time + reason; the new request opens in its detail.
  await page.getByRole('link', { name: 'Gửi đơn mới' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Gửi đơn mới' })).toBeVisible();
  await page.getByRole('button', { name: 'Gửi đơn' }).click();
  await expect(page.getByText('Hãy nhập lý do.')).toBeVisible();
  await page.getByLabel(/^Ngày/).fill(late!.ui);
  await page.getByLabel(/^Ngày/).press('Tab');
  await page.getByLabel(/Giờ đến dự kiến/).fill('09:30');
  await page.getByLabel(/Lý do/).fill('Kẹt xe E2E');
  await checkLayout(page, testInfo, 'request-form');
  await page.getByRole('button', { name: 'Gửi đơn' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Chi tiết đơn' })).toBeVisible();
  await expect(page.getByText('Chờ trưởng nhóm duyệt')).toBeVisible();
  await expect(page.getByText('Kẹt xe E2E')).toBeVisible();
  await expect(page.getByRole('cell', { name: late!.ui })).toBeVisible();
  await checkLayout(page, testInfo, 'request-detail');

  // The same late arrival again overlaps the pending one: refused by its own key, nothing created.
  await page.goto(`${stack.webOrigin}/requests/new`);
  await page.getByLabel(/^Ngày/).fill(late!.ui);
  await page.getByLabel(/^Ngày/).press('Tab');
  await page.getByLabel(/Giờ đến dự kiến/).fill('09:30');
  await page.getByLabel(/Lý do/).fill('Kẹt xe E2E lần hai');
  await page.getByRole('button', { name: 'Gửi đơn' }).click();
  await expect(
    page.getByRole('alert').getByText(/trùng thời gian với một đơn khác của bạn/),
  ).toBeVisible();

  // Work from home is refused during probation by the server, shown by its error key.
  await pick(page, 'Loại đơn', 'Làm việc tại nhà');
  await page.getByLabel(/^Ngày 1/).fill(leave!.ui);
  await page.getByLabel(/^Ngày 1/).press('Tab');
  await page.getByRole('button', { name: 'Gửi đơn' }).click();
  await expect(
    page.getByRole('alert').getByText(/Trong thời gian thử việc chỉ gửi được đơn/),
  ).toBeVisible();

  // Unpaid leave: date + slot.
  await pick(page, 'Loại đơn', 'Nghỉ không lương');
  await pick(page, 'Khung giờ 1', '14:00–16:00');
  await page.getByRole('button', { name: 'Gửi đơn' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Chi tiết đơn' })).toBeVisible();
  await expect(page.getByText('14:00–16:00')).toBeVisible();

  await page.goto(`${stack.webOrigin}/requests`);
  const rows = page.getByRole('row');
  await expect(rows.filter({ hasText: 'Đi muộn' }).filter({ hasText: late!.ui })).toHaveCount(1);
  await expect(
    rows.filter({ hasText: 'Nghỉ không lương' }).filter({ hasText: leave!.ui }),
  ).toHaveCount(1);
  await expect(page.getByText('Làm việc tại nhà')).toHaveCount(0);
  await checkLayout(page, testInfo, 'request-list');
});
