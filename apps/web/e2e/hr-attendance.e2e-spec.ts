import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startStack, type TestStack } from './stack.helper.ts';
import { stableStep, totp } from './totp.helper.ts';

// T8 phần C acceptance for HR in the browser (fake data only): the attendance table per employee
// (Reports), the audited adjustment on the employee detail (with its reason, visible to HR and
// only as a total to the employee), closing and reopening a month, the leave reconciliation panel,
// HR cancelling an approved request (the employee's timesheet changes), and the refusal of HR
// adjusting their own attendance (button blocked in the UI, API 403 `error.accessDenied`).
// The reconciliation panel is read with one row: the employee (confirmed official by Root in the
// UI) submits one pending annual-leave day within the accrual, then HR posts a negative ledger
// adjustment through the real route `POST /api/hr/employees/:id/leave-adjustments` (no UI exists
// for it) so the accrual to that month no longer covers the pending day.
// Own stack: Root activation, then HR, lead and employee sign-ins (six OIDC begins).
let stack: TestStack;
const hrEmail = 'hr-attendance-e2e@example.test';
const leadEmail = 'lead-attendance-e2e@example.test';
const employeeEmail = 'employee-attendance-e2e@example.test';
const MONTH = '2026-03';
const WORK_DATE = '2026-03-10';
let requestId = '';
let requestMonth = '';
let lateIso = '';
let leaveRequestId = '';
let leaveDay = { iso: '', ui: '' };
let employeeId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startStack();
});

test.afterAll(async () => {
  await stack?.stop();
});

const nav = (page: Page) => page.getByRole('navigation', { name: 'Điều hướng chính' });

/** The first business day at least three days after today (Asia/Ho_Chi_Minh): `iso` and `ui` (dd/mm/yyyy). */
function futureWeekday() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(
    new Date(),
  );
  const start = new Date(`${today}T00:00:00Z`);
  for (let offset = 3; ; offset++) {
    const day = new Date(start.getTime() + offset * 86_400_000);
    if ([0, 6].includes(day.getUTCDay())) continue;
    const iso = day.toISOString().slice(0, 10);
    return { iso, ui: `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` };
  }
}

/** The first business day strictly after `iso` (a weekday; the empty work calendar has no holidays). */
function weekdayAfter(iso: string) {
  const start = new Date(`${iso}T00:00:00Z`);
  for (let offset = 1; ; offset++) {
    const day = new Date(start.getTime() + offset * 86_400_000);
    if ([0, 6].includes(day.getUTCDay())) continue;
    const next = day.toISOString().slice(0, 10);
    return { iso: next, ui: `${next.slice(8)}/${next.slice(5, 7)}/${next.slice(0, 4)}` };
  }
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
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    // Long pages keep their scroll position across the resize: the h1 is checked from the top.
    await page.evaluate(() => window.scrollTo(0, 0));
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
  // A previous sign-in of this test would redirect /login: start from no session.
  await page.context().clearCookies();
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

async function openEmployee(page: Page, code: string, name: string) {
  await page.goto(`${stack.webOrigin}/employees`);
  await page.getByRole('link', { name: code, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('Root prepares the HR, the lead and the employee (profiles linked, one team)', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const hrId = await stack.enrollByEmail(hrEmail);
  await stack.grantRole(hrId, 'hr.admin');
  await stack.grantRole(hrId, 'hr.employee');
  for (const email of [leadEmail, employeeEmail])
    await stack.grantRole(await stack.enrollByEmail(email), 'hr.employee');
  const rootEmail = 'root-attendance-e2e@example.test';
  const token = await stack.bootstrapRoot(rootEmail);
  stack.idp.subject = 'root-attendance-e2e';
  stack.idp.email = rootEmail;
  await page.goto(`${stack.webOrigin}/activate#token=${token}`);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });
  await enrollTwoStep(page);

  await profile(page, 'ATT001', 'Nhân Viên Công E2E', employeeEmail);
  // Official from 2026-01-06 (the day after the probation start): annual leave accrues from then.
  await page.getByRole('button', { name: 'Xác nhận chính thức' }).click();
  const official = page.getByRole('dialog', { name: 'Xác nhận chính thức' });
  await official.getByLabel(/Ngày bắt đầu chính thức/).fill('2026-01-06');
  await official.getByRole('button', { name: 'Xác nhận chính thức' }).click();
  await expect(page.getByRole('button', { name: 'Xác nhận chính thức' })).toHaveCount(0);
  await profile(page, 'ATT002', 'Trưởng Nhóm Công E2E', leadEmail);
  await profile(page, 'ATT003', 'HR Công E2E', hrEmail);
  await page.goto(`${stack.webOrigin}/teams`);
  await page.getByRole('button', { name: 'Thêm team' }).click();
  await page
    .getByRole('dialog', { name: 'Thêm team' })
    .getByLabel(/Tên team/)
    .fill('Team Công E2E');
  await page.getByRole('button', { name: 'Tạo team' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Team Công E2E' })).toBeVisible();
  await pick(page, 'Thêm thành viên', 'ATT001 · Nhân Viên Công E2E');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'ATT001' })).toBeVisible();
  await pick(page, 'Chọn trưởng nhóm', 'ATT002 · Trưởng Nhóm Công E2E');
  await page.getByRole('button', { name: 'Phân công' }).click();
  await expect(page.getByRole('button', { name: 'Bỏ trưởng nhóm' })).toBeEnabled();
});

