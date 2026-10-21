import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { useSession } from '../auth/session.provider';
import type { AttendanceClient } from '../attendance/attendance.client';
import type { EmployeeClient } from '../employee/employee.client';
import type { LeaveClient } from '../leave/leave.client';
import type { TeamClient } from '../team/team.client';
import type { WorkCalendarClient } from '../work-calendar/work-calendar.client';
import type { WorkRequestClient } from '../work-request/work-request.client';
import type { HrClient } from './hr.client';

/** HR API clients, created once by the composition root (app.tsx) and faked in tests. */
export interface HrServices {
  readonly hr: HrClient;
  readonly employees: EmployeeClient;
  readonly teams: TeamClient;
  readonly workCalendar: WorkCalendarClient;
  readonly workRequest: WorkRequestClient;
  readonly leave: LeaveClient;
  readonly attendance: AttendanceClient;
}

const HrServicesContext = createContext<HrServices | undefined>(undefined);

export function HrServicesProvider(props: {
  readonly services: HrServices;
  readonly children: ReactNode;
}) {
  return (
    <HrServicesContext.Provider value={props.services}>{props.children}</HrServicesContext.Provider>
  );
}

export function useHrServices(): HrServices {
  const value = useContext(HrServicesContext);
  if (!value) throw new Error('useHrServices must be used inside HrServicesProvider');
  return value;
}

/** Server-granted menus and hints (`GET /api/hr/me`, design §10.2), cached per session. */
export function useHrMe() {
  const { namespace } = useSession();
  const { hr } = useHrServices();
  return useQuery({
    queryKey: [namespace, 'hr', 'me'],
    queryFn: ({ signal }) => hr.me(signal),
  });
}
