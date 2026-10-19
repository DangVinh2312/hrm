import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { HrMe } from '../src/hr/hr.client';
import { ApiError } from '../src/infrastructure/http.client';
import type { CalendarYear } from '../src/work-calendar/work-calendar.client';
import { fakeAuth, fakeHr, renderRoutes } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const auth = () => fakeAuth({ session: () => Promise.resolve(session) });
const me = (patch: Partial<HrMe> = {}): HrMe => ({
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
  makeupDays: ['2026-08-29'],
};
const calendarOf = (data: CalendarYear) => ({
  year: vi.fn((year: number) => Promise.resolve({ ...data, year })),
});

describe('work calendar', () => {
  it('is in the menu only when the server grants it', async () => {
    renderRoutes(routes, auth(), '/', {}, fakeHr({ hr: { me: () => Promise.resolve(me()) } }));
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
      fakeHr({ hr: { me: () => Promise.resolve(me()) }, workCalendar }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Lịch làm việc' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/09:00–13:00 và 14:00–18:00/)).toBeInTheDocument();
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
      fakeHr({ hr: { me: () => Promise.resolve(me()) }, workCalendar }),
    );
    expect(await screen.findByText('Chưa có ngày nghỉ lễ nào trong năm này.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Năm sau' }));
    await waitFor(() => expect(workCalendar.year).toHaveBeenCalledWith(2027, expect.anything()));
    expect(await screen.findByText('2027')).toBeInTheDocument();
  });

  it('lets HR add a weekday holiday and refuses a weekend before calling the API', async () => {
    const setDay = vi.fn(() => Promise.resolve({ version: '4' }));
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeHr({
        hr: { me: () => Promise.resolve(me({ companyScope: true })) },
        workCalendar: { ...calendarOf(year2026), setDay },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm ngày nghỉ lễ' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Ngày/), '07/11/2026');
    await userEvent.type(within(dialog).getByLabelText(/Tên ngày nghỉ/), 'Ngày lễ giả C');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    expect(
      await within(dialog).findByText('Chỉ đặt ngày nghỉ lễ vào thứ Hai đến thứ Sáu.'),
    ).toBeInTheDocument();
    expect(setDay).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText(/Ngày/));
    await userEvent.type(within(dialog).getByLabelText(/Ngày/), '02/11/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(setDay).toHaveBeenCalledWith('2026-11-02', {
        expectedVersion: '3',
        holiday: 'Ngày lễ giả C',
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
      fakeHr({
        hr: { me: () => Promise.resolve(me({ companyScope: true })) },
        workCalendar: { ...calendarOf(year2026), setDay },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Bỏ ngày nghỉ 02/09/2026' }));
    await waitFor(() =>
      expect(setDay).toHaveBeenCalledWith('2026-09-02', { expectedVersion: '3', holiday: null }),
    );
  });

  it('lets HR mark a Saturday/Sunday as makeup day and refuses a weekday before calling the API', async () => {
    const setDay = vi.fn(() => Promise.resolve({ version: '4' }));
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeHr({
        hr: { me: () => Promise.resolve(me({ companyScope: true })) },
        workCalendar: { ...calendarOf({ ...year2026, makeupDays: [] }), setDay },
      }),
    );
    expect(await screen.findByText('Chưa có ngày làm bù nào trong năm này.')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm ngày làm bù' }));
    const dialog = await screen.findByRole('dialog', { name: 'Thêm ngày làm bù' });
    await userEvent.type(within(dialog).getByLabelText(/Ngày/), '02/11/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    expect(
      await within(dialog).findByText('Chỉ đặt ngày làm bù vào thứ Bảy hoặc Chủ nhật.'),
    ).toBeInTheDocument();
    expect(setDay).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText(/Ngày/));
    await userEvent.type(within(dialog).getByLabelText(/Ngày/), '08/11/2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu' }));
    await waitFor(() =>
      expect(setDay).toHaveBeenCalledWith('2026-11-08', { expectedVersion: '3', makeup: true }),
    );
  });

  it('lets HR turn a makeup day back into a weekly rest with the version it saw', async () => {
    const setDay = vi.fn(() => Promise.resolve({ version: '4' }));
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeHr({
        hr: { me: () => Promise.resolve(me({ companyScope: true })) },
        workCalendar: { ...calendarOf(year2026), setDay },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Bỏ ngày làm bù 29/08/2026' }));
    await waitFor(() =>
      expect(setDay).toHaveBeenCalledWith('2026-08-29', { expectedVersion: '3', makeup: false }),
    );
  });

  it('explains a stale calendar after a conflict', async () => {
    renderRoutes(
      routes,
      auth(),
      '/calendar?year=2026',
      {},
      fakeHr({
        hr: { me: () => Promise.resolve(me({ companyScope: true })) },
        workCalendar: {
          ...calendarOf(year2026),
          setDay: () => Promise.reject(new ApiError(409, 'error.conflict')),
        },
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Bỏ ngày nghỉ 02/09/2026' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('vừa được người khác thay đổi');
  });

  it('shows the same not-found message when the calendar is not visible', async () => {
    renderRoutes(routes, auth(), '/calendar?year=2026');
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
  });
});
