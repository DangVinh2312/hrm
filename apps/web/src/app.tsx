import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router';
import type { WebConfig } from './app/app.config';
import { AppLayout } from './app/app-layout.component';
import { createQueryClient } from './app/query-client.factory';
import { cssVariablesResolver, theme } from './app/theme.config';
import { createAccountClient } from './features/account/account.client';
import { AccountServicesProvider } from './features/account/account-services.provider';
import { ActivatePage } from './features/auth/pages/activate.page';
import { createAuthClient } from './features/auth/auth.client';
import { LoginPage } from './features/auth/pages/login.page';
import { RequireSession } from './features/auth/components/require-session.component';
import { SessionProvider, createSessionEvents } from './features/auth/session.provider';
import { createEmployeeClient } from './features/employee/employee.client';
import { HomePage } from './features/home/pages/home.page';
import { createHrClient } from './features/hr/hr.client';
import { HrServicesProvider } from './features/hr/hr-services.provider';
import { browserStorage, readStoredLocale } from './i18n/i18n.helper';
import { LocalizedDates } from './i18n/dates.provider';
import { I18nProvider } from './i18n/i18n.provider';
import { NotFoundPage } from './features/home/pages/not-found.page';
import { createHttpClient } from './infrastructure/http.client';
import { createAttendanceClient } from './features/attendance/attendance.client';
import { createLeaveClient } from './features/leave/leave.client';
import { createTeamClient } from './features/team/team.client';
import { createWorkCalendarClient } from './features/work-calendar/work-calendar.client';
import { createWorkRequestClient } from './features/work-request/work-request.client';

/** Page paths never start with /api (ADR 0019). */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/activate', element: <ActivatePage /> },
  {
    element: <RequireSession />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <HomePage /> },
          // Feature pages load on demand (design §10.4), keeping the first bundle small.
          {
            path: '/employees',
            lazy: async () => ({
              Component: (await import('./features/employee/pages/employee-list.page'))
                .EmployeeListPage,
            }),
          },
          {
            path: '/employees/:id',
            lazy: async () => ({
              Component: (await import('./features/employee/pages/employee-detail.page'))
                .EmployeeDetailPage,
            }),
          },
          {
            path: '/account/sign-in-methods',
            lazy: async () => ({
              Component: (await import('./features/account/sign-in-methods.page'))
                .SignInMethodsPage,
            }),
          },
          {
            path: '/teams',
            lazy: async () => ({ Component: (await import('./features/team/team.page')).TeamPage }),
          },
          // `/requests/new` before `/requests/:id`: React Router ranks static segments first.
          {
            path: '/requests',
            lazy: async () => ({
              Component: (await import('./features/work-request/pages/request-list.page'))
                .RequestListPage,
            }),
          },
          {
            path: '/requests/new',
            lazy: async () => ({
              Component: (await import('./features/work-request/pages/request-form.page'))
                .RequestFormPage,
            }),
          },
          {
            path: '/requests/:id',
            lazy: async () => ({
              Component: (await import('./features/work-request/pages/request-detail.page'))
                .RequestDetailPage,
            }),
          },
          {
            path: '/approvals',
            lazy: async () => ({
              Component: (await import('./features/work-request/pages/approval-inbox.page'))
                .ApprovalInboxPage,
            }),
          },
          {
            path: '/leave',
            lazy: async () => ({
              Component: (await import('./features/leave/leave-balance.page')).LeaveBalancePage,
            }),
          },
          {
            path: '/attendance',
            lazy: async () => ({
              Component: (await import('./features/attendance/attendance.page')).AttendancePage,
            }),
          },
          {
            path: '/calendar',
            lazy: async () => ({
              Component: (await import('./features/work-calendar/work-calendar.page'))
                .WorkCalendarPage,
            }),
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];

/** Composition root of the browser app: every client is created once per app instance. */
export function App(props: { readonly config: WebConfig }) {
  const [services] = useState(() => {
    const events = createSessionEvents();
    const storage = browserStorage();
    const http = createHttpClient();
    return {
      events,
      storage,
      locale: readStoredLocale(storage),
      queryClient: createQueryClient(events.notify),
      auth: createAuthClient(http, props.config.oidcIssuer),
      account: createAccountClient(http),
      hr: {
        hr: createHrClient(http),
        employees: createEmployeeClient(http),
        teams: createTeamClient(http),
        workCalendar: createWorkCalendarClient(http),
        workRequest: createWorkRequestClient(http),
        leave: createLeaveClient(http),
        attendance: createAttendanceClient(http),
      },
      router: createBrowserRouter(routes),
    };
  });
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <I18nProvider initialLocale={services.locale} storage={services.storage}>
        <LocalizedDates>
          <QueryClientProvider client={services.queryClient}>
            <SessionProvider auth={services.auth} events={services.events}>
              <AccountServicesProvider client={services.account}>
                <HrServicesProvider services={services.hr}>
                  <RouterProvider router={services.router} />
                </HrServicesProvider>
              </AccountServicesProvider>
            </SessionProvider>
          </QueryClientProvider>
        </LocalizedDates>
      </I18nProvider>
    </MantineProvider>
  );
}
