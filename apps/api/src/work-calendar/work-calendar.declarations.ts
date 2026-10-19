import type { SystemDeclarations } from '../authorization/core/authorization.declarations.js';
import type { ProductReleaseSource } from '../authorization/services/product-manifest.service.js';
import type { ProductResourceBinding } from '../authorization/product-sql.compiler.js';

/**
 * T4 fragment (design §5.2): the calendar is not PII, every HR role reads it; only HR/Admin
 * changes it, with a fresh session (TD5). Uses the HR policies `hrRead`/`hrFresh` of
 * hr/hr.declarations.ts; an account without an HR role reaches nothing (default deny).
 */
export const workCalendarDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries'
> = {
  resources: [
    {
      // Singleton (WORK_CALENDAR_ID); its version numbers the calendar's change history.
      key: 'workCalendar',
      keyKind: 'uuid',
      fields: {},
      actions: {
        read: { policy: { key: 'hrRead', version: 1 }, boundary: 'optional' },
        manage: { policy: { key: 'hrFresh', version: 1 }, boundary: 'optional' },
      },
    },
  ],
  policies: [],
  templates: [
    {
      key: 'calendar',
      version: 1,
      resource: 'workCalendar',
      parameters: {},
      expression: { op: 'constant', value: true },
    },
  ],
  boundaries: [],
};

const grant = (permission: string, role: string) => ({
  permission,
  role,
  template: { key: 'calendar', version: 1 },
  parameters: {},
});

export const workCalendarDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  grant('workCalendar.read', 'hr.employee'),
  grant('workCalendar.read', 'hr.coo'),
  grant('workCalendar.read', 'hr.admin'),
  grant('workCalendar.manage', 'hr.admin'),
];

export const workCalendarBinding: ProductResourceBinding = {
  resource: 'workCalendar',
  table: 'work_calendar',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: {},
  projection: [],
};
