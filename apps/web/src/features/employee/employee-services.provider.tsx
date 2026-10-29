import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { useSession } from '../auth/session.provider';
import type { EmployeeClient } from './employee.client';

const EmployeeContext = createContext<EmployeeClient | undefined>(undefined);

/** Employee API client, created once by the composition root (app.tsx) and faked in tests. */
export function EmployeeServicesProvider(props: {
  readonly client: EmployeeClient;
  readonly children: ReactNode;
}) {
  return <EmployeeContext.Provider value={props.client}>{props.children}</EmployeeContext.Provider>;
}

export function useEmployeeClient(): EmployeeClient {
  const value = useContext(EmployeeContext);
  if (!value) throw new Error('useEmployeeClient must be used inside EmployeeServicesProvider');
  return value;
}

/**
 * The caller's own employee (`GET /api/hr/employees/me`) and the `companyScope` display
 * hint, cached per session. Display only: the API authorizes every action.
 */
export function useOwnEmployee() {
  const { namespace } = useSession();
  const employees = useEmployeeClient();
  return useQuery({
    queryKey: [namespace, 'employee', 'me'],
    queryFn: ({ signal }) => employees.me(signal),
  });
}
