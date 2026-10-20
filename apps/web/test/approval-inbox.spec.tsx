import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import type { EmployeeClient } from '../src/employee/employee.client';
import type { HrMe } from '../src/hr/hr.client';
import { ApiError, createHttpClient, ResponseShapeError } from '../src/infrastructure/http.client';
import {
  createWorkRequestClient,
  type ApprovalQueueItem,
  type DecidedRequestItem,
  type RequestDetail,
  type WorkRequestClient,
} from '../src/work-request/work-request.client';
import { fakeAuth, fakeHr, renderRoutes } from './render.helper';

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const me: HrMe = {
  userId: session.userId,
  employee: null,
  menus: ['approvals'],
  companyScope: false,
};
const requestId = '7c8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a33';
const employeeId = '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22';
const item = (patch: Partial<ApprovalQueueItem> = {}): ApprovalQueueItem => ({
  id: requestId,
  employeeId,
  kind: 'wfh',
  state: 'pending_lead',
  version: '1',
  teamId: '6d8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a44',
  createdAt: '2026-11-02T02:00:00.000000Z',
  startDate: '2026-11-03',
  endDate: '2026-11-03',
  minutes: 480,
  ...patch,
});
const detail = (patch: Partial<RequestDetail> = {}): RequestDetail => ({
  id: requestId,
  employeeId,
  teamId: '6d8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a44',
  kind: 'wfh',
  state: 'pending_lead',
  version: '1',
  reason: 'Lý do giả của nhân viên',
  createdAt: '2026-11-02T02:00:00.000000Z',
  segments: [{ date: '2026-11-03', startMinute: 540, endMinute: 1080, minutes: 480 }],
  decisions: [],
  ...patch,
});
const denied = () => Promise.reject(new ApiError(403, 'error.accessDenied'));
const queue = (items: ApprovalQueueItem[], total = String(items.length)) =>
  Promise.resolve({ items, total });
const employee: Partial<EmployeeClient> = {
  detail: () =>
    Promise.resolve({
      id: employeeId,
      code: 'NV007',
      fullName: 'Nhân Viên Giả',
      hiredOn: '2026-01-05',
      terminatedOn: null,
      state: 'official',
      version: '1',
      accountId: null,
      position: null,
      classification: null,
      periods: [],
      teams: [],
    }),
};
const render = (workRequest: Partial<WorkRequestClient>, path = '/approvals') =>
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    path,
    {},
    fakeHr({ hr: { me: () => Promise.resolve(me) }, workRequest, employees: employee }),
  );
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const decidedItem = (patch: Partial<DecidedRequestItem> = {}): DecidedRequestItem => ({
  ...item({ state: 'rejected', version: '3' }),
  employeeName: 'Nguyễn Văn An',
  decision: {
    stage: 'final',
    decision: 'reject',
    actorKind: 'user',
    decidedAt: '2026-11-03T03:00:00.000000Z',
  },
  ...patch,
});

/** The opener's accessible name carries the kind and the dates (L4). */
async function openRequest(kind = 'Làm việc tại nhà', dates = '03/11/2026') {
  await userEvent.click(await screen.findByRole('button', { name: `${kind}, ${dates}` }));
  return screen.findByRole('dialog', { name: 'Xử lý đơn' });
}

