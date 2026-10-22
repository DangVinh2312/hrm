/** Release 13/14 report read actions on the `employee` resource (declared in hr.declarations.ts). */
export const ReportAction = {
  Attendance: 'reportAttendance',
  Leave: 'reportLeave',
  LateEarly: 'reportLateEarly',
  Wfh: 'reportWfh',
  Seniority: 'reportSeniority',
  Birthday: 'reportBirthday',
} as const;

export type ReportAction = (typeof ReportAction)[keyof typeof ReportAction];
