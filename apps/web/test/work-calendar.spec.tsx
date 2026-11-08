import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import { ApiError } from '../src/infrastructure/http.client';
import type {
  CalendarYear,
  WorkCalendarClient,
} from '../src/features/work-calendar/work-calendar.client';
import { fakeAuth, fakeServices, renderRoutes, standardWeek, type Viewer } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const auth = () => fakeAuth({ session: () => Promise.resolve(session) });
const me = (patch: Partial<Viewer> = {}): Viewer => ({
  userId: session.userId,
  employee: null,
  menus: ['calendar'],
  companyScope: false,
  ...patch,
});
// Holiday names are fixtures, not the legal calendar.
const year2026: CalendarYear = {
  version: '3',
  year: 2026,
  holidays: [
    { date: '2026-09-02', name: 'Ngày lễ giả A' },
    { date: '2026-12-31', name: 'Ngày lễ giả B' },
  ],
  makeupDays: [{ date: '2026-08-29', asWeekday: 1, frameSource: 'company' }],
};
const calendarOf = (data: CalendarYear) => ({
  year: vi.fn((year: number) => Promise.resolve({ ...data, year })),
});

async function pickOption(scope: HTMLElement, label: string, option: string) {
  await userEvent.click(within(scope).getByRole('combobox', { name: label }));
  const options = await screen.findAllByRole('option', { name: option, hidden: true });
  await userEvent.click(options[options.length - 1]!);
}

