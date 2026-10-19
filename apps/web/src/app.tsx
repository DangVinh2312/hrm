import { MantineProvider } from '@mantine/core';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router';
import type { WebConfig } from './app/app.config';
import { AppLayout } from './app/app-layout.component';
import { createQueryClient } from './app/query-client.factory';
import { cssVariablesResolver, theme } from './app/theme.config';
import { createAccountClient } from './account/account.client';
import { AccountServicesProvider } from './account/account-services.provider';
import { ActivatePage } from './auth/activate.page';
import { createAuthClient } from './auth/auth.client';
import { LoginPage } from './auth/login.page';
import { RequireSession } from './auth/require-session.component';
import { SessionProvider, createSessionEvents } from './auth/session.provider';
import { createEmployeeClient } from './employee/employee.client';
import { HomePage } from './home/home.page';
import { createHrClient } from './hr/hr.client';
import { HrServicesProvider } from './hr/hr-services.provider';
import { browserStorage, readStoredLocale } from './i18n/i18n.helper';
import { LocalizedDates } from './i18n/dates.provider';
import { I18nProvider } from './i18n/i18n.provider';
import { NotFoundPage } from './home/not-found.page';
import { createHttpClient } from './infrastructure/http.client';
import { createTeamClient } from './team/team.client';

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
              Component: (await import('./employee/pages/employee-list.page')).EmployeeListPage,
            }),
          },
          {
            path: '/employees/:id',
            lazy: async () => ({
              Component: (await import('./employee/pages/employee-detail.page')).EmployeeDetailPage,
            }),
          },
          {
            path: '/account/sign-in-methods',
            lazy: async () => ({
              Component: (await import('./account/sign-in-methods.page')).SignInMethodsPage,
            }),
          },
          {
            path: '/teams',
            lazy: async () => ({ Component: (await import('./team/team.page')).TeamPage }),
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
