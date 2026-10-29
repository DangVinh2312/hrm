import type { ProductScope } from '../../authorization/services/product-authority.service.js';
import {
  authorizationScopeViews,
  employeeOwnerViews,
  requestLeadViews,
} from '../../database/migrations/002-application-baseline.migration.js';

const dataTables = [
  'employee',
  'team',
  'team_membership',
  'team_lead_assignment',
  'work_request',
  'request_decision',
  'employee_identity',
  'employment_status_period',
  'leave_rate',
  'hr_company',
  'work_calendar',
  'work_calendar_change',
  'work_request_segment',
  'hr_idempotency',
  'leave_bucket',
  'leave_ledger',
  'wfh_month_counter',
  'attendance_period',
  'attendance_period_event',
  'attendance_adjustment',
  // The settings anchor, the current values and their history.
  'setting_anchor',
  'system_setting',
  'system_setting_history',
  // The role anchor `role.*` permissions apply to.
  'role_anchor',
];
export const permissionViews = {
  ...authorizationScopeViews,
  ...employeeOwnerViews,
  ...requestLeadViews,
};

export const registerObjectPrivilege = 'function:hr_register_object(text, uuid):EXECUTE';

const columns = (privilege: string, table: string, names: readonly string[]) =>
  names.map((name) => `column:${table}.${name}:${privilege}`);

/**
 * Exact grants the HRM migrations (T2, T3 employee/team, T4 work calendar, T5 requests) add to each login; part of the startup
 * privilege probe. The data login never writes `employee.account_id` or membership/lead rows.
 */
export const permissionPrivileges = {
  data: [
    ...[...dataTables, ...Object.keys(permissionViews)].map((t) => `table:${t}:SELECT`),
    'table:work_request:INSERT',
    'table:request_decision:INSERT',
    'table:employee_identity:INSERT',
    'table:employment_status_period:INSERT',
    'table:leave_rate:INSERT',
    'column:work_request.state:UPDATE',
    'column:work_request.version:UPDATE',
    ...columns('INSERT', 'employee', [
      'id',
      'object_id',
      'code',
      'full_name',
      'hired_on',
      'job_position',
      'classification',
    ]),
    ...columns('UPDATE', 'employee', [
      'version',
      'code',
      'full_name',
      'terminated_on',
      'job_position',
      'classification',
    ]),
    ...columns('UPDATE', 'employee_identity', [
      'date_of_birth',
      'document_kind',
      'document_number',
      'tax_code',
      'version',
      'gender',
      'phone',
      'work_email',
    ]),
    'column:employment_status_period.ends_on:UPDATE',
    'column:hr_company.version:UPDATE',
    ...columns('INSERT', 'team', ['id', 'object_id', 'name']),
    ...columns('UPDATE', 'team', ['name', 'version']),
    // T4: append-only calendar history; the singleton row only bumps its version.
    'table:work_calendar_change:INSERT',
    'column:work_calendar.version:UPDATE',
    // T5: segments and idempotency claims are append-only for the runtime.
    'table:work_request_segment:INSERT',
    'table:hr_idempotency:INSERT',
    // T7: the ledger is append-only for the runtime; a bucket is created and locked (revision).
    'table:leave_ledger:INSERT',
    'table:leave_bucket:INSERT',
    'column:leave_bucket.revision:UPDATE',
    // T8: counters and periods are created and locked by the approval/close transaction; the
    // period history is append-only.
    'table:wfh_month_counter:INSERT',
    'table:attendance_period:INSERT',
    'table:attendance_period_event:INSERT',
    // T8 attendance.adjust: append-only for the runtime (no UPDATE, no DELETE).
    'table:attendance_adjustment:INSERT',
    ...columns('UPDATE', 'wfh_month_counter', ['approved_count', 'revision']),
    ...columns('UPDATE', 'attendance_period', ['state', 'version', 'snapshot', 'snapshot_hash']),
    // Current rows are created and updated (never deleted), the history is
    // append-only; the anchor only bumps its version for the row lock.
    'table:system_setting:INSERT',
    'table:system_setting_history:INSERT',
    'column:setting_anchor.version:UPDATE',
    ...columns('UPDATE', 'system_setting', ['value', 'version', 'updated_at', 'updated_by']),
    registerObjectPrivilege,
  ],
  authority: [
    ...['employee', 'team', 'team_membership', 'team_lead_assignment'].map(
      (t) => `table:${t}:SELECT`,
    ),
    'table:team_membership:INSERT',
    'table:team_lead_assignment:INSERT',
    'column:team_membership.ends_at:UPDATE',
    'column:team_lead_assignment.ends_at:UPDATE',
    'column:employee.account_id:UPDATE',
    'column:employee.version:UPDATE',
    'column:team.version:UPDATE',
  ],
  sync: [
    'table:hr_company:SELECT',
    'table:hr_company:INSERT',
    'table:work_calendar:SELECT',
    'table:work_calendar:INSERT',
    'table:setting_anchor:SELECT',
    'table:setting_anchor:INSERT',
    'table:role_anchor:SELECT',
    'table:role_anchor:INSERT',
  ],
} as const;

/** Parameters after the plan's own, with the placeholder of the i-th (1-based) added value. */
export function scopedParameters(scope: ProductScope, ...values: readonly unknown[]) {
  const base = scope.parameters.length;
  return {
    parameters: [...scope.parameters, ...values],
    at: (index: number) => `$${base + index}`,
  };
}

/** Key of the single `hrCompany` record, parent of company-level creates (design §7.2). */
export const COMPANY_ID = '00000000-0000-4000-8000-000000000c01';

/** Key of the single `workCalendar` record (T4): permissions and the current version. */
export const WORK_CALENDAR_ID = '00000000-0000-4000-8000-000000000c02';

/** Key of the single `setting` record: the four setting permissions apply to it. */
export const SETTING_ID = '00000000-0000-4000-8000-000000000c03';

/** Key of the single `role` record: `role.*` permissions apply to it. */
export const ROLE_ID = '00000000-0000-4000-8000-000000000c04';
