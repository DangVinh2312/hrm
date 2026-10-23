import type { SystemDeclarations } from '../../authorization/core/authorization.declarations.js';
import type { ProductReleaseSource } from '../../authorization/services/product-manifest.service.js';
import type { ProductResourceBinding } from '../../authorization/product-sql.compiler.js';
import { PermissionPolicy, PermissionRole } from '../permission/permission-authorization.types.js';
import {
  WorkCalendarAction,
  WorkCalendarResource,
  WorkCalendarTemplate,
} from './work-calendar-authorization.types.js';

/**
 * T4 fragment (design §5.2): the calendar is not PII, every HR role reads it; only HR/Admin
 * changes it, with a fresh session (TD5). Uses the shared policies `hrRead`/`hrFresh` of
 * permission/permission.declarations.ts; an account without an HR role reaches nothing (default deny).
 */
export const workCalendarDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries'
> = {
  resources: [
    {
      // Singleton (WORK_CALENDAR_ID); its version numbers the calendar's change history.
      key: WorkCalendarResource.WorkCalendar,
      keyKind: 'uuid',
      fields: {},
      actions: {
        [WorkCalendarAction.Read]: {
          policy: { key: PermissionPolicy.Read, version: 1 },
          boundary: 'optional',
        },
        [WorkCalendarAction.Manage]: {
          policy: { key: PermissionPolicy.Fresh, version: 1 },
          boundary: 'optional',
        },
      },
    },
  ],
  policies: [],
  templates: [
    {
      key: WorkCalendarTemplate.Calendar,
      version: 1,
      resource: WorkCalendarResource.WorkCalendar,
      parameters: {},
      expression: { op: 'constant', value: true },
    },
  ],
  boundaries: [],
};

const grant = (action: WorkCalendarAction, role: PermissionRole) => ({
  permission: `${WorkCalendarResource.WorkCalendar}.${action}`,
  role,
  template: { key: WorkCalendarTemplate.Calendar, version: 1 },
  parameters: {},
});

export const workCalendarDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  grant(WorkCalendarAction.Read, PermissionRole.Employee),
  grant(WorkCalendarAction.Read, PermissionRole.Coo),
  grant(WorkCalendarAction.Read, PermissionRole.Admin),
  grant(WorkCalendarAction.Manage, PermissionRole.Admin),
];

export const workCalendarBinding: ProductResourceBinding = {
  resource: WorkCalendarResource.WorkCalendar,
  table: 'work_calendar',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: {},
  projection: [],
};
