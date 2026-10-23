import { screen, waitFor, within, configure } from '@testing-library/react';

import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import { ApiError, createHttpClient } from '../src/infrastructure/http.client';
import {
  createWorkRequestClient,
  type RequestDetail,
  type WorkRequestClient,
} from '../src/features/work-request/work-request.client';
import { fakeAuth, fakeServices, renderRoutes, type Viewer } from './render.helper';

// The machine can be heavily loaded: wait longer than the 1 s default before failing.
configure({ asyncUtilTimeout: 8000 });

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const ownerId = '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22';
const companyEmployeeId = '4a8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a55';
const requestId = '7c8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a33';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const me = (patch: Partial<Viewer> = {}): Viewer => ({
  userId: session.userId,
  employee: { id: ownerId, code: 'NV001', fullName: 'Người dùng giả' },
  menus: ['requests'],
  companyScope: false,
  ...patch,
});
const companyViewer = me({
  employee: { id: companyEmployeeId, code: 'HR001', fullName: 'HR giả' },
  companyScope: true,
});
const detail = (patch: Partial<RequestDetail> = {}): RequestDetail => ({
  id: requestId,
  employeeId: ownerId,
  teamId: '6d8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a44',
  kind: 'annual-leave',
  state: 'pending_lead',
  version: '3',
  reason: 'Việc gia đình giả',
  createdAt: '2026-11-02T02:00:00.000000Z',
  segments: [{ date: '2026-11-03', startMinute: 540, endMinute: 780, minutes: 240 }],
  decisions: [],
  ...patch,
});
const result = { id: requestId, state: 'cancelled' as const, version: '4' };
const render = (workRequest: Partial<WorkRequestClient>, viewer = me()) =>
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    `/requests/${requestId}`,
    {},
    fakeServices({ viewer, workRequest }),
  );

describe('cancel a request', () => {
  it('the owner cancels a pending request: one key, the version read, no reason needed', async () => {
    const cancel = vi.fn(() => Promise.resolve(result));
    const read = vi.fn(() => Promise.resolve(detail()));
    render({ detail: read, cancel });
    await userEvent.click(await screen.findByRole('button', { name: 'Hủy đơn' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận hủy' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(cancel).toHaveBeenCalledWith(
      requestId,
      { expectedVersion: '3' },
      expect.stringMatching(uuidV4),
    );
    // The request is read again after the change.
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1), { timeout: 5000 });
  });

  it('the owner has no cancel button on an approved request, nor a non-owner without company scope', async () => {
    const view = render({ detail: () => Promise.resolve(detail({ state: 'approved' })) });
    await screen.findByRole('heading', { level: 2, name: 'Nghỉ phép năm' });
    expect(screen.queryByRole('button', { name: 'Hủy đơn' })).not.toBeInTheDocument();
    view.unmount();
    render({ detail: () => Promise.resolve(detail({ employeeId: companyEmployeeId })) });
    await screen.findByRole('heading', { level: 2, name: 'Nghỉ phép năm' });
    expect(screen.queryByRole('button', { name: 'Hủy đơn' })).not.toBeInTheDocument();
  });

  it('HR cancels an approved request only with a reason, and not a pending one of someone else', async () => {
    const cancel = vi.fn(() => Promise.resolve(result));
    const view = render(
      { detail: () => Promise.resolve(detail({ state: 'pending_final' })), cancel },
      companyViewer,
    );
    await screen.findByRole('heading', { level: 2, name: 'Nghỉ phép năm' });
    expect(screen.queryByRole('button', { name: 'Hủy đơn' })).not.toBeInTheDocument();
    view.unmount();
    render({ detail: () => Promise.resolve(detail({ state: 'approved' })), cancel }, companyViewer);
    await userEvent.click(await screen.findByRole('button', { name: 'Hủy đơn' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận hủy' }));
    expect(await within(dialog).findByText('Nhập lý do hủy đơn đã duyệt.')).toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: /Lý do hủy/ }),
      'Nhập nhầm ngày',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận hủy' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(cancel).toHaveBeenCalledWith(
      requestId,
      { expectedVersion: '3', reason: 'Nhập nhầm ngày' },
      expect.stringMatching(uuidV4),
    );
  });

  it('a closed month is told as such, and the retry of the same cancel keeps its key', async () => {
    const cancel = vi
      .fn<WorkRequestClient['cancel']>()
      .mockRejectedValueOnce(new ApiError(409, 'error.periodClosed'))
      .mockResolvedValueOnce(result);
    render({ detail: () => Promise.resolve(detail({ state: 'approved' })), cancel }, companyViewer);
    await userEvent.click(await screen.findByRole('button', { name: 'Hủy đơn' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Lý do hủy/ }), 'Nhập nhầm');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận hủy' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('HR chốt công');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận hủy' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(cancel.mock.calls[1]?.[2]).toBe(cancel.mock.calls[0]?.[2]);
  });
});

describe('work request client: cancel', () => {
  it('posts the body with the idempotency key and parses the result', async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      Promise.resolve(json(input === '/api/auth/csrf' ? { csrfToken: 'tok' } : result)),
    );
    const client = createWorkRequestClient(createHttpClient(fetchImpl));
    const key = '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a99';
    await expect(client.cancel(requestId, { expectedVersion: '3' }, key)).resolves.toEqual(result);
    const [path, init] = fetchImpl.mock.calls.find(([p]) => p !== '/api/auth/csrf') ?? [];
    expect(path).toBe(`/api/hr/requests/${requestId}/cancel`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'idempotency-key': key, 'x-csrf-token': 'tok' });
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      expectedVersion: '3',
    });
  });
});
