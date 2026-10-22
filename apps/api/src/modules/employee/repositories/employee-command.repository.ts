import {
  HrResource,
  CompanyAction,
  EmployeeAction,
  EmployeeIdentityAction,
} from '../../hr/hr-authorization.types.js';
import { randomUUID } from 'node:crypto';
import {
  ProductCommandRejected,
  type ProductCommand,
} from '../../../authorization/services/product-authority.service.js';
import { HR_COMPANY_ID, registerHrObject } from '../../hr/helpers/hr-database.helper.js';
import {
  assertSheetsOpenFrom,
  bumpEmployee,
  employeeTarget,
  unique,
} from '../employee-database.helper.js';
import type {
  AccountLinkInput,
  EmployeeCreateInput,
  EmployeeIdentityUpdateInput,
  EmployeeOfficialInput,
  EmployeeTerminationInput,
  EmployeeUpdateInput,
  LeaveRateInput,
} from '../employee.types.js';

export class EmployeeCommandRepository {
  /**
   * hrCompany.createEmployee: F1 + F2 + first status period + first F3 rate, one commit. Refused
   * while a month from the hire date on is closed (D07, `assertSheetsOpenFrom`).
   */
  readonly createEmployee: ProductCommand<EmployeeCreateInput, { readonly id: string }> = {
    resource: HrResource.Company,
    action: CompanyAction.CreateEmployee,
    mode: 'write',
    target: () => HR_COMPANY_ID,
    run: async (ctx, input) => {
      await assertSheetsOpenFrom(ctx.tx.manager, input.hiredOn, false);
      const id = randomUUID();
      const objectId = await registerHrObject(ctx.tx, HrResource.Employee, id);
      await unique(
        ctx.tx.manager.query(
          `INSERT INTO employee(id,object_id,code,full_name,hired_on,job_position,classification)
         VALUES($1,$2,$3,$4,CAST($5 AS date),$6,$7)`,
          [
            id,
            objectId,
            input.code,
            input.fullName,
            input.hiredOn,
            input.position,
            input.classification,
          ],
        ),
      );
      const identity = input.identity;
      await unique(
        ctx.tx.manager.query(
          `INSERT INTO employee_identity(employee_id,object_id,date_of_birth,document_kind,document_number,tax_code,gender,phone,work_email)
         VALUES($1,$2,CAST($3 AS date),$4,$5,$6,$7,$8,$9)`,
          [
            id,
            await registerHrObject(ctx.tx, HrResource.EmployeeIdentity, id),
            identity.dateOfBirth,
            identity.documentKind,
            identity.documentNumber,
            identity.taxCode,
            identity.gender,
            identity.phone,
            identity.workEmail,
          ],
        ),
      );
      await ctx.tx.manager.query(
        'INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES($1,$2,$3,CAST($4 AS date))',
        [randomUUID(), id, input.status, input.hiredOn],
      );
      const rate = randomUUID();
      await ctx.tx.manager.query(
        'INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes) VALUES($1,$2,$3,CAST($4 AS date),$5)',
        [
          rate,
          await registerHrObject(ctx.tx, HrResource.LeaveRate, rate),
          id,
          input.hiredOn,
          input.annualLeaveMinutes,
        ],
      );
      await ctx.audit('hr.employee.create', { resource: HrResource.Employee, key: id, objectId });
      return { id };
    },
  };

