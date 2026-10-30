import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startStack, type TestStack } from './stack.helper.ts';
import { stableStep, totp } from './totp.helper.ts';

// T6/T8 acceptance in the browser: a Team Lead and the COO decide requests in the approval inbox
// and final approval is open (M3): a lead's approval of a late arrival is final, a reject needs a
// reason, a lead approval of unpaid leave moves it to the COO who approves it, the Decided tab lists
// the lead's decisions and, for the COO, every decided request, and the employee's timesheet
// then shows the approved unpaid leave. Root prepares the profiles and the team.
// Own stack: five OIDC begins (Root activation, employee, lead, COO, employee again).
let stack: TestStack;
const employeeEmail = 'employee-approval-e2e@example.test';
const leadEmail = 'lead-approval-e2e@example.test';
const cooEmail = 'coo-approval-e2e@example.test';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

const nav = (page: Page) => page.getByRole('navigation', { name: 'Điều hướng chính' });

/** Business weekdays after today (Asia/Ho_Chi_Minh), as `dd/mm/yyyy`: inside the D06 window, no calendar rows. */
function weekdays(count: number) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
    new Date(),
  );
  const start = new Date(`${today}T00:00:00Z`);
  const days: string[] = [];
  for (let offset = 3; days.length < count; offset++) {
    const day = new Date(start.getTime() + offset * 86_400_000);
    if ([0, 6].includes(day.getUTCDay())) continue;
    const iso = day.toISOString().slice(0, 10);
    days.push(`${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`);
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

async function login(page: Page, subject: string, email: string) {
  stack.idp.subject = subject;
  stack.idp.email = email;
  stack.idp.cancel = false;
  await page.goto(`${stack.webOrigin}/login`);
  await page.getByRole('button', { name: 'Đăng nhập bằng Google' }).click();
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });
}

async function profile(page: Page, code: string, name: string, email: string) {
  await page.goto(`${stack.webOrigin}/employees`);
  await page.getByRole('button', { name: 'Thêm nhân viên' }).click();
  const create = page.getByRole('dialog', { name: 'Thêm hồ sơ nhân viên' });
  await create.getByLabel(/Mã nhân viên/).fill(code);
  await create.getByLabel(/Họ và tên/).fill(name);
  await create.getByLabel(/Ngày vào làm/).fill('05/01/2026');
  await create.getByLabel(/Ngày vào làm/).press('Tab');
  await create.getByRole('button', { name: 'Tạo hồ sơ' }).click();
  await page.waitForURL(/\/employees\/[0-9a-f-]{36}$/);
  await pick(page, 'Chọn tài khoản', email);
  await page.getByRole('button', { name: 'Liên kết', exact: true }).click();
  await expect(page.getByText('Đã liên kết', { exact: true })).toBeVisible();
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Xử lý đơn' });

async function review(page: Page, kind: string, date?: string) {
  const rows = page.getByRole('row').filter({ hasText: kind });
  await (date ? rows.filter({ hasText: date }) : rows).getByRole('button').click();
  await expect(dialog(page).getByText('APR001 · Nhân Viên Gửi Duyệt')).toBeVisible();
}

test('Root prepares the employee, the lead (in one team) and the COO account', async ({ page }) => {
  for (const email of [employeeEmail, leadEmail])
    await stack.grantRole(await stack.enrollByEmail(email), 'hr.employee');
  // The COO needs no profile to decide the final step.
  const cooId = await stack.enrollByEmail(cooEmail);
  await stack.grantRole(cooId, 'hr.employee');
  await stack.grantRole(cooId, 'hr.coo');
  const rootEmail = 'root-approval-e2e@example.test';
  const token = await stack.bootstrapRoot(rootEmail);
  stack.idp.subject = 'root-approval-e2e';
  stack.idp.email = rootEmail;
  await page.goto(`${stack.webOrigin}/activate#token=${token}`);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });
  await enrollTwoStep(page);

  await profile(page, 'APR001', 'Nhân Viên Gửi Duyệt', employeeEmail);
  await profile(page, 'APR002', 'Trưởng Nhóm Duyệt', leadEmail);
  await page.goto(`${stack.webOrigin}/teams`);
  await page.getByRole('button', { name: 'Thêm team' }).click();
  await page
    .getByRole('dialog', { name: 'Thêm team' })
    .getByLabel(/Tên team/)
    .fill('Team Duyệt E2E');
  await page.getByRole('button', { name: 'Tạo team' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Team Duyệt E2E' })).toBeVisible();
  await pick(page, 'Thêm thành viên', 'APR001 · Nhân Viên Gửi Duyệt');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'APR001' })).toBeVisible();
  await pick(page, 'Thêm thành viên', 'APR002 · Trưởng Nhóm Duyệt');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'APR002' })).toBeVisible();
  await pick(page, 'Chọn trưởng nhóm', 'APR002 · Trưởng Nhóm Duyệt');
  await page.getByRole('button', { name: 'Phân công' }).click();
  await expect(page.getByRole('button', { name: 'Bỏ trưởng nhóm' })).toBeEnabled();
});

