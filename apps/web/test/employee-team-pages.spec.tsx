import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { Employee } from '../src/features/employee/employee.client';
import { ApiError } from '../src/infrastructure/http.client';
import { navigateToExternal } from '../src/infrastructure/external-navigation.helper';
import type { Team } from '../src/features/team/team.client';
import { fakeAuth, fakeServices, renderRoutes, type Viewer } from './render.helper';

vi.mock('../src/infrastructure/external-navigation.helper', () => ({
  navigateToExternal: vi.fn(),
}));

afterEach(() => {
  vi.mocked(navigateToExternal).mockReset();
});

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const auth = (overrides = {}) =>
  fakeAuth({ session: () => Promise.resolve(session), ...overrides });
const ids = {
  employee: '7d3f5a2e-4b1c-4e8a-9f60-2c1d3b4a5e6f',
  other: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  team: '3a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
};
const me = (patch: Partial<Viewer> = {}): Viewer => ({
  userId: session.userId,
  employee: null,
  menus: [],
  companyScope: false,
  ...patch,
});
const companyViewer = me({ companyScope: true, menus: ['employees'] });
const employee: Employee = {
  id: ids.employee,
  code: 'NV001',
  fullName: 'Nguyễn Văn A',
  hiredOn: '2026-01-05',
  terminatedOn: null,
  state: 'probation',
  version: '3',
  accountId: null,
  position: 'Kỹ sư phần mềm',
  classification: 'fullTime',
  periods: [{ status: 'probation', startsOn: '2026-01-05', endsOn: null }],
  teams: [{ id: ids.team, name: 'Kỹ thuật', primary: true, since: '2026-01-05T02:00:00.000000Z' }],
};

describe('shell menus', () => {
  it('shows only the menus the server granted', async () => {
    renderRoutes(
      routes,
      auth(),
      '/',
      {},
      fakeServices({ viewer: me({ menus: ['employees', 'teams'] }) }),
    );
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByRole('link', { name: 'Nhân viên' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Team' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Phê duyệt' })).toBeNull();
  });

  it('keeps the menu minimal when there is no grant and links the own profile', async () => {
    renderRoutes(
      routes,
      auth(),
      '/',
      {},
      fakeServices({
        viewer: me({ employee: { id: ids.employee, code: 'NV001', fullName: 'Nguyễn Văn A' } }),
      }),
    );
    expect(await screen.findByText('NV001 · Nguyễn Văn A')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Xem hồ sơ' })).toHaveAttribute(
      'href',
      `/employees/${ids.employee}`,
    );
    const nav = screen.getByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).queryByRole('link', { name: 'Nhân viên' })).toBeNull();
  });
});

