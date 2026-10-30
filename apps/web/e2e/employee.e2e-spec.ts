import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { startStack, type TestStack } from './stack.helper.ts';
import { stableStep, totp } from './totp.helper.ts';

// T3 acceptance in the browser: HR manages employees and teams, Root assigns members and the lead
// (team.assign is boundary-required, so no IAM account can yet), a user without HR roles sees no
// HR menu or action. Own stack: three OIDC begins (HR, Root activation, plain employee).
let stack: TestStack;
let employeeUrl = '';

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

/** HR writes need a step-up from the last 5 minutes; enrolling 2FA leaves the session fresh. */
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
    // Below `sm` the sidebar is a drawer behind the burger; from `sm` it is always shown.
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

async function createEmployee(page: Page, code: string, fullName: string) {
  await page.goto(`${stack.webOrigin}/employees`);
  await page.getByRole('button', { name: 'Thêm nhân viên' }).click();
  const dialog = page.getByRole('dialog', { name: 'Thêm hồ sơ nhân viên' });
  await dialog.getByLabel(/Mã nhân viên/).fill(code);
  await dialog.getByLabel(/Họ và tên/).fill(fullName);
  await dialog.getByLabel(/Ngày vào làm/).fill('05/01/2026');
  await dialog.getByRole('button', { name: 'Tạo hồ sơ' }).click();
  await page.waitForURL(/\/employees\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: fullName })).toBeVisible();
  return page.url();
}

async function pick(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
}

test('HR creates, views and updates employees and creates a team; assignment stays Root-only', async ({
  page,
}, testInfo) => {
  const email = 'hr-e2e@example.test';
  await stack.grantRole(await stack.enrollByEmail(email), 'hr.admin');
  await signIn(page, 'hr-e2e', email);
  await expect(nav(page).getByRole('link', { name: 'Nhân viên' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Team' })).toBeVisible();
  await enrollTwoStep(page);

  // Create with F2 (fixture document number), view, then update F1.
  await page.goto(`${stack.webOrigin}/employees`);
  await page.getByRole('button', { name: 'Thêm nhân viên' }).click();
  const create = page.getByRole('dialog', { name: 'Thêm hồ sơ nhân viên' });
  await create.getByLabel(/Mã nhân viên/).fill('E2E001');
  await create.getByLabel(/Họ và tên/).fill('Nhân viên Một');
  await create.getByLabel(/Ngày vào làm/).fill('05/01/2026');
  // Leave the field like a keyboard user: its calendar otherwise covers the fields below.
  await create.getByLabel(/Ngày vào làm/).press('Tab');
  await create.getByRole('combobox', { name: 'Loại giấy tờ' }).click();
  await page.getByRole('option', { name: 'CCCD' }).click();
  await create.getByLabel('Số giấy tờ').fill('000000000001');
  await create.getByRole('button', { name: 'Tạo hồ sơ' }).click();
  await page.waitForURL(/\/employees\/[0-9a-f-]{36}$/);
  employeeUrl = page.url();
  await expect(page.getByRole('heading', { level: 1, name: 'Nhân viên Một' })).toBeVisible();
  await expect(page.getByText(/000000000001/)).toBeVisible();

  await page.getByRole('button', { name: 'Sửa', exact: true }).first().click();
  const edit = page.getByRole('dialog', { name: 'Sửa thông tin cơ bản' });
  await edit.getByLabel(/Họ và tên/).fill('Nhân viên Một Đã Sửa');
  await edit.getByRole('button', { name: 'Lưu' }).click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Nhân viên Một Đã Sửa' })).toBeVisible();
  await checkLayout(page, testInfo, 'employee-detail');

  await createEmployee(page, 'E2E002', 'Trưởng Nhóm Hai');
  await page.goto(`${stack.webOrigin}/employees`);
  await expect(page.getByRole('link', { name: 'E2E001' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'E2E002' })).toBeVisible();
  await checkLayout(page, testInfo, 'employee-list');

  await page.goto(`${stack.webOrigin}/teams`);
  await page.getByRole('button', { name: 'Thêm team' }).click();
  await page
    .getByRole('dialog', { name: 'Thêm team' })
    .getByLabel(/Tên team/)
    .fill('Team E2E');
  await page.getByRole('button', { name: 'Tạo team' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Team E2E' })).toBeVisible();
  // team.assign is boundary-required with no binding yet: HR, even fresh, is refused.
  await pick(page, 'Thêm thành viên', 'E2E001 · Nhân viên Một Đã Sửa');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByText('Không thực hiện được thao tác')).toBeVisible();
  await expect(page.getByText('Team chưa có thành viên.')).toBeVisible();
  await checkLayout(page, testInfo, 'team');
});

test('Root assigns a member and the lead; the profile shows the team', async ({
  page,
}, testInfo) => {
  const email = 'root-e2e@example.test';
  const token = await stack.bootstrapRoot(email);
  stack.idp.subject = 'root-e2e';
  stack.idp.email = email;
  await page.goto(`${stack.webOrigin}/activate#token=${token}`);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await expect(page).toHaveURL(`${stack.webOrigin}/`, { timeout: 15_000 });
  await enrollTwoStep(page);

  await page.goto(`${stack.webOrigin}/teams`);
  await expect(page.getByRole('heading', { level: 2, name: 'Team E2E' })).toBeVisible();
  await pick(page, 'Thêm thành viên', 'E2E001 · Nhân viên Một Đã Sửa');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'E2E001' })).toBeVisible();
  await pick(page, 'Thêm thành viên', 'E2E002 · Trưởng Nhóm Hai');
  await page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'E2E002' })).toBeVisible();
  await pick(page, 'Chọn trưởng nhóm', 'E2E002 · Trưởng Nhóm Hai');
  await page.getByRole('button', { name: 'Phân công' }).click();
  await expect(page.getByText('E2E002 · Trưởng Nhóm Hai', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Lịch sử trưởng nhóm')).toBeVisible();
  // The change settles (team, employee and menu reloads) before the layout is captured.
  await expect(page.getByRole('button', { name: 'Bỏ trưởng nhóm' })).toBeEnabled();
  await checkLayout(page, testInfo, 'team-assigned');

  await page.goto(employeeUrl);
  await expect(page.getByText('Team E2E · Team chính')).toBeVisible();
});

test('without HR roles: no HR menu, no create action, another profile is not found', async ({
  page,
}) => {
  const email = 'plain-e2e@example.test';
  await stack.enrollByEmail(email);
  await signIn(page, 'plain-e2e', email);
  await expect(nav(page).getByRole('link', { name: 'Tổng quan' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Nhân viên' })).toHaveCount(0);
  await expect(nav(page).getByRole('link', { name: 'Team' })).toHaveCount(0);

  await page.goto(`${stack.webOrigin}/employees`);
  await expect(page.getByText('Chưa có nhân viên nào.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thêm nhân viên' })).toHaveCount(0);
  await page.goto(`${stack.webOrigin}/teams`);
  await expect(page.getByText('Chưa có team nào.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Thêm team' })).toHaveCount(0);
  await page.goto(employeeUrl);
  await expect(page.getByText('Không tìm thấy trang')).toBeVisible();
  await expect(page.getByText('Nhân viên Một Đã Sửa')).toHaveCount(0);
});