  /** employee.update: code, full name, position and classification only (allowlist), optimistic version. */
  readonly updateEmployee: ProductCommand<EmployeeUpdateInput, { readonly version: string }> = {
    resource: HrResource.Employee,
    action: EmployeeAction.Update,
    mode: 'write',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      const rows = await unique(
        ctx.tx.manager.query<{ version: string }[]>(
          `WITH updated AS (UPDATE employee SET code = $2, full_name = $3, job_position = $5,
           classification = $6, version = version + 1
           WHERE id = $1 AND version = CAST($4 AS int8) RETURNING version::text AS version)
         SELECT * FROM updated`,
          [
            ctx.target.key,
            input.code,
            input.fullName,
            input.expectedVersion,
            input.position,
            input.classification,
          ],
        ),
      );
      if (!rows[0]) throw new ProductCommandRejected('stale_version');
      await ctx.audit('hr.employee.update', employeeTarget(ctx));
      return { version: rows[0].version };
    },
  };

  /**
   * employee.update: probation → official from `effectiveOn`. The open period must be probation and
   * start before that day; the chain stays gapless (old period ends where the new one starts).
   */
  readonly confirmOfficial: ProductCommand<EmployeeOfficialInput, { readonly version: string }> = {
    resource: HrResource.Employee,
    action: EmployeeAction.Update,
    mode: 'write',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      const closed = await ctx.tx.manager.query<{ id: string }[]>(
        `WITH closed AS (UPDATE employment_status_period p SET ends_on = CAST($2 AS date)
           FROM employee e
           WHERE p.employee_id = $1 AND e.id = p.employee_id AND p.ends_on IS NULL
             AND p.status = 'probation' AND p.starts_on < CAST($2 AS date)
             AND e.terminated_on IS NULL
           RETURNING p.id) SELECT * FROM closed`,
        [ctx.target.key, input.effectiveOn],
      );
      if (closed.length !== 1) throw new ProductCommandRejected('invalid_status_change');
      await ctx.tx.manager.query(
        `INSERT INTO employment_status_period(id,employee_id,status,starts_on) VALUES($1,$2,'official',CAST($3 AS date))`,
        [randomUUID(), ctx.target.key, input.effectiveOn],
      );
      const version = await bumpEmployee(ctx, undefined);
      await ctx.audit('hr.employee.status', employeeTarget(ctx));
      return { version };
    },
  };

  /**
   * employee.update: last working day; closes the open period the day after. Not reversible here.
   * Refused while a month from the last working day on is closed (D07, `assertSheetsOpenFrom`).
   */
  readonly terminateEmployee: ProductCommand<
    EmployeeTerminationInput,
    { readonly version: string }
  > = {
    resource: HrResource.Employee,
    action: EmployeeAction.Update,
    mode: 'write',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      await assertSheetsOpenFrom(ctx.tx.manager, input.terminatedOn, true);
      const closed = await ctx.tx.manager.query<{ id: string }[]>(
        `WITH closed AS (UPDATE employment_status_period p SET ends_on = CAST($2 AS date) + 1
         FROM employee e
         WHERE p.employee_id = $1 AND e.id = p.employee_id AND p.ends_on IS NULL
           AND p.starts_on <= CAST($2 AS date) AND e.terminated_on IS NULL
           AND e.hired_on <= CAST($2 AS date)
         RETURNING p.id) SELECT * FROM closed`,
        [ctx.target.key, input.terminatedOn],
      );
      if (closed.length !== 1) throw new ProductCommandRejected('invalid_status_change');
      await ctx.tx.manager.query(
        'UPDATE employee SET terminated_on = CAST($2 AS date) WHERE id = $1',
        [ctx.target.key, input.terminatedOn],
      );
      const version = await bumpEmployee(ctx, undefined);
      await ctx.audit('hr.employee.status', employeeTarget(ctx));
      return { version };
    },
  };

  /** employeeIdentity.update (F2, fresh): whole F2 replaced, optimistic version. */
  readonly updateIdentity: ProductCommand<
    EmployeeIdentityUpdateInput,
    { readonly version: string }
  > = {
    resource: HrResource.EmployeeIdentity,
    action: EmployeeIdentityAction.Update,
    mode: 'write',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      const { identity } = input;
      const rows = await unique(
        ctx.tx.manager.query<{ version: string }[]>(
          `WITH updated AS (UPDATE employee_identity SET date_of_birth = CAST($2 AS date),
           document_kind = $3, document_number = $4, tax_code = $5, gender = $7, phone = $8,
           work_email = $9, version = version + 1
           WHERE employee_id = $1 AND version = CAST($6 AS int8) RETURNING version::text AS version)
         SELECT * FROM updated`,
          [
            ctx.target.key,
            identity.dateOfBirth,
            identity.documentKind,
            identity.documentNumber,
            identity.taxCode,
            input.expectedVersion,
            identity.gender,
            identity.phone,
            identity.workEmail,
          ],
        ),
      );
      if (!rows[0]) throw new ProductCommandRejected('stale_version');
      await ctx.audit('hr.employee-identity.update', {
        resource: HrResource.EmployeeIdentity,
        key: ctx.target.key,
        objectId: ctx.target.objectId,
      });
      return { version: rows[0].version };
    },
  };

  /** employee.adjustLeaveRate (F3, fresh): adds a rate row; history is never rewritten. */
  readonly adjustLeaveRate: ProductCommand<LeaveRateInput, { readonly id: string }> = {
    resource: HrResource.Employee,
    action: EmployeeAction.AdjustLeaveRate,
    mode: 'write',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      const [employee] = await ctx.tx.manager.query<{ valid: boolean }[]>(
        'SELECT hired_on <= CAST($2 AS date) AS valid FROM employee WHERE id = $1',
        [ctx.target.key, input.effectiveFrom],
      );
      if (!employee?.valid) throw new ProductCommandRejected('before_hire');
      const id = randomUUID();
      const objectId = await registerHrObject(ctx.tx, HrResource.LeaveRate, id);
      await unique(
        ctx.tx.manager.query(
          'INSERT INTO leave_rate(id,object_id,employee_id,effective_from,annual_minutes) VALUES($1,$2,$3,CAST($4 AS date),$5)',
          [id, objectId, ctx.target.key, input.effectiveFrom, input.annualMinutes],
        ),
      );
      await ctx.audit('hr.leave-rate.adjust', {
        resource: HrResource.LeaveRate,
        key: id,
        objectId,
      });
      return { id };
    },
  };

  /**
   * employee.linkAccount (admin, fresh, boundary required): the account must be an IAM account
   * that is not suspended and not linked elsewhere (UNIQUE). Nobody moves a link to or from their
   * own account: that would hand them, or take away from them, every `self`/lead scope.
   */
  readonly linkAccount: ProductCommand<AccountLinkInput, { readonly version: string }> = {
    resource: HrResource.Employee,
    action: EmployeeAction.LinkAccount,
    mode: 'admin',
    target: (input) => input.employeeId,
    run: async (ctx, input) => {
      const [employee] = await ctx.tx.manager.query<{ account: string | null; version: string }[]>(
        'SELECT account_id::text AS account, version::text AS version FROM employee WHERE id = $1',
        [ctx.target.key],
      );
      if (!employee) throw new Error('Locked target vanished');
      if (employee.version !== input.expectedVersion)
        throw new ProductCommandRejected('stale_version');
      if (employee.account === ctx.actor.id || input.accountId === ctx.actor.id)
        throw new ProductCommandRejected('self_link');
      if (employee.account === input.accountId) throw new ProductCommandRejected('unchanged');
      if (input.accountId !== null) {
        const [account] = await ctx.tx.manager.query<{ kind: string; state: string }[]>(
          'SELECT kind, state FROM app_user WHERE id = $1',
          [input.accountId],
        );
        if (account?.kind !== 'iam' || account.state === 'suspended')
          throw new ProductCommandRejected('account_unavailable');
      }
      await unique(
        ctx.tx.manager.query('UPDATE employee SET account_id = $2 WHERE id = $1', [
          ctx.target.key,
          input.accountId,
        ]),
      );
      const version = await bumpEmployee(ctx, input.expectedVersion);
      await ctx.audit('hr.employee.link-account', employeeTarget(ctx));
      return { version };
    },
  };
}
