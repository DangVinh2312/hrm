import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { HrMe } from '../src/hr/hr.client';
import { ApiError } from '../src/infrastructure/http.client';
import type {
  RequestDetail,
  RequestSummary,
  WorkRequestClient,
} from '../src/work-request/work-request.client';
import { createHttpClient } from '../src/infrastructure/http.client';
import { createWorkRequestClient } from '../src/work-request/work-request.client';
import { requestFormSchema } from '../src/work-request/work-request-form.schema';
import viMessages from '../src/i18n/locales/vi.json';
import { fakeAuth, fakeHr, renderRoutes } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const auth = () => fakeAuth({ session: () => Promise.resolve(session) });
const me = (patch: Partial<HrMe> = {}): HrMe => ({
  userId: session.userId,
  employee: {
    id: '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22',
    code: 'NV001',
    fullName: 'Người dùng giả',
  },
  menus: ['requests'],
  companyScope: false,
  ...patch,
});
const requestId = '7c8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a33';
const summary = (patch: Partial<RequestSummary> = {}): RequestSummary => ({
  id: requestId,
  kind: 'annual-leave',
  state: 'pending_lead',
  version: '1',
  teamId: '6d8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a44',
  createdAt: '2026-11-02T02:00:00.000000Z',
  startDate: '2026-11-03',
  endDate: '2026-11-05',
  minutes: 240,
  ...patch,
});
const detail: RequestDetail = {
  id: requestId,
  employeeId: '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22',
  teamId: '6d8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a44',
  kind: 'annual-leave',
  state: 'pending_final',
  version: '1',
  reason: 'Việc gia đình giả',
  createdAt: '2026-11-02T02:00:00.000000Z',
  segments: [{ date: '2026-11-03', startMinute: 540, endMinute: 780, minutes: 240 }],
  decisions: [
    {
      stage: 'lead',
      decision: 'skip',
      actorKind: 'system',
      systemReason: 'lead_skipped_submitter_is_lead',
      decidedAt: '2026-11-02T02:00:00.000000Z',
    },
  ],
};
const render = (path: string, workRequest: Partial<WorkRequestClient> = {}, hrMe = me()) =>
  renderRoutes(
    routes,
    auth(),
    path,
    {},
    fakeHr({ hr: { me: () => Promise.resolve(hrMe) }, workRequest }),
  );
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function pickOption(label: string, option: string) {
  await userEvent.click(await screen.findByRole('combobox', { name: new RegExp(label) }));
  // Dropdowns of earlier selects stay in the DOM (hidden): the one just opened is the last.
  const options = await screen.findAllByRole('option', { name: option, hidden: true });
  await userEvent.click(options[options.length - 1]!);
}