describe('approval inbox', () => {
  it('is in the menu only when the server grants it', async () => {
    render({ queue: () => queue([]) }, '/');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await within(nav).findByRole('link', { name: 'Phê duyệt' })).toHaveAttribute(
      'href',
      '/approvals',
    );
  });

  // The API answers a stage without a grant with an empty scoped page (its plan reaches
  // nothing), so a queue shows only when something waits in it for the caller.
  it('shows only the queues where something waits, and pages through them', async () => {
    const calls = vi.fn((stage: 'lead' | 'final', { page }: { page: number }) =>
      stage === 'final'
        ? queue([])
        : queue([item({ kind: page === 1 ? 'wfh' : 'unpaid-leave' })], '45'),
    );
    render({ queue: calls });
    expect(await screen.findByRole('heading', { level: 1, name: 'Phê duyệt đơn' })).toBeVisible();
    expect(await screen.findByRole('tab', { name: 'Duyệt bước 1 (45)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Đã xử lý' })).toBeInTheDocument();
    const row = (
      await screen.findByRole('button', { name: 'Làm việc tại nhà, 03/11/2026' })
    ).closest('tr') as HTMLElement;
    expect(within(row).getByText('03/11/2026')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls).toHaveBeenCalledWith('final', { page: 1 }, expect.anything()),
    );
    expect(screen.queryByRole('tab', { name: /Duyệt cuối/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Trang sau' }));
    await waitFor(() => expect(calls).toHaveBeenCalledWith('lead', { page: 2 }, expect.anything()));
    expect(await screen.findByText('Nghỉ không lương')).toBeInTheDocument();
  });

  it('says nothing is waiting when both queues are empty or refused, and still shows the history', async () => {
    render({ queue: (stage) => (stage === 'lead' ? queue([]) : denied()) });
    expect(await screen.findByText('Không có đơn nào đang chờ bạn duyệt.')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Đã xử lý']);
    expect(screen.getByRole('tab', { name: 'Đã xử lý' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Chưa có đơn nào được xử lý.')).toBeInTheDocument();
  });

  it('lists the decided history read-only: state, latest decision and when, latest first', async () => {
    const decided = vi.fn<WorkRequestClient['decided']>(() =>
      Promise.resolve({
        items: [
          decidedItem(),
          decidedItem({
            id: '8c8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a55',
            kind: 'late-arrival',
            state: 'pending_final',
            version: '2',
            employeeName: 'Trần Thị Bình',
            decision: {
              stage: 'lead',
              decision: 'approve',
              actorKind: 'user',
              decidedAt: '2026-11-02T03:00:00.000000Z',
            },
          }),
        ],
        total: '2',
      }),
    );
    render({ queue: () => queue([item()]), decided });
    await userEvent.click(await screen.findByRole('tab', { name: 'Đã xử lý' }));
    const rows = await screen.findAllByRole('row');
    const [first, second] = rows.slice(1) as [HTMLElement, HTMLElement];
    expect(within(first).getByText('Làm việc tại nhà')).toBeInTheDocument();
    // The decided row names its owner (the API returns the name only for rows the caller reads).
    expect(screen.getByRole('columnheader', { name: 'Nhân viên' })).toBeInTheDocument();
    expect(within(first).getByText('Nguyễn Văn An')).toBeInTheDocument();
    expect(within(second).getByText('Trần Thị Bình')).toBeInTheDocument();
    expect(within(first).getByText('Từ chối')).toBeInTheDocument();
    expect(within(first).getByText('Bị từ chối ở bước duyệt cuối')).toBeInTheDocument();
    expect(within(second).getByText('Đi muộn')).toBeInTheDocument();
    expect(within(second).getByText('Chờ duyệt cuối')).toBeInTheDocument();
    expect(within(second).getByText('Trưởng nhóm đã duyệt')).toBeInTheDocument();
    // Read-only: no way into a decision from the history.
    expect(within(first).queryByRole('button')).toBeNull();
    expect(decided).toHaveBeenCalledWith({ page: 1 }, expect.anything());
  });

  // L1: a URL naming a hidden queue falls back to a shown one at its first page.
  it('a link to a hidden queue shows the first shown queue at page 1', async () => {
    const calls = vi.fn<WorkRequestClient['queue']>((stage) =>
      stage === 'final' ? queue([]) : queue([item()], '45'),
    );
    render({ queue: calls }, '/approvals?queue=final&page=3');
    expect(await screen.findByRole('tab', { name: 'Duyệt bước 1 (45)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByRole('button', { name: '1' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(calls).not.toHaveBeenCalledWith('lead', { page: 3 }, expect.anything());
  });

  // L2: the last page emptied (decided elsewhere) while others remain: step back to the last one.
  it('an empty page past the end steps back to the last page', async () => {
    const decided = vi.fn<WorkRequestClient['decided']>(({ page }) =>
      Promise.resolve(
        page === 3 ? { items: [], total: '25' } : { items: [decidedItem()], total: '25' },
      ),
    );
    render({ queue: () => queue([]), decided }, '/approvals?queue=decided&page=3');
    await waitFor(() => expect(decided).toHaveBeenCalledWith({ page: 2 }, expect.anything()));
    expect(await screen.findByText('Bị từ chối ở bước duyệt cuối')).toBeInTheDocument();
    expect(screen.queryByText('Chưa có đơn nào được xử lý.')).toBeNull();
  });

  // A broken body is never retried, so the failure shows at once.
  it('shows a failed queue with a retry, not as empty', async () => {
    render({
      queue: (stage) => (stage === 'lead' ? Promise.reject(new ResponseShapeError()) : queue([])),
    });
    expect(await screen.findByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  });

  it('shows the request with its reason and approves it with one key, then reloads the queue', async () => {
    const queueCalls = vi.fn((stage: 'lead' | 'final') =>
      stage === 'lead' ? queue([item()]) : denied(),
    );
    const decide = vi.fn<WorkRequestClient['decide']>(() =>
      Promise.resolve({ id: requestId, state: 'pending_final', version: '2' }),
    );
    render({ queue: queueCalls, detail: () => Promise.resolve(detail()), decide });
    const dialog = await openRequest();
    expect(await within(dialog).findByText('Lý do giả của nhân viên')).toBeInTheDocument();
    expect(await within(dialog).findByText('NV007 · Nhân Viên Giả')).toBeInTheDocument();
    expect(within(dialog).getByText('09:00–18:00')).toBeInTheDocument();
    const before = queueCalls.mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Duyệt' }));
    expect(
      await screen.findByText('Đã duyệt bước 1. Đơn chuyển sang duyệt cuối.'),
    ).toBeInTheDocument();
    expect(decide).toHaveBeenCalledWith(
      requestId,
      { expectedVersion: '1', decision: 'approve', reason: null },
      expect.stringMatching(uuidV4),
    );
    await waitFor(() => expect(queueCalls.mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog', { name: 'Xử lý đơn' })).toBeNull();
  });

  it('needs a reason to reject, then sends it', async () => {
    const decide = vi.fn<WorkRequestClient['decide']>(() =>
      Promise.resolve({ id: requestId, state: 'rejected', version: '2' }),
    );
    render({
      queue: (stage) => (stage === 'lead' ? queue([item()]) : denied()),
      detail: () => Promise.resolve(detail()),
      decide,
    });
    const dialog = await openRequest();
    await within(dialog).findByText('Lý do giả của nhân viên');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Từ chối' }));
    expect(await within(dialog).findByText('Hãy nhập lý do từ chối.')).toBeInTheDocument();
    expect(decide).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(/Lý do hoặc ghi chú/), '  Thiếu người  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Từ chối' }));
    expect(await screen.findByText('Đã từ chối đơn.')).toBeInTheDocument();
    expect(decide).toHaveBeenCalledWith(
      requestId,
      { expectedVersion: '1', decision: 'reject', reason: 'Thiếu người' },
      expect.stringMatching(uuidV4),
    );
  });

  it('a 409 on an approval that would be final, with the version unchanged, says final approval is not open', async () => {
    const details = vi.fn(() => Promise.resolve(detail({ state: 'pending_final', version: '2' })));
    const queueCalls = vi.fn((stage: 'lead' | 'final') =>
      stage === 'final' ? queue([item({ state: 'pending_final', version: '2' })]) : queue([]),
    );
    render({
      queue: queueCalls,
      detail: details,
      decide: () => Promise.reject(new ApiError(409, 'error.conflict')),
    });
    await userEvent.click(await screen.findByRole('tab', { name: /Duyệt cuối/ }));
    const dialog = await openRequest();
    await within(dialog).findByText('Lý do giả của nhân viên');
    const reads = details.mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Duyệt' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Hệ thống chưa mở duyệt cuối',
    );
    expect(details.mock.calls.length).toBeGreaterThan(reads);
  });

  it('a 409 after the request changed (version moved on reload) says it changed', async () => {
    let version = '1';
    render({
      queue: (stage) => (stage === 'lead' ? queue([item({ kind: 'late-arrival' })]) : denied()),
      detail: () => Promise.resolve(detail({ kind: 'late-arrival', version })),
      decide: () => {
        version = '2';
        return Promise.reject(new ApiError(409, 'error.conflict'));
      },
    });
    const dialog = await openRequest('Đi muộn');
    await within(dialog).findByText('Lý do giả của nhân viên');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Duyệt' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Đơn vừa được thay đổi');
  });

  // L5: an approval that is not final (lead step of a two-step kind) is never the M3 gate.
  it('a 409 on a non-final approval with the version unchanged says it changed', async () => {
    render({
      queue: (stage) => (stage === 'lead' ? queue([item()]) : denied()),
      detail: () => Promise.resolve(detail()),
      decide: () => Promise.reject(new ApiError(409, 'error.conflict')),
    });
    const dialog = await openRequest();
    await within(dialog).findByText('Lý do giả của nhân viên');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Duyệt' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Đơn vừa được thay đổi');
  });

  it('a 409 on a reject says it changed; a 404 says not found', async () => {
    const decide = vi
      .fn<WorkRequestClient['decide']>()
      .mockRejectedValueOnce(new ApiError(409, 'error.conflict'))
      .mockRejectedValueOnce(new ApiError(404, 'error.notFound'));
    render({
      queue: (stage) => (stage === 'final' ? queue([item({ state: 'pending_final' })]) : queue([])),
      detail: () => Promise.resolve(detail({ state: 'pending_final' })),
      decide,
    });
    const dialog = await openRequest();
    await within(dialog).findByText('Lý do giả của nhân viên');
    await userEvent.type(within(dialog).getByLabelText(/Lý do hoặc ghi chú/), 'Không đủ người');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Từ chối' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Đơn vừa được thay đổi');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Từ chối' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Không tìm thấy.');
  });

  it('another decision or reason gets a new key; the same one keeps it', async () => {
    const decide = vi
      .fn<WorkRequestClient['decide']>()
      .mockRejectedValue(new TypeError('Failed to fetch'));
    render({
      queue: (stage) => (stage === 'lead' ? queue([item()]) : denied()),
      detail: () => Promise.resolve(detail()),
      decide,
    });
    const dialog = await openRequest();
    await within(dialog).findByText('Lý do giả của nhân viên');
    const note = within(dialog).getByLabelText(/Lý do hoặc ghi chú/);
    const click = async (name: string) => {
      const before = decide.mock.calls.length;
      await userEvent.click(within(dialog).getByRole('button', { name }));
      await waitFor(() => expect(decide.mock.calls.length).toBe(before + 1));
      return decide.mock.calls.at(-1)?.[2];
    };
    await userEvent.type(note, 'Một');
    const first = await click('Từ chối');
    expect(await click('Từ chối')).toBe(first);
    await userEvent.type(note, ' hai');
    const reworded = await click('Từ chối');
    expect(reworded).not.toBe(first);
    const approved = await click('Duyệt');
    expect(approved).not.toBe(reworded);
    expect(new Set([first, reworded, approved]).size).toBe(3);
  });

  // L3: a request already decided (reloaded after a conflict, or opened late) cannot be sent.
  it('a request no longer pending has its decision buttons disabled', async () => {
    render({
      queue: (stage) => (stage === 'lead' ? queue([item()]) : denied()),
      detail: () => Promise.resolve(detail({ state: 'rejected', version: '2' })),
    });
    const dialog = await openRequest();
    await within(dialog).findByText('Lý do giả của nhân viên');
    expect(within(dialog).getByRole('button', { name: 'Duyệt' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Từ chối' })).toBeDisabled();
  });

  it('a lost connection keeps the key for the retry; a 403 shows its error key', async () => {
    const decide = vi
      .fn<WorkRequestClient['decide']>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiError(403, 'error.accessDenied'));
    render({
      queue: (stage) => (stage === 'lead' ? queue([item()]) : denied()),
      detail: () => Promise.resolve(detail()),
      decide,
    });
    const dialog = await openRequest();
    await within(dialog).findByText('Lý do giả của nhân viên');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Duyệt' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Chưa xác định được kết quả',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Duyệt' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Không thực hiện được thao tác này',
    );
    expect(decide.mock.calls[1]?.[2]).toBe(decide.mock.calls[0]?.[2]);
  });
});

describe('approval client', () => {
  it('pages the queues and sends a decision with the key and CSRF token', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const path = typeof input === 'string' ? input : '';
      return Promise.resolve(
        new Response(
          JSON.stringify(
            path === '/api/auth/csrf'
              ? { csrfToken: 'csrf-fake' }
              : path.startsWith('/api/hr/approvals/')
                ? { items: [item()], total: '1' }
                : { id: requestId, state: 'rejected', version: '2' },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const client = createWorkRequestClient(createHttpClient(fetchImpl));
    expect((await client.queue('final', { page: 3 })).total).toBe('1');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/hr/approvals/final?limit=20&offset=40');
    const key = '6d2f0c1e-8a7b-4c3d-9e5f-1a2b3c4d5e6f';
    await client.decide(
      requestId,
      { expectedVersion: '1', decision: 'reject', reason: 'Thiếu người' },
      key,
    );
    const [path, init] = fetchImpl.mock.calls.at(-1) ?? [];
    expect(path).toBe(`/api/hr/requests/${requestId}/decision`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'idempotency-key': key, 'x-csrf-token': 'csrf-fake' });
    expect(init?.body).toBe(
      JSON.stringify({ expectedVersion: '1', decision: 'reject', reason: 'Thiếu người' }),
    );
  });

  it('pages the decided history and refuses an item without its decision', async () => {
    const bodies = [
      { items: [decidedItem()], total: '1' },
      { items: [item()], total: '1' },
    ];
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(bodies.shift()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const client = createWorkRequestClient(createHttpClient(fetchImpl));
    expect((await client.decided({ page: 2 })).items[0]?.decision.stage).toBe('final');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/hr/approvals/decided?limit=20&offset=20');
    await expect(client.decided({ page: 1 })).rejects.toThrow('contract');
  });

  it('refuses a queue body of the wrong shape', async () => {
    const client = createWorkRequestClient(
      createHttpClient(() =>
        Promise.resolve(
          new Response(JSON.stringify({ items: [{ id: 'x' }], total: '1' }), { status: 200 }),
        ),
      ),
    );
    await expect(client.queue('lead', { page: 1 })).rejects.toThrow('contract');
  });
});
