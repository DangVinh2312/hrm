import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { HrMe } from '../src/features/hr/hr.client';
import {
  type ReportClient,
  type ReportResult,
  createReportClient,
} from '../src/features/report/report.client';
import { ApiError, ResponseShapeError, createHttpClient } from '../src/infrastructure/http.client';
import { fakeAuth, fakeHr, renderRoutes } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const employeeId = '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22';
const me = (menus: HrMe['menus'] = ['reports']): HrMe => ({
  userId: session.userId,
  employee: null,
  menus,
  companyScope: true,
});
const who = { employeeId, employeeCode: 'NV001', employeeName: 'Nguyễn Văn A' };
const attendance = (total = '1'): ReportResult => ({
  kind: 'attendance',
  total,
  rows: [
    {
      ...who,
      month: '2026-11',
      periodState: 'closed',
      scheduledMinutes: 10080,
      paidHolidayMinutes: 0,
      unpaidMinutes: 120,
      annualLeaveMinutes: 480,
      paidMinutes: 9960,
      wfhDays: 2,
      lateCount: 1,
      lateMinutes: 60,
      earlyCount: 0,
      earlyMinutes: 0,
      adjustmentMinutes: -60,
    },
  ],
});
const birthday: ReportResult = {
  kind: 'birthday',
  total: '1',
  rows: [{ ...who, month: '2027-02', birthdayOn: '2027-02-28' }],
};
const seniority: ReportResult = {
  kind: 'seniority',
  total: '1',
  rows: [
    {
      ...who,
      hiredOn: '2025-01-01',
      asOn: '2026-12-31',
      years: 2,
      months: 0,
      days: 0,
      totalDays: 730,
    },
  ],
};

const xlsx = { blob: new Blob(['x']), fileName: 'hrm-report-attendance-2026-11_2026-11.xlsx' };
const render = (client: Partial<ReportClient> = {}, hrMe: HrMe = me(), path = '/reports') =>
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    path,
    {},
    fakeHr({ hr: { me: () => Promise.resolve(hrMe) }, report: client }),
  );
const monthInput = async (label: string, value: string) =>
  fireEvent.change(await screen.findByLabelText(label), { target: { value } });
const pickKind = async (name: string) =>
  userEvent.selectOptions(await screen.findByLabelText('Loại báo cáo'), name);