describe('own work requests', () => {
  it('is in the menu only when the server grants it', async () => {
    render('/');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByRole('link', { name: 'Đơn của tôi' })).toHaveAttribute(
      'href',
      '/requests',
    );
  });

  it('lists own requests with kind, dates and state, and pages through the API', async () => {
    const list = vi.fn(({ page }: { page: number }) =>
      Promise.resolve({
        items: [
          page === 1
            ? summary()
            : summary({
                kind: 'wfh',
                state: 'approved',
                startDate: '2026-11-09',
                endDate: '2026-11-09',
              }),
        ],
        total: '45',
      }),
    );
    render('/requests', { list });
    expect(await screen.findByRole('heading', { level: 1, name: 'Đơn của tôi' })).toBeVisible();
    const row = (await screen.findByText('Nghỉ phép năm')).closest('tr') as HTMLElement;
    expect(within(row).getByText('03/11/2026 – 05/11/2026')).toBeInTheDocument();
    expect(within(row).getByText('Chờ trưởng nhóm duyệt')).toBeInTheDocument();
    expect(within(row).getByRole('link')).toHaveAttribute('href', `/requests/${requestId}`);
    expect(screen.getByRole('link', { name: 'Gửi đơn mới' })).toHaveAttribute(
      'href',
      '/requests/new',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(list).toHaveBeenCalledWith({ page: 2 }, expect.anything()));
    expect(await screen.findByText('Làm việc tại nhà')).toBeInTheDocument();
    expect(screen.getByText('Đã duyệt')).toBeInTheDocument();
  });

  it('says so when there is no request yet', async () => {
    render('/requests');
    expect(await screen.findByText('Bạn chưa gửi đơn nào.')).toBeInTheDocument();
  });

  it('shows the detail: reason, segments and the history as returned', async () => {
    render(`/requests/${requestId}`, { detail: () => Promise.resolve(detail) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Chi tiết đơn' })).toBeVisible();
    expect(await screen.findByText('Việc gia đình giả')).toBeInTheDocument();
    expect(screen.getByText('Chờ duyệt cuối')).toBeInTheDocument();
    const row = screen.getByText('03/11/2026').closest('tr') as HTMLElement;
    expect(within(row).getByText('09:00–13:00')).toBeInTheDocument();
    expect(within(row).getByText('240')).toBeInTheDocument();
    expect(screen.getByText('Hệ thống')).toBeInTheDocument();
    expect(
      screen.getByText('Người gửi là trưởng nhóm nên bước trưởng nhóm được bỏ qua.'),
    ).toBeInTheDocument();
  });

  it('shows not found for an absent or foreign request alike', async () => {
    render(`/requests/${requestId}`, {
      detail: () => Promise.reject(new ApiError(404, 'error.notFound')),
    });
    expect(await screen.findByText('Không tìm thấy trang')).toBeInTheDocument();
  });

  it('submits a late arrival with a fresh idempotency key and opens the new request', async () => {
    const submit = vi.fn(() =>
      Promise.resolve({ id: requestId, state: 'pending_lead' as const, version: '1' }),
    );
    render('/requests/new', { submit, detail: () => Promise.resolve(detail) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Gửi đơn mới' })).toBeVisible();
    await pickOption('Loại đơn', 'Đi muộn');
    await userEvent.type(screen.getByLabelText(/^Ngày/), '03/11/2026');
    await userEvent.type(screen.getByLabelText(/Giờ đến dự kiến/), '09:30');
    await userEvent.type(screen.getByLabelText(/Lý do/), 'Kẹt xe giả');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi đơn' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith(
      { kind: 'late-arrival', date: '2026-11-03', expectedMinute: 570, reason: 'Kẹt xe giả' },
      expect.stringMatching(uuidV4),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Chi tiết đơn' })).toBeVisible();
  });

  it('refuses an empty form before calling the API', async () => {
    const submit = vi.fn();
    render('/requests/new', { submit });
    await userEvent.click(await screen.findByRole('button', { name: 'Gửi đơn' }));
    expect(await screen.findByText('Hãy nhập lý do.')).toBeInTheDocument();
    expect(screen.getByText('Hãy chọn ngày hợp lệ.')).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it('sends leave as date + slot rows and refuses a repeated date', async () => {
    const submit = vi.fn(() =>
      Promise.resolve({ id: requestId, state: 'pending_lead' as const, version: '1' }),
    );
    render('/requests/new', { submit, detail: () => Promise.resolve(detail) });
    await pickOption('Loại đơn', 'Nghỉ phép năm');
    await userEvent.type(screen.getByLabelText(/^Ngày 1/), '03/11/2026');
    await pickOption('Khung giờ 1', '09:00–11:00');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm ngày' }));
    await userEvent.type(screen.getByLabelText(/^Ngày 2/), '03/11/2026');
    await pickOption('Khung giờ 2', '14:00–18:00');
    await userEvent.type(screen.getByLabelText(/Lý do/), 'Việc riêng giả');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi đơn' }));
    expect(await screen.findByText('Mỗi ngày chỉ chọn một lần.')).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText(/^Ngày 2/));
    await userEvent.type(screen.getByLabelText(/^Ngày 2/), '04/11/2026');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi đơn' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith(
      {
        kind: 'annual-leave',
        reason: 'Việc riêng giả',
        segments: [
          { date: '2026-11-03', startMinute: 540, endMinute: 660 },
          { date: '2026-11-04', startMinute: 840, endMinute: 1080 },
        ],
      },
      expect.stringMatching(uuidV4),
    );
  });

  it('sends work from home as a date list', async () => {
    const submit = vi.fn(() =>
      Promise.resolve({ id: requestId, state: 'pending_lead' as const, version: '1' }),
    );
    render('/requests/new', { submit, detail: () => Promise.resolve(detail) });
    await pickOption('Loại đơn', 'Làm việc tại nhà');
    expect(screen.queryByRole('combobox', { name: /Khung giờ/ })).toBeNull();
    await userEvent.type(screen.getByLabelText(/^Ngày 1/), '03/11/2026');
    await userEvent.type(screen.getByLabelText(/Lý do/), 'Sửa nhà giả');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi đơn' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith(
      { kind: 'wfh', reason: 'Sửa nhà giả', dates: ['2026-11-03'] },
      expect.stringMatching(uuidV4),
    );
  });

  it('keeps the idempotency key when the same submit is retried, and changes it with the content', async () => {
    const submit = vi
      .fn<WorkRequestClient['submit']>()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValue({ id: requestId, state: 'pending_lead', version: '1' });
    render('/requests/new', { submit, detail: () => Promise.resolve(detail) });
    await pickOption('Loại đơn', 'Làm việc tại nhà');
    await userEvent.type(screen.getByLabelText(/^Ngày 1/), '03/11/2026');
    await userEvent.type(screen.getByLabelText(/Lý do/), 'Sửa nhà giả');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi đơn' }));
    expect(await screen.findByText(/Chưa xác định được kết quả/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Gửi đơn' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    await userEvent.type(screen.getByLabelText(/Lý do/), ' thêm');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi đơn' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
    const keys = submit.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('shows a generic conflict, then each rejection by its own error key', async () => {
    const submit = vi
      .fn<WorkRequestClient['submit']>()
      .mockRejectedValueOnce(new ApiError(409, 'error.conflict'))
      .mockRejectedValueOnce(new ApiError(409, 'error.overlappingRequest'))
      .mockRejectedValueOnce(new ApiError(422, 'error.kindNotAllowedInProbation'))
      .mockRejectedValueOnce(new ApiError(422, 'error.teamNotMember'))
      .mockRejectedValueOnce(new ApiError(400, 'error.invalidRequest'));
    render('/requests/new', { submit });
    await pickOption('Loại đơn', 'Làm việc tại nhà');
    await userEvent.type(screen.getByLabelText(/^Ngày 1/), '03/11/2026');
    await userEvent.type(screen.getByLabelText(/Lý do/), 'Sửa nhà giả');
    await userEvent.click(screen.getByRole('button', { name: 'Gửi đơn' }));
    expect(await screen.findByText(/Dữ liệu vừa thay đổi/)).toBeInTheDocument();
    for (const code of [
      'error.overlappingRequest',
      'error.kindNotAllowedInProbation',
      'error.teamNotMember',
      'error.invalidRequest',
    ] as const) {
      await userEvent.click(screen.getByRole('button', { name: 'Gửi đơn' }));
      expect(await screen.findByText(viMessages[code])).toBeInTheDocument();
    }
    expect(screen.queryByText(/Dữ liệu vừa thay đổi/)).toBeNull();
  });

  it('has no Requests link when the server grants no menu', async () => {
    render('/', {}, me({ menus: [] }));
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).queryByRole('link', { name: 'Đơn của tôi' })).toBeNull();
  });

  it('refuses a reason with control characters (the API rejects them), so nothing is posted', () => {
    const base = {
      kind: 'wfh',
      date: '',
      time: '',
      rows: [{ date: '2026-11-03', slot: '' }],
    };
    expect(requestFormSchema.safeParse({ ...base, reason: 'một dòng' }).success).toBe(true);
    for (const reason of ['hai\ndòng', 'tab\there', 'del\u007f'])
      expect(requestFormSchema.safeParse({ ...base, reason }).success).toBe(false);
  });
});

describe('work request client', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const calls = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
    fetchImpl.mock.calls.map(([path, init]) => ({ path, init }));

  it('maps page to limit/offset, id to the detail path and sends the idempotency key with the body', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const path = typeof input === 'string' ? input : '';
      return Promise.resolve(
        path === '/api/auth/csrf'
          ? json({ csrfToken: 'tok' })
          : path.endsWith(requestId)
            ? json(detail)
            : path.startsWith('/api/hr/requests?')
              ? json({ items: [summary()], total: '1' })
              : json({ id: requestId, state: 'pending_lead', version: '1' }),
      );
    });
    const client = createWorkRequestClient(createHttpClient(fetchImpl));
    await client.list({ page: 3 });
    await client.detail(requestId);
    const input = { kind: 'wfh', reason: 'r', dates: ['2026-11-03'] } as const;
    const key = '0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21';
    await expect(client.submit(input, key)).resolves.toEqual({
      id: requestId,
      state: 'pending_lead',
      version: '1',
    });
    const [list, one, , post] = calls(fetchImpl);
    expect(list!.path).toBe('/api/hr/requests?limit=20&offset=40');
    expect(one!.path).toBe(`/api/hr/requests/${requestId}`);
    expect(post!.path).toBe('/api/hr/requests');
    expect(post!.init?.method).toBe('POST');
    expect(post!.init?.body).toBe(JSON.stringify(input));
    expect(post!.init?.headers).toMatchObject({
      'idempotency-key': key,
      'x-csrf-token': 'tok',
    });
  });

  it('rejects an answer of the wrong shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json({ items: [{}], total: '1' })));
    await expect(
      createWorkRequestClient(createHttpClient(fetchImpl)).list({ page: 1 }),
    ).rejects.toThrow();
  });
});
