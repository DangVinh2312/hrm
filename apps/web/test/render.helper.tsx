import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import type { AccountClient } from '../src/account/account.client';
import { AccountServicesProvider } from '../src/account/account-services.provider';
import { createQueryClient } from '../src/app/query-client.factory';
import type { AuthClient } from '../src/auth/auth.client';
import { SessionProvider, createSessionEvents } from '../src/auth/session.provider';
import type { EmployeeClient } from '../src/employee/employee.client';
import { type HrServices, HrServicesProvider } from '../src/hr/hr-services.provider';
import { ApiError } from '../src/infrastructure/http.client';
import type { TeamClient } from '../src/team/team.client';
import type { WorkCalendarClient } from '../src/work-calendar/work-calendar.client';
import type { WorkRequestClient } from '../src/work-request/work-request.client';
import type { Locale } from '../src/i18n/i18n.helper';
import { LocalizedDates } from '../src/i18n/dates.provider';
import { I18nProvider } from '../src/i18n/i18n.provider';

/**
 * Renders routes with the production providers; only the network-facing clients (auth, HR) are
 * fake.
 */
export function renderRoutes(
  routes: RouteObject[],
  auth: AuthClient,
  initialEntry: string,
  i18n: { readonly locale?: Locale; readonly storage?: Pick<Storage, 'setItem'> } = {},
  hr: HrServices = fakeHr(),
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
                <HrServicesProvider services={hr}>
                  <RouterProvider router={router} />
                </HrServicesProvider>
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

/** HR clients that see nothing: no profile, no menu, every record 404. Tests override parts. */
export function fakeHr(
  overrides: {
    readonly hr?: Partial<HrServices['hr']>;
    readonly employees?: Partial<EmployeeClient>;
    readonly teams?: Partial<TeamClient>;
    readonly workCalendar?: Partial<WorkCalendarClient>;
    readonly workRequest?: Partial<WorkRequestClient>;
  } = {},
): HrServices {
  return {
    hr: {
      me: () =>
        Promise.resolve({
          userId: '0b8f8f5c-5a8f-4f43-9d8d-2b8d4a6e3a11',
          employee: null,
          menus: [],
          companyScope: false,
        }),
      ...overrides.hr,
    },
    employees: {
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
      ...overrides.workCalendar,
    },
    workRequest: {
      submit: notFound,
      list: () => Promise.resolve({ items: [], total: '0' }),
      detail: notFound,
      ...overrides.workRequest,
    },
  };
}