test('the employee submits a late arrival and two unpaid leaves; no approvals menu', async ({
  page,
}) => {
  await login(page, 'employee-approval-e2e', employeeEmail);
  await expect(nav(page).getByRole('link', { name: 'Đơn của tôi' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Phê duyệt' })).toHaveCount(0);
  const [late, leave, second] = weekdays(3);
  await page.goto(`${stack.webOrigin}/requests/new`);
  await page.getByLabel(/^Ngày/).fill(late!);
  await page.getByLabel(/^Ngày/).press('Tab');
  await page.getByLabel(/Giờ đến dự kiến/).fill('09:30');
  await page.getByLabel(/Lý do/).fill('Kẹt xe chờ duyệt E2E');
  await page.getByRole('button', { name: 'Gửi đơn' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Chi tiết đơn' })).toBeVisible();

  for (const [date, slot, reason] of [
    [leave!, '14:00–16:00', 'Việc riêng chờ duyệt E2E'],
    [second!, '09:00–11:00', 'Việc riêng thứ hai E2E'],
  ] as const) {
    await page.goto(`${stack.webOrigin}/requests/new`);
    await pick(page, 'Loại đơn', 'Nghỉ không lương');
    await page.getByLabel(/^Ngày 1/).fill(date);
    await page.getByLabel(/^Ngày 1/).press('Tab');
    await pick(page, 'Khung giờ 1', slot);
    await page.getByLabel(/Lý do/).fill(reason);
    await page.getByRole('button', { name: 'Gửi đơn' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Chi tiết đơn' })).toBeVisible();
  }
});

test('the lead: a late arrival approval is final, reject needs a reason, unpaid leave moves to the COO', async ({
  page,
}, testInfo) => {
  await login(page, 'lead-approval-e2e', leadEmail);
  await nav(page).getByRole('link', { name: 'Phê duyệt' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Phê duyệt đơn' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Duyệt bước 1 (3)' })).toBeVisible();
  // Not a COO: the final queue answers an empty page, so it is not shown.
  await expect(page.getByRole('tab', { name: /Duyệt cuối/ })).toHaveCount(0);
  await checkLayout(page, testInfo, 'approval-inbox');

  // Late arrival needs the lead only (§6.4.1): the approval is final, and final approval is open.
  await review(page, 'Đi muộn');
  await expect(dialog(page).getByText('Kẹt xe chờ duyệt E2E')).toBeVisible();
  await checkLayout(page, testInfo, 'approval-dialog');
  await dialog(page).getByRole('button', { name: 'Duyệt' }).click();
  await expect(page.getByText('Đã duyệt đơn.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Duyệt bước 1 (2)' })).toBeVisible();

  const [late, leave, second] = weekdays(3);
  await review(page, 'Nghỉ không lương', second);
  await expect(dialog(page).getByText('Việc riêng thứ hai E2E')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Từ chối' }).click();
  await expect(dialog(page).getByText('Hãy nhập lý do từ chối.')).toBeVisible();
  await dialog(page)
    .getByLabel(/Lý do hoặc ghi chú/)
    .fill('Thiếu người trực E2E');
  await dialog(page).getByRole('button', { name: 'Từ chối' }).click();
  await expect(page.getByText('Đã từ chối đơn.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Duyệt bước 1 (1)' })).toBeVisible();

  await review(page, 'Nghỉ không lương');
  await expect(dialog(page).getByText('Việc riêng chờ duyệt E2E')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Duyệt' }).click();
  await expect(page.getByText('Đã duyệt bước 1. Đơn chuyển sang duyệt cuối.')).toBeVisible();
  await expect(page.getByText('Không có đơn nào đang chờ bạn duyệt.')).toBeVisible();

  // History (T6 part C): the three decisions of this lead, latest first; dates follow today.
  await page.getByRole('tab', { name: 'Đã xử lý' }).click();
  const rows = page.getByRole('row');
  await expect(rows.nth(1)).toContainText('Nghỉ không lương');
  await expect(rows.nth(1)).toContainText(leave!);
  await expect(rows.nth(1)).toContainText('Chờ duyệt cuối');
  await expect(rows.nth(1)).toContainText('Trưởng nhóm đã duyệt');
  await expect(rows.nth(2)).toContainText(second!);
  await expect(rows.nth(2)).toContainText('Trưởng nhóm đã từ chối');
  await expect(rows.nth(3)).toContainText('Đi muộn');
  await expect(rows.nth(3)).toContainText(late!);
  await expect(rows.nth(3)).toContainText('Đã duyệt');
  await expect(rows).toHaveCount(4);
  await checkLayout(page, testInfo, 'approval-history');
});

test('the COO approves the final step of the unpaid leave', async ({ page }) => {
  await login(page, 'coo-approval-e2e', cooEmail);
  await nav(page).getByRole('link', { name: 'Phê duyệt' }).click();
  // Nothing waits for the COO as a lead: only the final queue shows.
  await expect(page.getByRole('tab', { name: /Duyệt bước 1/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Duyệt cuối (1)' }).click();
  await review(page, 'Nghỉ không lương');
  await expect(dialog(page).getByText('Chờ duyệt cuối')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Duyệt' }).click();
  await expect(page.getByText('Đã duyệt đơn.')).toBeVisible();
  await expect(page.getByText('Không có đơn nào đang chờ bạn duyệt.')).toBeVisible();

  // The COO's history covers the company: their final approval, the lead's reject and the late arrival.
  await page.getByRole('tab', { name: 'Đã xử lý' }).click();
  const [late, leave, second] = weekdays(3);
  const rows = page.getByRole('row');
  await expect(rows.nth(1)).toContainText(leave!);
  await expect(rows.nth(1)).toContainText('Đã duyệt cuối');
  await expect(rows.nth(2)).toContainText(second!);
  await expect(rows.nth(2)).toContainText('Trưởng nhóm đã từ chối');
  await expect(rows.nth(3)).toContainText(late!);
  await expect(rows).toHaveCount(4);
});

test('the employee sees the approved unpaid leave in the timesheet of its month', async ({
  page,
}, testInfo) => {
  await login(page, 'employee-approval-e2e', employeeEmail);
  await nav(page).getByRole('link', { name: 'Bảng công' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bảng công' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Công theo lịch' })).toBeVisible();
  // The month of the approved leave (14:00-16:00 = 120 minutes = 0,25 day); only it counts, the
  // rejected one and the other months do not.
  const [, leave] = weekdays(3);
  const month = `${leave!.slice(6)}-${leave!.slice(3, 5)}`;
  await page.goto(`${stack.webOrigin}/attendance?month=${month}`);
  const unpaid = page.getByRole('region', { name: 'Nghỉ không lương' });
  await expect(unpaid).toContainText('0,25 ngày');
  await expect(unpaid).toContainText('120 phút');
  await expect(page.getByText('Đang mở')).toBeVisible();
  await checkLayout(page, testInfo, 'attendance');
});