// Typing dates into several dialogs of a full page takes longer than the default 5 s in jsdom.
describe('work calendar', { timeout: 15_000 }, () => {
  it('is in the menu only when the server grants it', async () => {
    renderRoutes(routes, auth(), '/', {}, fakeServices({ viewer: me() }));
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByRole('link', { name: 'Lịch làm việc' })).toHaveAttribute(
      'href',
      '/calendar',
    );
  });

  it('shows the standard week and the year holidays, read-only without company scope', async () => {
    const workCalendar = calendarOf(year2026);
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({ viewer: me(), workCalendar }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Lịch làm việc' }),
    ).toBeInTheDocument();
    // The company week in force (ADR-19), one row per weekday; no change button without scope.
    const week = await screen.findByRole('table', { name: 'Đang áp dụng' });
    expect(within(week).getByRole('row', { name: /Thứ Hai/ })).toHaveTextContent(
      '09:00–13:00, 14:00–18:00',
    );
    expect(within(week).getByRole('row', { name: /Thứ Bảy/ })).toHaveTextContent('Nghỉ');
    expect(screen.queryByRole('button', { name: 'Đổi giờ làm' })).toBeNull();
    const row = (await screen.findByText('Ngày lễ giả A')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('02/09/2026')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Thứ Tư')).toBeInTheDocument();
    expect(screen.getByText('Ngày lễ giả B')).toBeInTheDocument();
    expect(workCalendar.year).toHaveBeenCalledWith(2026, expect.anything());
    expect(screen.queryByRole('button', { name: 'Thêm ngày nghỉ lễ' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Bỏ ngày nghỉ/ })).toBeNull();
    // Makeup days are their own list, with the weekday spelled out (not by colour).
    const makeup = screen
      .getByRole('heading', { level: 2, name: 'Ngày làm bù' })
      .closest('section');
    expect(makeup).not.toBeNull();
    const makeupRow = within(makeup as HTMLElement)
      .getByText('29/08/2026')
      .closest('tr');
    expect(within(makeupRow as HTMLElement).getByText('Thứ Bảy')).toBeInTheDocument();
    expect(makeupRow).toHaveTextContent('Như Thứ Hai · giờ chung');
    expect(within(makeup as HTMLElement).queryByText('Ngày lễ giả A')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thêm ngày làm bù' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Bỏ ngày làm bù/ })).toBeNull();
  });

  it('moves between years through the URL', async () => {
    const workCalendar = calendarOf({ ...year2026, holidays: [] });
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({ viewer: me(), workCalendar }),
    );
    expect(await screen.findByText('Chưa có ngày nghỉ lễ nào trong năm này.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Năm sau' }));
    await waitFor(() => expect(workCalendar.year).toHaveBeenCalledWith(2027, expect.anything()));
    expect(await screen.findByText('2027')).toBeInTheDocument();
  });

  const typeRange = async (dialog: HTMLElement, from: string, to: string, name?: string) => {
    await userEvent.clear(within(dialog).getByLabelText(/Từ ngày/));
    await userEvent.type(within(dialog).getByLabelText(/Từ ngày/), from);
    await userEvent.clear(within(dialog).getByLabelText(/Đến ngày/));
    await userEvent.type(within(dialog).getByLabelText(/Đến ngày/), to);
    if (name !== undefined)
      await userEvent.type(within(dialog).getByLabelText(/Tên ngày nghỉ/), name);
  };

  it('lets HR add a holiday range, shows how many days apply and refuses bad ranges before the API', async () => {
    const setHolidays = vi.fn(() => Promise.resolve({ version: '7' }));
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({
        viewer: me({ companyScope: true }),
        workCalendar: { ...calendarOf(year2026), setHolidays },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm ngày nghỉ lễ' }));
    const dialog = await screen.findByRole('dialog');
    // Saturday-Sunday only: nothing would change.
    await typeRange(dialog, '07/11/2026', '08/11/2026', 'Ngày lễ giả C');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    expect(await within(dialog).findByText(/chỉ có ngày nghỉ của lịch chung/)).toBeInTheDocument();
    // Reversed range.
    await typeRange(dialog, '05/11/2026', '02/11/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    expect(
      await within(dialog).findByText(/Ngày kết thúc không được trước ngày bắt đầu/),
    ).toBeInTheDocument();
    // More than 31 calendar days.
    await typeRange(dialog, '01/11/2026', '02/12/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    expect(await within(dialog).findByText(/tối đa 31 ngày/)).toBeInTheDocument();
    expect(setHolidays).not.toHaveBeenCalled();
    // 30/12/2026 (Wed) .. 04/01/2027 (Mon): crosses the year; Wed, Thu, Fri and Mon = 4 weekdays.
    await typeRange(dialog, '30/12/2026', '04/01/2027');
    expect(await within(dialog).findByText(/Số ngày nghỉ sẽ áp dụng.*: 4/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(setHolidays).toHaveBeenCalledWith({
        expectedVersion: '3',
        from: '2026-12-30',
        to: '2027-01-04',
        name: 'Ngày lễ giả C',
      }),
    );
  });

  it('follows the company week: a working Saturday takes a holiday and no makeup', async () => {
    const saturday = standardWeek.map((frame, index): [number, number][] =>
      index === 5 ? [[480, 720]] : frame,
    );
    const setHolidays = vi.fn(() => Promise.resolve({ version: '4' }));
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({
        viewer: me({ companyScope: true }),
        workCalendar: {
          ...calendarOf(year2026),
          setHolidays,
          schedule: () =>
            Promise.resolve({
              today: '2026-11-04',
              maxMinutes: 480,
              versions: [{ effectiveFrom: '1900-01-01', days: saturday }],
            }),
        },
      }),
    );
    await screen.findByRole('table', { name: 'Đang áp dụng' });
    await userEvent.click(screen.getByRole('button', { name: 'Thêm ngày làm bù' }));
    const makeup = await screen.findByRole('dialog', { name: 'Thêm ngày làm bù' });
    await userEvent.type(within(makeup).getByLabelText(/^Ngày/), '07/11/2026');
    await userEvent.click(within(makeup).getByRole('button', { name: 'Lưu' }));
    expect(await within(makeup).findByText(/Lịch chung đã làm việc ngày này/)).toBeVisible();
    await userEvent.click(within(makeup).getByRole('button', { name: 'Hủy' }));

    await userEvent.click(screen.getByRole('button', { name: 'Thêm ngày nghỉ lễ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm ngày nghỉ lễ' });
    await typeRange(dialog, '07/11/2026', '08/11/2026', 'Ngày lễ giả C');
    expect(await within(dialog).findByText(/Số ngày nghỉ sẽ áp dụng.*: 1/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(setHolidays).toHaveBeenCalledWith({
        expectedVersion: '3',
        from: '2026-11-07',
        to: '2026-11-08',
        name: 'Ngày lễ giả C',
      }),
    );
  });

  it('lets HR turn a holiday back into a workday with the version it saw', async () => {
    const setDay = vi.fn(() => Promise.resolve({ version: '4' }));
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({
        viewer: me({ companyScope: true }),
        workCalendar: { ...calendarOf(year2026), setDay },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Bỏ ngày nghỉ 02/09/2026' }));
    await waitFor(() =>
      expect(setDay).toHaveBeenCalledWith('2026-09-02', { expectedVersion: '3', holiday: null }),
    );
  });

  it('lets HR make a day off a makeup day with the hours of a chosen weekday', async () => {
    const setDay = vi.fn(() => Promise.resolve({ version: '4' }));
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({
        viewer: me({ companyScope: true }),
        workCalendar: { ...calendarOf({ ...year2026, makeupDays: [] }), setDay },
      }),
    );
    expect(await screen.findByText('Chưa có ngày làm bù nào trong năm này.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm ngày làm bù' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm ngày làm bù' });
    // A Monday the company week works is refused before the API.
    await userEvent.type(within(dialog).getByLabelText(/^Ngày/), '09/11/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    expect(await within(dialog).findByText(/Lịch chung đã làm việc ngày này/)).toBeVisible();
    expect(setDay).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText(/^Ngày/));
    await userEvent.type(within(dialog).getByLabelText(/^Ngày/), '08/11/2026');
    await pickOption(dialog, 'Làm theo giờ của', 'Thứ Ba');
    await pickOption(dialog, 'Lấy giờ từ', 'giờ riêng của từng người');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(setDay).toHaveBeenCalledWith('2026-11-08', {
        expectedVersion: '3',
        makeup: { asWeekday: 2, frameSource: 'employee' },
      }),
    );
  });

  it('lets HR turn a makeup day back into a weekly rest with the version it saw', async () => {
    const setDay = vi.fn(() => Promise.resolve({ version: '4' }));
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({
        viewer: me({ companyScope: true }),
        workCalendar: { ...calendarOf(year2026), setDay },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Bỏ ngày làm bù 29/08/2026' }));
    await waitFor(() =>
      expect(setDay).toHaveBeenCalledWith('2026-08-29', { expectedVersion: '3', makeup: null }),
    );
  });

  it('explains a stale calendar after a conflict', async () => {
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({
        viewer: me({ companyScope: true }),
        workCalendar: {
          ...calendarOf(year2026),
          setDay: () => Promise.reject(new ApiError(409, 'error.conflict')),
        },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Bỏ ngày nghỉ 02/09/2026' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('vừa được người khác thay đổi');
  });

  // The calendar changed under HR: the first read is version 3, every later one version 5.
  const staleThenFresh = () => {
    let reads = 0;
    return {
      year: vi.fn((year: number) =>
        Promise.resolve({ ...year2026, year, version: reads++ === 0 ? '3' : '5' }),
      ),
    };
  };
  const conflictThenOk = () => {
    const setDay = vi
      .fn<(date: string, change: Record<string, unknown>) => Promise<{ version: string }>>()
      .mockRejectedValueOnce(new ApiError(409, 'error.conflict'))
      .mockResolvedValue({ version: '6' });
    return setDay;
  };
  const renderManager = (workCalendar: Partial<WorkCalendarClient>) =>
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({
        viewer: me({ companyScope: true }),
        workCalendar,
      }),
    );

  it('refetches after a makeup add conflict so the retry uses the new version', async () => {
    const setDay = conflictThenOk();
    renderManager({ ...staleThenFresh(), setDay });
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm ngày làm bù' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm ngày làm bù' });
    await userEvent.type(within(dialog).getByLabelText(/^Ngày/), '08/11/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('vừa được người khác');
    await screen.findByText(/Phiên bản.*5|Version.*5/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(setDay).toHaveBeenLastCalledWith('2026-11-08', {
        expectedVersion: '5',
        makeup: { asWeekday: 1, frameSource: 'company' },
      }),
    );
  });

  it('refetches after a holiday add conflict so the retry uses the new version', async () => {
    const setHolidays = vi
      .fn<(input: Record<string, unknown>) => Promise<{ version: string }>>()
      .mockRejectedValueOnce(new ApiError(409, 'error.conflict'))
      .mockResolvedValue({ version: '6' });
    renderManager({ ...staleThenFresh(), setHolidays });
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm ngày nghỉ lễ' }));
    const dialog = await screen.findByRole('dialog');
    await typeRange(dialog, '02/11/2026', '03/11/2026', 'Ngày lễ giả C');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('vừa được người khác');
    await screen.findByText(/Phiên bản.*5/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(setHolidays).toHaveBeenLastCalledWith({
        expectedVersion: '5',
        from: '2026-11-02',
        to: '2026-11-03',
        name: 'Ngày lễ giả C',
      }),
    );
  });

  it('refetches after a makeup remove conflict so the retry uses the new version', async () => {
    const setDay = conflictThenOk();
    renderManager({ ...staleThenFresh(), setDay });
    const remove = await screen.findByRole('button', { name: 'Bỏ ngày làm bù 29/08/2026' });
    await userEvent.click(remove);
    expect(await screen.findByRole('alert')).toHaveTextContent('vừa được người khác');
    await screen.findByText(/Phiên bản.*5/);
    await userEvent.click(screen.getByRole('button', { name: 'Bỏ ngày làm bù 29/08/2026' }));
    await waitFor(() =>
      expect(setDay).toHaveBeenLastCalledWith('2026-08-29', {
        expectedVersion: '5',
        makeup: null,
      }),
    );
  });

  it('lets HR change the company week from a later day and remove a later version', async () => {
    const later = standardWeek.map((frame, index): [number, number][] =>
      index === 4 ? [[540, 780]] : frame,
    );
    const schedule = vi.fn(() =>
      Promise.resolve({
        today: '2026-11-04',
        maxMinutes: 480,
        versions: [
          { effectiveFrom: '1900-01-01', days: standardWeek },
          { effectiveFrom: '2026-12-01', days: later },
        ],
      }),
    );
    const putSchedule = vi.fn(() => Promise.resolve({ effectiveFrom: '2027-01-05' }));
    const deleteSchedule = vi.fn(() => Promise.resolve({ effectiveFrom: '2026-12-01' }));
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeServices({
        viewer: me({ companyScope: true }),
        workCalendar: { ...calendarOf(year2026), schedule, putSchedule, deleteSchedule },
      }),
    );
    const next = await screen.findByRole('table', { name: 'Áp dụng từ 01/12/2026' });
    expect(within(next).getByRole('row', { name: /Thứ Sáu/ })).toHaveTextContent('09:00–13:00');
    // The version in force has no remove button; a later one does.
    expect(screen.getAllByRole('button', { name: /^Bỏ giờ làm áp dụng từ/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Bỏ giờ làm áp dụng từ 01/12/2026' }));
    await waitFor(() => expect(deleteSchedule).toHaveBeenCalledWith('2026-12-01'));

    await userEvent.click(screen.getByRole('button', { name: 'Đổi giờ làm' }));
    const dialog = await screen.findByRole('dialog');
    // Prefilled from the last version: Friday has one shift.
    expect(within(dialog).queryByLabelText('Thứ Sáu giờ bắt đầu ca 2')).toBeNull();
    const save = within(dialog).getByRole('button', { name: 'Lưu' });
    await userEvent.type(within(dialog).getByLabelText(/Áp dụng từ/), '04/11/2026');
    await userEvent.click(save);
    expect(await within(dialog).findByText('Ngày áp dụng phải sau hôm nay.')).toBeVisible();

    await userEvent.clear(within(dialog).getByLabelText(/Áp dụng từ/));
    await userEvent.type(within(dialog).getByLabelText(/Áp dụng từ/), '05/01/2027');
    fireEvent.change(within(dialog).getByLabelText('Thứ Hai giờ kết thúc ca 1'), {
      target: { value: '14:00' },
    });
    expect(
      within(dialog).getByText(/các ca theo thứ tự, không chồng hay nối liền nhau/),
    ).toBeVisible();
    await userEvent.click(save);
    expect(
      await within(dialog).findByText('Có ngày có ca không hợp lệ; sửa những ngày được báo lỗi.'),
    ).toBeVisible();
    expect(putSchedule).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Thứ Hai giờ kết thúc ca 1'), {
      target: { value: '12:00' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Thêm ca Thứ Bảy' }));
    fireEvent.change(within(dialog).getByLabelText('Thứ Bảy giờ bắt đầu ca 1'), {
      target: { value: '08:00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Thứ Bảy giờ kết thúc ca 1'), {
      target: { value: '12:00' },
    });
    await userEvent.click(save);
    await waitFor(() =>
      expect(putSchedule).toHaveBeenCalledWith('2027-01-05', [
        [
          [540, 720],
          [840, 1080],
        ],
        ...later.slice(1, 5),
        [[480, 720]],
        [],
      ]),
    );
  });

  it('shows the same not-found message when the calendar is not visible', async () => {
    renderRoutes(routes, auth(), '/calendar?year=2026');
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
  });
});