test('the employee submits a late arrival and the lead approves it (final)', async ({ page }) => {
  const day = futureWeekday();
  requestMonth = day.iso.slice(0, 7);
  lateIso = day.iso;
  await login(page, 'employee-attendance-e2e', employeeEmail);
  await page.goto(`${stack.webOrigin}/requests/new`);
  await page.getByLabel(/^Ngày/).fill(day.ui);
  await page.getByLabel(/^Ngày/).press('Tab');
  await page.getByLabel(/Giờ đến dự kiến/).fill('09:30');
  await page.getByLabel(/Lý do/).fill('Kẹt xe công E2E');
  await page.getByRole('button', { name: 'Gửi đơn' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Chi tiết đơn' })).toBeVisible();
  requestId = /\/requests\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
  expect(requestId).not.toBe('');
});

test('the employee submits one annual-leave day within the accrual (it stays pending)', async ({
  page,
}) => {
  leaveDay = weekdayAfter(lateIso);
  await login(page, 'employee-attendance-e2e', employeeEmail);
  await page.goto(`${stack.webOrigin}/requests/new`);
  await pick(page, 'Loại đơn', 'Nghỉ phép năm');
  await page.getByLabel(/^Ngày 1/).fill(leaveDay.ui);
  await page.getByLabel(/^Ngày 1/).press('Tab');
  await pick(page, 'Khung giờ 1', '09:00–18:00');
  await page.getByLabel(/Lý do/).fill('Nghỉ phép năm E2E');
  await page.getByRole('button', { name: 'Gửi đơn' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Chi tiết đơn' })).toBeVisible();
  leaveRequestId = /\/requests\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
  expect(leaveRequestId).not.toBe('');
});

test('the lead approves the late arrival; the employee timesheet counts it', async ({ page }) => {
  await login(page, 'lead-attendance-e2e', leadEmail);
  await nav(page).getByRole('link', { name: 'Phê duyệt' }).click();
  await page.getByRole('row').filter({ hasText: 'Đi muộn' }).getByRole('button').click();
  const review = page.getByRole('dialog', { name: 'Xử lý đơn' });
  await review.getByRole('button', { name: 'Duyệt' }).click();
  await expect(page.getByText('Đã duyệt đơn.')).toBeVisible();

  await login(page, 'employee-attendance-e2e', employeeEmail);
  await page.goto(`${stack.webOrigin}/attendance?month=${requestMonth}`);
  await expect(page.getByRole('region', { name: 'Đi muộn' })).toContainText(/^Đi muộn1 lần/);
  // The employee sees no HR panels.
  await expect(page.getByRole('heading', { name: 'Chốt kỳ công' })).toHaveCount(0);
  await page.goto(`${stack.webOrigin}/leave`);
  await expect(page.getByRole('heading', { level: 1, name: 'Phép năm' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Đối soát phép' })).toHaveCount(0);
});

test('HR session: adjust, report, self-adjust refusal, cancel, close/reopen, reconciliation', async ({
  page,
}, testInfo) => {
  // One HR sign-in: HR writes need a step-up from the last 5 minutes, which enrolling 2FA gives;
  // a second sign-in would not be fresh.
  test.setTimeout(180_000);
  await login(page, 'hr-attendance-e2e', hrEmail);
  await enrollTwoStep(page);
  await test.step('HR adds an adjustment with a reason; the per-employee table and the employee timesheet change', async () => {
    await openEmployee(page, 'ATT001', 'Nhân Viên Công E2E');
    employeeId = /\/employees\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
    expect(employeeId).not.toBe('');
    const section = page.getByRole('heading', { level: 2, name: 'Điều chỉnh công' });
    await expect(section).toBeVisible();
    await page.getByLabel('Tháng điều chỉnh').fill(MONTH);
    await expect(page.getByText('Chưa có điều chỉnh nào trong tháng này.')).toBeVisible();
    await page.getByRole('button', { name: 'Thêm điều chỉnh' }).click();
    const dialog = page.getByRole('dialog', { name: 'Thêm điều chỉnh' });
    await dialog.getByRole('button', { name: 'Lưu điều chỉnh' }).click();
    await expect(dialog.getByText('Chọn ngày điều chỉnh.')).toBeVisible();
    await dialog.getByLabel(/^Ngày/).fill(WORK_DATE);
    await dialog.getByLabel(/^Số phút/).fill('90');
    await dialog.getByLabel(/^Lý do/).fill('Quên chấm công buổi chiều E2E');
    await dialog.getByLabel(/^Số tham chiếu/).fill('QD-2026/03');
    await dialog.getByRole('button', { name: 'Lưu điều chỉnh' }).click();
    const table = page.getByRole('table', { name: 'Điều chỉnh trong tháng' });
    await expect(table.getByText('Quên chấm công buổi chiều E2E')).toBeVisible();
    await expect(table.getByText('+90')).toBeVisible();
    await expect(page.getByText(/Tổng điều chỉnh của tháng: 90 phút/)).toBeVisible();
    await checkLayout(page, testInfo, 'hr-adjust');

    // The attendance report lists the employee with the adjustment.
    await nav(page).getByRole('link', { name: 'Báo cáo' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Báo cáo' })).toBeVisible();
    await page.getByLabel('Từ tháng').fill(MONTH);
    await page.getByLabel('Đến tháng').fill(MONTH);
    const report = page.getByRole('table', { name: 'Bảng công' });
    await expect(report.getByRole('row', { name: /ATT001 Nhân Viên Công E2E/ })).toContainText(
      '90 phút',
    );
    await checkLayout(page, testInfo, 'hr-report');
  });
  await test.step('HR cannot adjust their own attendance: blocked in the UI, 403 error.accessDenied from the API', async () => {
    await openEmployee(page, 'ATT003', 'HR Công E2E');
    await page.getByLabel('Tháng điều chỉnh').fill(MONTH);
    await expect(page.getByText(/Không tự điều chỉnh công của chính mình/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thêm điều chỉnh' })).toBeDisabled();
    await checkLayout(page, testInfo, 'hr-self-adjust');
    // The UI is only a hint: the same request sent by hand is refused by the API.
    const ownId = /\/employees\/([0-9a-f-]{36})$/.exec(page.url())?.[1] ?? '';
    const refused = await page.evaluate(async (id) => {
      const csrf = (await (await fetch('/api/auth/csrf')).json()) as { csrfToken: string };
      const response = await fetch(`/api/hr/employees/${id}/attendance-adjustments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf.csrfToken,
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ workDate: '2026-03-11', minutes: 30, reason: 'Tự điều chỉnh E2E' }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    }, ownId);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ statusCode: 403, code: 'error.accessDenied' });
    await page.reload();
    await page.getByLabel('Tháng điều chỉnh').fill(MONTH);
    await expect(page.getByText('Chưa có điều chỉnh nào trong tháng này.')).toBeVisible();
  });
  await test.step('HR cancels the approved late arrival; the employee timesheet drops it', async () => {
    await page.goto(`${stack.webOrigin}/requests/${requestId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Chi tiết đơn' })).toBeVisible();
    await page.getByRole('button', { name: 'Hủy đơn' }).click();
    const dialog = page.getByRole('dialog', { name: 'Hủy đơn' });
    await dialog.getByRole('button', { name: 'Xác nhận hủy' }).click();
    await expect(dialog.getByText('Nhập lý do hủy đơn đã duyệt.')).toBeVisible();
    await dialog.getByLabel(/Lý do hủy/).fill('Nhập nhầm ngày E2E');
    await dialog.getByRole('button', { name: 'Xác nhận hủy' }).click();
    await expect(page.getByText('Đã hủy', { exact: true }).first()).toBeVisible();
    await checkLayout(page, testInfo, 'hr-cancel');
  });
  await test.step('HR closes and reopens a month; the state changes and adjusting a closed month is blocked', async () => {
    await page.goto(`${stack.webOrigin}/attendance`);
    await expect(page.getByRole('heading', { level: 1, name: 'Bảng công' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Chốt kỳ công' })).toBeVisible();
    await page.getByLabel('Tháng chốt kỳ').fill(MONTH);
    await expect(page.getByText('Chưa có lần chốt hay mở lại nào.')).toBeVisible();
    await page.getByRole('button', { name: 'Chốt kỳ', exact: true }).click();
    await page.getByRole('button', { name: 'Xác nhận chốt' }).click();
    await expect(page.getByText('Đã chốt', { exact: true })).toBeVisible();
    const history = page.getByRole('table', { name: 'Lịch sử chốt và mở lại' });
    await expect(history.getByRole('row').nth(1)).toContainText('Chốt');
    await checkLayout(page, testInfo, 'hr-period-closed');

    await openEmployee(page, 'ATT001', 'Nhân Viên Công E2E');
    await page.getByLabel('Tháng điều chỉnh').fill(MONTH);
    await expect(page.getByText(/Kỳ công của tháng này đã chốt/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thêm điều chỉnh' })).toBeDisabled();

    await page.goto(`${stack.webOrigin}/attendance`);
    await page.getByLabel('Tháng chốt kỳ').fill(MONTH);
    await page.getByRole('button', { name: 'Mở lại kỳ', exact: true }).click();
    const reopen = page.getByRole('dialog', { name: 'Mở lại kỳ' });
    await reopen.getByRole('button', { name: 'Xác nhận mở lại' }).click();
    await expect(reopen.getByText('Nhập lý do mở lại kỳ công.')).toBeVisible();
    await reopen.getByLabel(/Lý do mở lại/).fill('Bổ sung điều chỉnh E2E');
    await reopen.getByRole('button', { name: 'Xác nhận mở lại' }).click();
    await expect(page.getByText('Đã chốt', { exact: true })).toHaveCount(0);
    await expect(history.getByRole('row').nth(1)).toContainText('Mở lại');
    await expect(history.getByRole('row').nth(1)).toContainText('Bổ sung điều chỉnh E2E');
  });
  await test.step('HR reads the leave reconciliation panel', async () => {
    await nav(page).getByRole('link', { name: 'Phép năm' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Phép năm' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Đối soát phép' })).toBeVisible();
    await expect(page.getByText('Không có đơn chờ vượt phép tích lũy.')).toBeVisible();
    await checkLayout(page, testInfo, 'hr-reconciliation-empty');

    // Accrual to month k is 480*k minutes (12 days, official since January); a -(480k - 240)
    // adjustment leaves 240 minutes (0.5 day) accrued to month k, below the pending day (480),
    // while month k+1 (720) covers it again: exactly one row, for month k.
    const month = Number(leaveDay.iso.slice(5, 7));
    const adjusted = await page.evaluate(
      async ({ id, minutes, effectiveOn }) => {
        const csrf = (await (await fetch('/api/auth/csrf')).json()) as { csrfToken: string };
        const response = await fetch(`/api/hr/employees/${id}/leave-adjustments`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf.csrfToken,
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({ minutes, effectiveOn, reference: 'QD-2026/LEAVE-E2E' }),
        });
        return response.status;
      },
      {
        id: employeeId,
        minutes: -(480 * month - 240),
        effectiveOn: `${leaveDay.iso.slice(0, 4)}-01-10`,
      },
    );
    expect(adjusted).toBe(201);
    await page.reload();
    // The panel defaults to the current year; a leave day just past New Year needs the year set.
    const thisYear = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })
      .format(new Date())
      .slice(0, 4);
    if (leaveDay.iso.slice(0, 4) !== thisYear) {
      await page.getByLabel('Năm').fill(leaveDay.iso.slice(0, 4));
    }
    const panel = page.getByRole('region', { name: 'Đối soát phép' });
    const rows = panel.getByRole('row').filter({ hasText: 'ATT001' });
    await expect(rows).toHaveCount(1);
    const cells = rows.getByRole('cell');
    await expect(cells.nth(0)).toContainText('Nhân Viên Công E2E');
    await expect(cells.nth(1)).toHaveText(String(month));
    await expect(cells.nth(2)).toHaveText('0,5 ngày');
    await expect(cells.nth(3)).toHaveText('0 ngày');
    await expect(cells.nth(4)).toHaveText('1 ngày');
    await expect(cells.nth(5)).toHaveText('0,5 ngày');
    await expect(cells.nth(6).getByRole('link')).toHaveText(leaveRequestId.slice(0, 8));
    await expect(panel.getByRole('row')).toHaveCount(2);
    await checkLayout(page, testInfo, 'hr-reconciliation');
  });
});

test('the employee timesheet dropped the cancelled late arrival and shows the adjustment only as a total', async ({
  page,
}) => {
  await login(page, 'employee-attendance-e2e', employeeEmail);
  await page.goto(`${stack.webOrigin}/attendance?month=${requestMonth}`);
  await expect(page.getByRole('region', { name: 'Đi muộn' })).toContainText(/^Đi muộn0 lần/);
  await page.goto(`${stack.webOrigin}/attendance?month=${MONTH}`);
  // The employee sees the adjustment only as a total, never its reason.
  await expect(page.getByRole('region', { name: 'Điều chỉnh của HR' })).toContainText('90 phút');
  await expect(page.getByText('Quên chấm công buổi chiều E2E')).toHaveCount(0);
});
