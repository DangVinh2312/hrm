import type { ProductReleaseSource } from '../../authorization/services/product-manifest.service.js';
import { HrPolicy, HrResource, HrRole, HrTemplate } from '../hr/hr-authorization.types.js';
import { ReportAction } from './report-authorization.types.js';

/**
 * Release 13 (T9 part A, ADR 0016 Release 13) and 14 (T9 part B, birthday): one read action per
 * report on the `employee` row.
 * A report is a computed read, so — like `readLeaveBalance` and `readAttendance` — it is authorized
 * on the employee rows it aggregates and the plan's scope is applied before count and page. The
 * `employee` resource itself is declared in hr.declarations.ts; this fragment owns the action
 * keys and their default grants. `reportBirthday` (release 14) reads the day and month of
 * `employee_identity.date_of_birth` as a field of the same authorized row; it selects no other F2 field.
 */
const reportAction = { policy: { key: HrPolicy.Read, version: 1 }, boundary: 'optional' as const };

export const reportActions = {
  [ReportAction.Attendance]: reportAction,
  [ReportAction.Leave]: reportAction,
  [ReportAction.LateEarly]: reportAction,
  [ReportAction.Wfh]: reportAction,
  [ReportAction.Seniority]: reportAction,
  [ReportAction.Birthday]: reportAction,
};

const grant = (action: ReportAction, role: HrRole) => ({
  permission: `${HrResource.Employee}.${action}`,
  role,
  template: { key: HrTemplate.AllEmployees, version: 1 },
  parameters: {},
});

/**
 * Matrix §5.2 `report.*`: the COO (without CCCD/MST: no report carries them) and HR/Admin see the
 * whole company; employee, Team Lead and CEO have no report. New actions, because a sync seeds
 * default grants only for permissions a release creates.
 */
export const reportDefaultGrants: ProductReleaseSource['defaultGrants'] = Object.values(
  ReportAction,
).flatMap((action) => [grant(action, HrRole.Coo), grant(action, HrRole.Admin)]);