describe('report page', () => {
  it('is in the menu only when the server grants it, and a direct visit is "not found"', async () => {
    render({}, me([]));
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(screen.queryByRole('link', { name: 'Báo cáo' })).not.toBeInTheDocument();
  });

  it('shows not found on /reports without the menu, never asking for rows', async () => {
    const page = vi.fn(() => Promise.resolve(attendance()));
    render({ page }, me([]));
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
    expect(page).not.toHaveBeenCalled();
  });

  it('links from the menu and lists the attendance report with Vietnamese headers', async () => {
    const page = vi.fn(() => Promise.resolve(attendance()));
    render({ page }, me(), '/');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    await userEvent.click(await within(nav).findByRole('link', { name: 'Báo cáo' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Báo cáo' })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    for (const header of ['Mã nhân viên', 'Họ và tên', 'Tháng', 'Kỳ công', 'Công theo lịch'])
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    expect(within(table).getByText('NV001')).toBeInTheDocument();
    expect(within(table).getByText('Nguyễn Văn A')).toBeInTheDocument();
    expect(within(table).getByText('Đã chốt')).toBeInTheDocument();
    expect(within(table).getByText('1 lần · 60 phút')).toBeInTheDocument();
    expect(page).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'attendance' }),
      1,
      expect.anything(),
    );
  });

  it('shows the birthday as day and month only', async () => {
    render({
      page: (filter) => Promise.resolve(filter.kind === 'birthday' ? birthday : attendance()),
    });
    await screen.findByRole('table');
    await pickKind('Sinh nhật');
    const row = (await screen.findByText('28/02')).closest('tr')!;
    // The month column carries the year of the month shown, never a full date.
    expect(row).not.toHaveTextContent('2027-02-28');
    expect(row).not.toHaveTextContent('28/02/2027');
    expect(row).toHaveTextContent('NV001');
  });

  it('asks a cutoff report for an explicit date instead of a range', async () => {
    const page = vi.fn((filter: { kind: string }) =>
      Promise.resolve(filter.kind === 'seniority' ? seniority : attendance()),
    );
    render({ page });
    await screen.findByRole('table');
    await pickKind('Thâm niên');
    expect(await screen.findByText('2 năm 0 tháng 0 ngày')).toBeInTheDocument();
    expect(screen.queryByLabelText('Từ tháng')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tại ngày'), { target: { value: '2026-12-31' } });
    await waitFor(() =>
      expect(page).toHaveBeenLastCalledWith(
        { kind: 'seniority', asOn: '2026-12-31' },
        1,
        expect.anything(),
      ),
    );
  });

  it('refuses a range over 12 months or reversed before any request', async () => {
    const page = vi.fn(() => Promise.resolve(attendance()));
    const download = vi.fn(() => Promise.resolve(xlsx));
    render({ page, download });
    await screen.findByRole('table');
    page.mockClear();
    await monthInput('Từ tháng', '2025-01');
    await monthInput('Đến tháng', '2026-02');
    expect(await screen.findByText('Khoảng thời gian tối đa 12 tháng.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tải XLSX' })).toBeDisabled();
    await monthInput('Đến tháng', '2024-12');
    expect(
      await screen.findByText('Tháng bắt đầu phải trước hoặc bằng tháng kết thúc.'),
    ).toBeInTheDocument();
    // Exactly twelve months is allowed.
    await monthInput('Đến tháng', '2025-12');
    await waitFor(() =>
      expect(page).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2025-01', to: '2025-12' }),
        1,
        expect.anything(),
      ),
    );
    // Every rejected range above was refused before a request: only the valid one reached the API.
    expect(page).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
  });

  it('pages 20 rows at a time from the total', async () => {
    const page = vi.fn(() => Promise.resolve(attendance('45')));
    render({ page });
    await screen.findByRole('table');
    expect(screen.getByText('Tổng: 45')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() =>
      expect(page).toHaveBeenLastCalledWith(expect.anything(), 2, expect.anything()),
    );
  });

  it('says so when nothing is in scope', async () => {
    render({ page: () => Promise.resolve({ kind: 'attendance', total: '0', rows: [] }) });
    expect(
      await screen.findByText('Không có dòng nào trong phạm vi bạn xem được.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it.each([
    [new ApiError(403, 'error.accessDenied'), /Không thực hiện được thao tác này/],
    [new Error('socket'), /Hệ thống tạm thời không phản hồi/],
  ])('shows a load failure with retry (%#)', async (error, text) => {
    let fail = true;
    render({ page: () => (fail ? Promise.reject(error) : Promise.resolve(attendance())) });
    // A network failure is retried twice (1 s, 2 s) before the page shows it.
    expect(await screen.findByRole('alert', {}, { timeout: 8000 })).toHaveTextContent(text);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});

describe('report export', () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  const create = vi.fn(() => 'blob:fake');
  const revoke = vi.fn();
  beforeEach(() => {
    click.mockClear();
    create.mockClear();
    revoke.mockClear();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  });
  afterEach(() => vi.useRealTimers());

  const exportButton = async () => {
    await screen.findByRole('table');
    return screen.getByRole('button', { name: 'Tải XLSX' });
  };

  it('downloads the file of the current filter and releases the object URL', async () => {
    const download = vi.fn(() => Promise.resolve(xlsx));
    render({ page: () => Promise.resolve(attendance()), download });
    await userEvent.click(await exportButton());
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'attendance' }),
      expect.any(AbortSignal),
    );
    expect(create).toHaveBeenCalledWith(xlsx.blob);
    expect(revoke).toHaveBeenCalledWith('blob:fake');
    expect(screen.queryByText(/Không tải được tệp/)).not.toBeInTheDocument();
  });

  it.each([
    [
      new ApiError(403, 'error.accessDenied'),
      /Bạn không có quyền tải báo cáo này hoặc không có dòng nào/,
    ],
    [new ApiError(422, 'error.exportTooLarge'), /nhiều dòng hơn mức một tệp chứa được/],
    [new Error('socket'), /Hệ thống tạm thời không phản hồi/],
  ])('shows the reason a file is not delivered (%#)', async (error, text) => {
    render({ page: () => Promise.resolve(attendance()), download: () => Promise.reject(error) });
    await userEvent.click(await exportButton());
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
  });

  it('cancels a running download when the user leaves the page', async () => {
    let signal: AbortSignal | undefined;
    const download = vi.fn((_filter: unknown, s?: AbortSignal) => {
      signal = s;
      return new Promise<never>(() => undefined);
    });
    const view = render({ page: () => Promise.resolve(attendance()), download });
    await userEvent.click(await exportButton());
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);
    await act(async () => {
      await view.router.navigate('/');
    });
    expect(signal!.aborted).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });
});

describe('report client', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('asks for a page of the right report with its own query keys only', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(attendance('1'))));
    const client = createReportClient(createHttpClient(fetchImpl));
    await client.page({ kind: 'attendance', from: '2026-11', to: '2026-11' }, 3);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      '/api/hr/reports/attendance?from=2026-11&to=2026-11&limit=20&offset=40',
    );
    fetchImpl.mockResolvedValueOnce(json(seniority));
    await client.page({ kind: 'seniority', asOn: '2026-12-31' }, 1);
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      '/api/hr/reports/seniority?asOn=2026-12-31&limit=20&offset=0',
    );
  });

  it('rejects a body of another report or a row that breaks the contract', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(birthday)));
    const client = createReportClient(createHttpClient(fetchImpl));
    await expect(
      client.page({ kind: 'attendance', from: '2026-11', to: '2026-11' }, 1),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('downloads an XLSX with a name from the report and its range, never from the response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('PK', {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': 'attachment; filename="../evil.xlsx"',
          },
        }),
      ),
    );
    const client = createReportClient(createHttpClient(fetchImpl));
    const file = await client.download({ kind: 'leave', asOn: '2026-11-30' });
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/hr/reports/leave/export?asOn=2026-11-30');
    expect(file.fileName).toBe('hrm-report-leave-2026-11-30.xlsx');
    expect(file.blob.size).toBe(2);
  });

  it('refuses a download that is not an XLSX and keeps the API error code of a failure', async () => {
    const html = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<html>', { headers: { 'content-type': 'text/html' } })),
    );
    await expect(
      createReportClient(createHttpClient(html)).download({ kind: 'leave', asOn: '2026-11-30' }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
    const denied = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ statusCode: 403, code: 'error.accessDenied' }), {
          status: 403,
        }),
      ),
    );
    await expect(
      createReportClient(createHttpClient(denied)).download({ kind: 'leave', asOn: '2026-11-30' }),
    ).rejects.toMatchObject({ status: 403, code: 'error.accessDenied' });
  });
});
