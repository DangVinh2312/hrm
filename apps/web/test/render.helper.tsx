import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import type { AccountClient } from '../src/features/account/account.client';
import { AccountServicesProvider } from '../src/features/account/account-services.provider';
import { createQueryClient } from '../src/app/query-client.factory';
import type { AuthClient } from '../src/features/auth/auth.client';
import { SessionProvider, createSessionEvents } from '../src/features/auth/session.provider';
import type { AdministrationClient } from '../src/features/administration/administration.client';
import type { AttendanceClient } from '../src/features/attendance/attendance.client';
import type { AuthMe, MeClient } from '../src/features/auth/me.client';
import type { EmployeeClient, OwnEmployee } from '../src/features/employee/employee.client';
import {
  type FeatureServices,
  FeatureServicesProvider,
} from '../src/app/feature-services.provider';
import { ApiError } from '../src/infrastructure/http.client';
import type { LeaveClient } from '../src/features/leave/leave.client';
import type { ReportClient } from '../src/features/report/report.client';
import type { SettingClient } from '../src/features/setting/setting.client';
import type { TeamClient } from '../src/features/team/team.client';
import type { WorkCalendarClient } from '../src/features/work-calendar/work-calendar.client';
import type { WorkRequestClient } from '../src/features/work-request/work-request.client';
import type { Locale } from '../src/i18n/i18n.helper';
import { LocalizedDates } from '../src/i18n/dates.provider';
import { I18nProvider } from '../src/i18n/i18n.provider';

/**
 * Renders routes with the production providers; only the network-facing clients (auth, features) are
 * fake.
 */
export function renderRoutes(
  routes: RouteObject[],
  auth: AuthClient,
  initialEntry: string,
  i18n: { readonly locale?: Locale; readonly storage?: Pick<Storage, 'setItem'> } = {},
  services: FeatureServices = fakeServices(),
  account: AccountClient = fakeAccount(),
) {
  const events = createSessionEvents();
  const queryClient = createQueryClient(events.notify);
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  const view = render(
    <MantineProvider>
      <I18nProvider initialLocale={i18n.locale ?? 'vi'} storage={i18n.storage}>
        <LocalizedDates>
          <QueryClientProvider client={queryClient}>
            <SessionProvider auth={auth} events={events}>
              <AccountServicesProvider client={account}>
                <FeatureServicesProvider services={services}>
                  <RouterProvider router={router} />
                </FeatureServicesProvider>
              </AccountServicesProvider>
            </SessionProvider>
          </QueryClientProvider>
        </LocalizedDates>
      </I18nProvider>
    </MantineProvider>,
  );
  return { ...view, router, queryClient, events };
}

export function fakeAuth(overrides: Partial<AuthClient> = {}): AuthClient {
  return {
    session: () => Promise.resolve(null),
    beginLogin: () => Promise.resolve('https://accounts.google.com/o/oauth2/v2/auth?state=s'),
    beginActivation: () => Promise.resolve('https://accounts.google.com/o/oauth2/v2/auth?state=a'),
    logout: () => Promise.resolve(),
    ...overrides,
  };
}

/** Account client for a user with email and no Google account yet; tests override parts. */
export function fakeAccount(overrides: Partial<AccountClient> = {}): AccountClient {
  return {
    account: () =>
      Promise.resolve({
        email: 'person@example.test',
        identities: [],
        mfa: { status: 'none', recoveryCodesRemaining: 0 },
      }),
    setupMfa: () =>
      Promise.resolve({
        uri: 'otpauth://totp/HRM:person%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=HRM&algorithm=SHA1&digits=6&period=30',
        secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      }),
    confirmMfa: () => Promise.resolve([]),
    verifyMfa: () => Promise.resolve(),
    regenerateRecoveryCodes: () => Promise.resolve([]),
    removeMfa: () => Promise.resolve(),
    ...overrides,
  };
}

const notFound = () => Promise.reject(new ApiError(404, 'error.notFound'));

