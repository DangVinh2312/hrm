import type { ReactNode } from 'react';
import type { AdministrationClient } from '../features/administration/administration.client';
import { AdministrationServicesProvider } from '../features/administration/administration-services.provider';
import type { AttendanceClient } from '../features/attendance/attendance.client';
import { AttendanceServicesProvider } from '../features/attendance/attendance-services.provider';
import type { MeClient } from '../features/auth/me.client';
import { MeProvider } from '../features/auth/me.provider';
import type { EmployeeClient } from '../features/employee/employee.client';
import { EmployeeServicesProvider } from '../features/employee/employee-services.provider';
import type { LeaveClient } from '../features/leave/leave.client';
import { LeaveServicesProvider } from '../features/leave/leave-services.provider';
import type { ReportClient } from '../features/report/report.client';
import { ReportServicesProvider } from '../features/report/report-services.provider';
import type { SettingClient } from '../features/setting/setting.client';
import { SettingServicesProvider } from '../features/setting/setting-services.provider';
import type { TeamClient } from '../features/team/team.client';
import { TeamServicesProvider } from '../features/team/team-services.provider';
import type { WorkCalendarClient } from '../features/work-calendar/work-calendar.client';
import { WorkCalendarServicesProvider } from '../features/work-calendar/work-calendar-services.provider';
import type { WorkRequestClient } from '../features/work-request/work-request.client';
import { WorkRequestServicesProvider } from '../features/work-request/work-request-services.provider';

/** API clients of the signed-in features, created once by the composition root and faked in tests. */
export interface FeatureServices {
  readonly me: MeClient;
  readonly employees: EmployeeClient;
  readonly teams: TeamClient;
  readonly workCalendar: WorkCalendarClient;
  readonly workRequest: WorkRequestClient;
  readonly leave: LeaveClient;
  readonly attendance: AttendanceClient;
  readonly report: ReportClient;
  readonly administration: AdministrationClient;
  readonly setting: SettingClient;
}

/** Hands each client to the context its feature owns; no feature reads another feature's context by key. */
export function FeatureServicesProvider(props: {
  readonly services: FeatureServices;
  readonly children: ReactNode;
}) {
  const { services } = props;
  return (
    <MeProvider client={services.me}>
      <EmployeeServicesProvider client={services.employees}>
        <TeamServicesProvider client={services.teams}>
          <WorkCalendarServicesProvider client={services.workCalendar}>
            <WorkRequestServicesProvider client={services.workRequest}>
              <LeaveServicesProvider client={services.leave}>
                <AttendanceServicesProvider client={services.attendance}>
                  <ReportServicesProvider client={services.report}>
                    <AdministrationServicesProvider client={services.administration}>
                      <SettingServicesProvider client={services.setting}>
                        {props.children}
                      </SettingServicesProvider>
                    </AdministrationServicesProvider>
                  </ReportServicesProvider>
                </AttendanceServicesProvider>
              </LeaveServicesProvider>
            </WorkRequestServicesProvider>
          </WorkCalendarServicesProvider>
        </TeamServicesProvider>
      </EmployeeServicesProvider>
    </MeProvider>
  );
}
