import { screen, within, configure } from '@testing-library/react';

import { describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app';
import {
  createLeaveClient,
  type LeaveClient,
  type LeaveReconciliation,
} from '../src/features/leave/leave.client';
import { createHttpClient } from '../src/infrastructure/http.client';
import { fakeAuth, fakeServices, renderRoutes, type Viewer } from './render.helper';

// The machine can be heavily loaded: wait longer than the 1 s default before failing.
configure({ asyncUtilTimeout: 8000 });

const session = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  method: 'oidc',
  assurance: 'oidc',
};
const me = (patch: Partial<Viewer> = {}): Viewer => ({
  userId: session.userId,
  employee: null,
  menus: ['leave'],
  companyScope: true,
  ...patch,
});
const requestId = '7c8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a33';
const data = (patch: Partial<LeaveReconciliation> = {}): LeaveReconciliation => ({
  year: 2026,
  total: '1',
  items: [
    {
      employeeId: '5b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a22',
      employeeCode: 'NV007',
      employeeName: 'Nguyễn Văn Giả',
      month: 3,
      accruedMinutes: 1440,
      approvedMinutes: 0,
      pendingMinutes: 2400,
      excessMinutes: 960,
      requestIds: [requestId],
    },
  ],
  ...patch,
});
const render = (client: Partial<LeaveClient>, viewer = me()) =>
  renderRoutes(
    routes,
    fakeAuth({ session: () => Promise.resolve(session) }),
    '/leave',
    {},
    fakeServices({ viewer, leave: client }),
  );

describe('leave reconciliation (HR)', () => {
  it('is hidden without company scope and never asks the API', async () => {
    const read = vi.fn(() => Promise.resolve(data()));
    render({ reconciliation: read }, me({ companyScope: false }));
    await screen.findByRole('heading', { level: 1, name: 'Phép năm' });
    expect(screen.queryByRole('heading', { name: 'Đối soát phép' })).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it('lists the excess by employee and month in days, with a link to each request', async () => {
    const read = vi.fn(() => Promise.resolve(data()));
    render({ reconciliation: read });
    const section = await screen.findByRole('region', { name: 'Đối soát phép' });
    const row = (await within(section).findByText('NV007')).closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText('Nguyễn Văn Giả')).toBeInTheDocument();
    expect(cells.getByText('3')).toBeInTheDocument();
    // 1440/480 = 3, 2400/480 = 5, 960/480 = 2.
    expect(row).toHaveTextContent('3 ngày');
    expect(row).toHaveTextContent('5 ngày');
    expect(row).toHaveTextContent('2 ngày');
    expect(cells.getByRole('link')).toHaveAttribute('href', `/requests/${requestId}`);
    expect(read).toHaveBeenCalledWith({ year: null, page: 1 }, expect.anything());
    // Read only: nothing here edits or cancels.
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says so when nothing exceeds', async () => {
    render({ reconciliation: () => Promise.resolve(data({ total: '0', items: [] })) });
    expect(await screen.findByText('Không có đơn chờ vượt phép tích lũy.')).toBeInTheDocument();
  });
});

describe('leave client: reconciliation', () => {
  it('asks for the year only when given, with the page window', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(data()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const client = createLeaveClient(createHttpClient(fetchImpl));
    await client.reconciliation({ year: null, page: 1 });
    await client.reconciliation({ year: 2025, page: 2 });
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual([
      '/api/hr/leave/reconciliation?limit=20&offset=0',
      '/api/hr/leave/reconciliation?year=2025&limit=20&offset=20',
    ]);
  });
});
