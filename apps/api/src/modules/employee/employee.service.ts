import {
  ProductAccessDenied,
  type ProductAuthorization,
} from '../../authorization/services/product-authority.service.js';
import { visibleOrNothing } from '../hr/helpers/hr-access.helper.js';
import {
  adjustLeaveRate,
  confirmOfficial,
  createEmployee,
  linkAccount,
  terminateEmployee,
  updateEmployee,
  updateIdentity,
} from './repositories/employee-command.repository.js';
import {
  employeeDetail,
  identityDetail,
  leaveRates,
  listEmployees,
  ownEmployee,
} from './repositories/employee-read.repository.js';
import type {
  AccountLinkInput,
  EmployeeCreateInput,
  EmployeeIdentityUpdateInput,
  EmployeeIdentityView,
  EmployeeListQuery,
  EmployeeListView,
  EmployeeOfficialInput,
  EmployeeTerminationInput,
  EmployeeUpdateInput,
  EmployeeView,
  HrMenu,
  HrMeView,
  LeaveRateInput,
  LeaveRateView,
} from './employee.types.js';

export const employeeCommands = [
  createEmployee,
  updateEmployee,
  confirmOfficial,
  terminateEmployee,
  updateIdentity,
  adjustLeaveRate,
  linkAccount,
] as const;

export const employeeQueries = [
  listEmployees,
  employeeDetail,
  identityDetail,
  leaveRates,
  ownEmployee,
] as const;

/**
 * Employee operations bound to the commands/queries registered at composition. Every call is
 * one authorized transaction; `undefined` means absent or not visible (HTTP 404).
 */
export class EmployeeService {
  constructor(private readonly authorization: ProductAuthorization) {}

  list(secret: string, query: EmployeeListQuery): Promise<EmployeeListView> {
    return this.authorization.query(secret, listEmployees, query);
  }

  detail(secret: string, employeeId: string): Promise<EmployeeView | undefined> {
    return this.authorization.query(secret, employeeDetail, { employeeId });
  }

  async create(secret: string, input: EmployeeCreateInput): Promise<{ readonly id: string }> {
    const created = await this.authorization.execute(secret, createEmployee, input);
    // The anchor always exists once ready, so "not visible" can only mean no grant: 403, and
    // nothing about any record is revealed by it.
    if (!created) throw new ProductAccessDenied();
    return created;
  }

  update(secret: string, input: EmployeeUpdateInput) {
    return this.authorization.execute(secret, updateEmployee, input);
  }

  confirmOfficial(secret: string, input: EmployeeOfficialInput) {
    return this.authorization.execute(secret, confirmOfficial, input);
  }

  terminate(secret: string, input: EmployeeTerminationInput) {
    return this.authorization.execute(secret, terminateEmployee, input);
  }

  identity(secret: string, employeeId: string): Promise<EmployeeIdentityView | undefined> {
    return this.authorization.query(secret, identityDetail, { employeeId });
  }

  updateIdentity(secret: string, input: EmployeeIdentityUpdateInput) {
    return this.authorization.execute(secret, updateIdentity, input);
  }

  leaveRates(secret: string, employeeId: string): Promise<readonly LeaveRateView[]> {
    return this.authorization.query(secret, leaveRates, { employeeId });
  }

  adjustLeaveRate(secret: string, input: LeaveRateInput) {
    return this.authorization.execute(secret, adjustLeaveRate, input);
  }

  linkAccount(secret: string, input: AccountLinkInput) {
    return this.authorization.execute(secret, linkAccount, input);
  }

  /**
   * Bootstrap without `userId` (design §10.2). Menus are display only: `employees` when the caller
   * sees someone besides themself or holds company scope, `teams` when any team is visible or
   * company scope, `requests` when the caller has a linked profile and may submit (T5),
   * `approvals` when the caller holds an approval right, whether or not anything waits (T6 part
   * C): the current lead of a team (team.approvals over ledTeams) or the company's final step
   * (hrCompany.approvals: hr.coo, and Root); each page still
   * authorizes every read and write itself. Company scope = the
   * hrCompany.read plan reaches the anchor (`permits`: a plan without grants reaches nothing).
   */
  async me(secret: string): Promise<Omit<HrMeView, 'userId'>> {
    const employees = await visibleOrNothing(
      this.authorization.query(secret, ownEmployee, undefined),
      { own: null, others: false },
    );
    const teams = await this.authorization.permits(secret, 'team', 'read');
    const company = await this.authorization.permits(secret, 'hrCompany', 'read');
    const calendar = await this.authorization.permits(secret, 'workCalendar', 'read');
    // Only a linked profile can submit (selfEmployee); a Root or unlinked account has none.
    const requests =
      employees.own !== null &&
      (await this.authorization.permits(secret, 'employee', 'submitRequest'));
    const approvals =
      (await this.authorization.permits(secret, 'team', 'approvals')) ||
      (await this.authorization.permits(secret, 'hrCompany', 'approvals'));
    // The own balance page: a linked profile whose leave balance the plan lets the caller read.
    const leave =
      employees.own !== null &&
      (await this.authorization.permits(secret, 'employee', 'readLeaveBalance'));
    // The own sheet page: a linked profile whose attendance the plan lets the caller read.
    const attendance =
      employees.own !== null &&
      (await this.authorization.permits(secret, 'employee', 'readAttendance'));
    const menus: HrMenu[] = [];
    if (requests) menus.push('requests');
    if (approvals) menus.push('approvals');
    if (company || employees.others) menus.push('employees');
    if (company || teams) menus.push('teams');
    if (calendar) menus.push('calendar');
    if (leave) menus.push('leave');
    if (attendance) menus.push('attendance');
    return { employee: employees.own, menus, companyScope: company };
  }
}