/** What a signed-in test user sees: `GET /api/auth/me` plus `GET /api/hr/employees/me`. */
export interface Viewer {
  readonly userId: string;
  readonly menus: AuthMe['menus'];
  readonly employee: OwnEmployee['employee'];
  readonly companyScope: boolean;
}

const defaultViewer: Viewer = {
  userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
  menus: [],
  employee: null,
  companyScope: false,
};

/** Feature clients that see nothing: no employee, no menu, every record 404. Tests override parts. */
export function fakeServices(
  overrides: {
    readonly viewer?: Viewer;
    readonly me?: Partial<MeClient>;
    readonly employees?: Partial<EmployeeClient>;
    readonly teams?: Partial<TeamClient>;
    readonly workCalendar?: Partial<WorkCalendarClient>;
    readonly workRequest?: Partial<WorkRequestClient>;
    readonly leave?: Partial<LeaveClient>;
    readonly attendance?: Partial<AttendanceClient>;
    readonly report?: Partial<ReportClient>;
    readonly administration?: Partial<AdministrationClient>;
    readonly setting?: Partial<SettingClient>;
  } = {},
): FeatureServices {
  const viewer = overrides.viewer ?? defaultViewer;
  return {
    me: {
      me: () => Promise.resolve({ userId: viewer.userId, menus: viewer.menus }),
      ...overrides.me,
    },
    employees: {
      me: () => Promise.resolve({ employee: viewer.employee, companyScope: viewer.companyScope }),
      list: () => Promise.resolve({ items: [], total: '0' }),
      detail: notFound,
      create: notFound,
      update: notFound,
      confirmOfficial: notFound,
      terminate: notFound,
      identity: notFound,
      updateIdentity: notFound,
      leaveRates: () => Promise.resolve([]),
      addLeaveRate: notFound,
      linkAccount: notFound,
      accounts: () => Promise.reject(new ApiError(403, 'error.accessDenied')),
      ...overrides.employees,
    },
    teams: {
      list: () => Promise.resolve({ items: [], total: '0' }),
      detail: notFound,
      create: notFound,
      rename: notFound,
      addMember: notFound,
      setPrimary: notFound,
      endMembership: notFound,
      assignLead: notFound,
      ...overrides.teams,
    },
    workCalendar: {
      year: notFound,
      setDay: notFound,
      setHolidays: notFound,
      ...overrides.workCalendar,
    },
    workRequest: {
      submit: notFound,
      list: () => Promise.resolve({ items: [], total: '0' }),
      detail: notFound,
      queue: () => Promise.reject(new ApiError(403, 'error.accessDenied')),
      decided: () => Promise.resolve({ items: [], total: '0' }),
      decide: notFound,
      cancel: notFound,
      ...overrides.workRequest,
    },
    leave: {
      balance: notFound,
      reconciliation: () => Promise.reject(new ApiError(403, 'error.accessDenied')),
      ...overrides.leave,
    },
    attendance: {
      sheet: notFound,
      period: notFound,
      closePeriod: notFound,
      reopenPeriod: notFound,
      adjustments: notFound,
      adjust: notFound,
      ...overrides.attendance,
    },
    report: {
      page: () => Promise.reject(new ApiError(403, 'error.accessDenied')),
      download: () => Promise.reject(new ApiError(403, 'error.accessDenied')),
      ...overrides.report,
    },
    administration: {
      list: () => Promise.reject(new ApiError(403, 'error.accessDenied')),
      provision: notFound,
      suspend: notFound,
      reactivate: notFound,
      roles: () => Promise.reject(new ApiError(403, 'error.accessDenied')),
      accountPermissions: notFound,
      assignRole: notFound,
      revokeRole: notFound,
      bindBoundary: notFound,
      unbindBoundary: notFound,
      deleteRole: notFound,
      ...overrides.administration,
    },
    setting: {
      list: notFound,
      profile: notFound,
      security: notFound,
      history: notFound,
      update: notFound,
      ...overrides.setting,
    },
  };
}
