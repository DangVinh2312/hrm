import { HrResource } from '../hr/hr-authorization.types.js';
import type { ProductCommandContext } from '../../authorization/services/product-authority.service.js';
import { HR_TODAY } from '../hr/helpers/hr-database.helper.js';
import type { EmploymentState } from './employee.types.js';

export const date = (column: string) => `to_char(${column},'YYYY-MM-DD')`;

export const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * State on the business date today. NULL only if the period chain is broken, which the commands
 * never produce; the mapper then fails closed instead of guessing a status.
 */
export const stateSql = (e: string) =>
  `CASE WHEN ${e}.terminated_on IS NOT NULL AND ${e}.terminated_on < ${HR_TODAY} THEN 'terminated'
        WHEN ${e}.hired_on > ${HR_TODAY} THEN 'notStarted'
        ELSE (SELECT p.status FROM employment_status_period p WHERE p.employee_id = ${e}.id
               AND p.starts_on <= ${HR_TODAY} AND (p.ends_on IS NULL OR p.ends_on > ${HR_TODAY})) END`;

export function employmentState(value: string | null): EmploymentState {
  if (
    value === 'probation' ||
    value === 'official' ||
    value === 'notStarted' ||
    value === 'terminated'
  )
    return value;
  throw new Error('Employment periods are inconsistent');
}

export const employeeTarget = (ctx: ProductCommandContext) => ({
  resource: HrResource.Employee,
  key: ctx.target.key,
  objectId: ctx.target.objectId,
});