describe('employee list', () => {
  it('lists visible employees with team and status, and an empty search result', async () => {
    const list = vi.fn((query: { search: string }) =>
      Promise.resolve(
        query.search
          ? { items: [], total: '0' }
          : {
              items: [
                {
                  id: ids.employee,
                  code: 'NV001',
                  fullName: 'Nguyễn Văn A',
                  state: 'probation' as const,
                  primaryTeam: { id: ids.team, name: 'Kỹ thuật' },
                },
              ],
              total: '1',
            },
      ),
    );
    renderRoutes(routes, auth(), '/employees', {}, fakeServices({ employees: { list } }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Nhân viên' })).toBeInTheDocument();
    const row = (await screen.findByRole('link', { name: 'NV001' })).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Kỹ thuật')).toBeInTheDocument();
    expect(within(row!).getByText('Thử việc')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Tìm nhân viên'), 'không có');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));
    expect(await screen.findByText('Không có nhân viên nào khớp với từ khóa.')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith({ page: 1, search: 'không có' }, expect.anything());
  });

  it('shows a load failure with retry, never the response body', async () => {
    let calls = 0;
    const list = vi.fn(() =>
      ++calls === 1
        ? Promise.reject(new ApiError(400, 'error.invalidRequest'))
        : Promise.resolve({ items: [], total: '0' }),
    );
    renderRoutes(routes, auth(), '/employees', {}, fakeServices({ employees: { list } }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Không tải được dữ liệu')).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Chưa có nhân viên nào.')).toBeInTheDocument();
  });

  it('offers no create action without company scope', async () => {
    renderRoutes(
      routes,
      auth(),
      '/employees',
      {},
      fakeServices({
        viewer: me({ menus: ['employees'] }),
        employees: { list: () => Promise.resolve({ items: [], total: '0' }) },
      }),
    );
    expect(await screen.findByText('Chưa có nhân viên nào.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thêm nhân viên' })).toBeNull();
  });

  it('validates the create form and sends leave in minutes with empty F2 as null', async () => {
    const create = vi.fn(() => Promise.resolve({ id: ids.employee }));
    const { router } = renderRoutes(
      routes,
      auth(),
      '/employees',
      {},
      fakeServices({
        viewer: companyViewer,
        employees: { create, detail: () => Promise.resolve(employee) },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm nhân viên' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));
    expect(within(dialog).getByText(/Mã nhân viên chỉ gồm/)).toBeInTheDocument();
    expect(within(dialog).getByText('Vui lòng nhập thông tin này.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(/Mã nhân viên/), 'NV001');
    await userEvent.type(within(dialog).getByLabelText(/Họ và tên/), 'Nguyễn Văn A');
    // A day that does not exist is refused, not rolled over into the next month.
    await userEvent.type(within(dialog).getByLabelText(/Ngày vào làm/), '31/02/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));
    expect(within(dialog).getByText('Ngày không hợp lệ.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText(/Ngày vào làm/));
    await userEvent.type(within(dialog).getByLabelText(/Ngày vào làm/), '05/01/2026');
    await userEvent.click(
      within(
        within(dialog).getByRole('radiogroup', { name: /Trạng thái làm việc/ }),
      ).getByLabelText('Chính thức'),
    );
    await userEvent.type(within(dialog).getByLabelText(/Số giấy tờ/), '001090000001');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));
    // A number without its document type is refused next to the field.
    expect(await within(dialog).findByText(/Nhập cả loại giấy tờ/)).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText(/Số giấy tờ/));
    // Phone and work email are checked next to the field with the API rules.
    await userEvent.type(within(dialog).getByLabelText('Điện thoại'), '12345');
    await userEvent.type(within(dialog).getByLabelText('Email công việc'), 'khong-hop-le');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));
    expect(await within(dialog).findByText(/Số điện thoại gồm 10–11 chữ số/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Email công việc không hợp lệ/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText('Điện thoại'));
    await userEvent.type(within(dialog).getByLabelText('Điện thoại'), '+84 90 123 4567');
    await userEvent.clear(within(dialog).getByLabelText('Email công việc'));
    await userEvent.type(within(dialog).getByLabelText('Email công việc'), ' A.B@Example.COM ');
    await userEvent.type(within(dialog).getByLabelText('Chức danh'), '  Kỹ sư  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/employees/${ids.employee}`));
    expect(create).toHaveBeenCalledWith({
      code: 'NV001',
      fullName: 'Nguyễn Văn A',
      hiredOn: '2026-01-05',
      status: 'official',
      annualLeaveMinutes: 5760,
      identity: {
        dateOfBirth: null,
        documentKind: null,
        documentNumber: null,
        taxCode: null,
        gender: null,
        phone: '0901234567',
        workEmail: 'a.b@example.com',
      },
      position: 'Kỹ sư',
      classification: null,
    });
    // Many typed fields: well above the 5 s default when the suite runs next to the API tests.
  }, 20_000);

  it('a write refused with 403 asks for two-step verification and never leaves for Google', async () => {
    renderRoutes(
      routes,
      auth(),
      '/employees',
      {},
      fakeServices({
        viewer: companyViewer,
        employees: { create: () => Promise.reject(new ApiError(403, 'error.accessDenied')) },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm nhân viên' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Mã nhân viên/), 'NV002');
    await userEvent.type(within(dialog).getByLabelText(/Họ và tên/), 'Trần Thị B');
    await userEvent.type(within(dialog).getByLabelText(/Ngày vào làm/), '05/01/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));
    expect(await within(dialog).findByText('Không thực hiện được thao tác')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/cần xác thực 2 lớp trong 5 phút gần nhất/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Xác thực lại với Google' })).toBeNull();
    expect(navigateToExternal).not.toHaveBeenCalled();
  });
});

describe('employee detail', () => {
  it('shows F1 only to a lead: no identity section, no HR buttons', async () => {
    const identity = vi.fn(() => Promise.reject(new ApiError(404, 'error.notFound')));
    renderRoutes(
      routes,
      auth(),
      `/employees/${ids.employee}`,
      {},
      fakeServices({ employees: { detail: () => Promise.resolve(employee), identity } }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Nguyễn Văn A' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('05/01/2026').length).toBeGreaterThan(0);
    await waitFor(() => expect(identity).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Thông tin định danh' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Định mức phép năm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sửa' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Xác nhận chính thức' })).toBeNull();
  });

  it('shows F2/F3 and HR actions with company scope; absent ids look not found', async () => {
    renderRoutes(
      routes,
      auth(),
      `/employees/${ids.employee}`,
      {},
      fakeServices({
        viewer: me({ companyScope: true, menus: ['employees'] }),
        employees: {
          detail: () => Promise.resolve(employee),
          identity: () =>
            Promise.resolve({
              employeeId: ids.employee,
              version: '1',
              dateOfBirth: '1990-02-28',
              documentKind: 'cccd',
              documentNumber: '001090000001',
              taxCode: '0100000001',
              gender: 'female',
              phone: '0901234567',
              workEmail: 'nguyen.van.a@example.com',
            }),
          leaveRates: () =>
            Promise.resolve([{ id: ids.other, effectiveFrom: '2026-01-05', annualMinutes: 6240 }]),
        },
      }),
    );
    expect(await screen.findByText('CCCD · 001090000001')).toBeInTheDocument();
    expect(screen.getByText('28/02/1990')).toBeInTheDocument();
    expect(screen.getByText('Nữ')).toBeInTheDocument();
    expect(screen.getByText('0901234567')).toBeInTheDocument();
    expect(screen.getByText('nguyen.van.a@example.com')).toBeInTheDocument();
    expect(screen.getByText('Kỹ sư phần mềm')).toBeInTheDocument();
    expect(screen.getByText('Toàn thời gian')).toBeInTheDocument();
    // Probation has no leave rate block (ADR 0039): a note instead, no "add" button.
    expect(screen.queryByRole('heading', { name: 'Định mức phép năm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thêm định mức mới' })).toBeNull();
    expect(screen.getByText('Định mức phép năm phát sinh khi lên chính thức.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Xác nhận chính thức' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sửa' })).toHaveLength(2);
  });

  it('renders the not-found message for an id outside the scope', async () => {
    renderRoutes(routes, auth(), `/employees/${ids.other}`, {}, fakeServices());
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
  });
});

describe('teams', () => {
  const team: Team = {
    id: ids.team,
    name: 'Kỹ thuật',
    version: '2',
    lead: { employeeId: ids.other, code: 'NV009', fullName: 'Lê Văn L' },
    members: [
      {
        employeeId: ids.employee,
        code: 'NV001',
        fullName: 'Nguyễn Văn A',
        primary: true,
        since: '2026-01-05T02:00:00.000000Z',
      },
    ],
    leadHistory: [
      {
        employeeId: ids.other,
        code: 'NV009',
        fullName: 'Lê Văn L',
        startsAt: '2026-01-05T02:00:00.000000Z',
        endsAt: null,
      },
    ],
  };
  const teamList = () =>
    Promise.resolve({
      items: [{ id: ids.team, name: 'Kỹ thuật', lead: team.lead, memberCount: 1 }],
      total: '1',
    });

  it('shows members and lead read-only without company scope', async () => {
    renderRoutes(
      routes,
      auth(),
      '/teams',
      {},
      fakeServices({ teams: { list: teamList, detail: () => Promise.resolve(team) } }),
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Kỹ thuật' })).toBeInTheDocument();
    expect(screen.getAllByText(/Lê Văn L/).length).toBeGreaterThan(0);
    expect(screen.getByText('Team chính')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Phân công' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Xóa khỏi team/ })).toBeNull();
  });

  it('lets HR end a membership and clear the lead, then reloads the team', async () => {
    const endMembership = vi.fn(() => Promise.resolve());
    const assignLead = vi.fn(() => Promise.resolve());
    const detail = vi.fn(() => Promise.resolve(team));
    renderRoutes(
      routes,
      auth(),
      `/teams?team=${ids.team}`,
      {},
      fakeServices({
        viewer: me({ companyScope: true, menus: ['teams'] }),
        teams: { list: teamList, detail, endMembership, assignLead },
      }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Xóa khỏi team: Nguyễn Văn A' }),
    );
    await waitFor(() => expect(endMembership).toHaveBeenCalledWith(ids.team, ids.employee));
    await userEvent.click(screen.getByRole('button', { name: 'Bỏ trưởng nhóm' }));
    await waitFor(() => expect(assignLead).toHaveBeenCalledWith(ids.team, null));
    await waitFor(() => expect(detail.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  describe('lead is a member (ADR 0040)', () => {
    const memberRow = (employeeId: string, code: string, fullName: string, primary = true) => ({
      employeeId,
      code,
      fullName,
      primary,
      since: '2026-01-05T02:00:00.000000Z',
    });
    const led: Team = {
      ...team,
      lead: { employeeId: ids.employee, code: 'NV001', fullName: 'Nguyễn Văn A' },
      members: [
        memberRow(ids.employee, 'NV001', 'Nguyễn Văn A'),
        memberRow(ids.other, 'NV009', 'Lê Văn L', false),
      ],
    };
    const services = (assignLead = vi.fn(() => Promise.resolve())) =>
      fakeServices({
        viewer: me({ companyScope: true, menus: ['teams'] }),
        teams: { list: teamList, detail: () => Promise.resolve(led), assignLead },
      });

    it('marks the current lead inside the member list and keeps the lead from leaving', async () => {
      renderRoutes(routes, auth(), `/teams?team=${ids.team}`, {}, services());
      const rowOf = async (name: string) =>
        (await screen.findByRole('button', { name: `Xóa khỏi team: ${name}` })).closest(
          'tr',
        ) as HTMLElement;
      expect(within(await rowOf('Nguyễn Văn A')).getByText('Trưởng nhóm')).toBeInTheDocument();
      expect(within(await rowOf('Lê Văn L')).queryByText('Trưởng nhóm')).toBeNull();
      expect(screen.getByRole('button', { name: 'Xóa khỏi team: Nguyễn Văn A' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Xóa khỏi team: Lê Văn L' })).toBeEnabled();
    });

    it('offers only open members other than the lead as the next lead', async () => {
      const assignLead = vi.fn(() => Promise.resolve());
      renderRoutes(routes, auth(), `/teams?team=${ids.team}`, {}, services(assignLead));
      await userEvent.click(await screen.findByRole('combobox', { name: /Chọn trưởng nhóm/ }));
      const options = await screen.findAllByRole('option', { hidden: true });
      expect(options.map((option) => option.textContent)).toEqual(['NV009 · Lê Văn L']);
      await userEvent.click(options[0] as HTMLElement);
      await userEvent.click(screen.getByRole('button', { name: 'Phân công' }));
      await waitFor(() => expect(assignLead).toHaveBeenCalledWith(ids.team, ids.other));
    });
  });
});
