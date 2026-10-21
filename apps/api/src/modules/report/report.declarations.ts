import type { ProductReleaseSource } from '../../authorization/services/product-manifest.service.js';

/**
 * Release 13 (T9 part A, ADR 0016 Release 13): one read action per report on the `employee` row.
 * A report is a computed read, so — like `readLeaveBalance` and `readAttendance` — it is authorized
 * on the employee rows it aggregates and the plan's scope is applied before count and page. The
 * `employee` resource itself is declared in hr.declarations.ts; this fragment owns the action
 * keys and their default grants. Birthday has no action yet (open decision, design §12.0).
 */
const reportAction = { policy: { key: 'hrRead', version: 1 }, boundary: 'optional' as const };

export const reportActions = {
  reportAttendance: reportAction,
  reportLeave: reportAction,
  reportLateEarly: reportAction,
  reportWfh: reportAction,
  reportSeniority: reportAction,
};

const grant = (permission: string, role: string) => ({
  permission,
  role,
  template: { key: 'allEmployees', version: 1 },
  parameters: {},
});

/**
 * Matrix §5.2 `report.*`: the COO (without CCCD/MST: no report carries them) and HR/Admin see the
 * whole company; employee, Team Lead and CEO have no report. New actions, because a sync seeds
 * default grants only for permissions a release creates.
 */
export const reportDefaultGrants: ProductReleaseSource['defaultGrants'] = Object.keys(
  reportActions,
).flatMap((action) => [
  grant(`employee.${action}`, 'hr.coo'),
  grant(`employee.${action}`, 'hr.admin'),
]);
