import type { MeMenu } from '../../authentication/authentication.http-port.js';
import {
  ProductAccessDenied,
  type ProductAuthorization,
} from '../../authorization/services/product-authority.service.js';
import { reportActions } from '../report/report.declarations.js';
import type { EmployeeCommandRepository } from './repositories/employee-command.repository.js';
import type { EmployeeReadRepository } from './repositories/employee-read.repository.js';
import type {
  AccountLinkInput,
  EmployeeCreateInput,
  EmployeeIdentityUpdateInput,
  EmployeeIdentityView,
  EmployeeListQuery,
  EmployeeListView,
  EmployeeOfficialInput,
  EmployeeSelfView,
  EmployeeTerminationInput,
  EmployeeUpdateInput,
  EmployeeView,
  LeaveRateInput,
  LeaveRateView,
} from './employee.types.js';

const reportActionKeys = Object.keys(reportActions);

export const employeeCommands = (commands: EmployeeCommandRepository) =>
  [
    commands.createEmployee,
    commands.updateEmployee,
    commands.confirmOfficial,
    commands.terminateEmployee,
    commands.updateIdentity,
    commands.adjustLeaveRate,
    commands.linkAccount,
  ] as const;

export const employeeQueries = (reads: EmployeeReadRepository) =>
  [
    reads.listEmployees,
    reads.employeeDetail,
    reads.identityDetail,
    reads.leaveRates,
    reads.ownEmployee,
  ] as const;

/**
 * Employee operations bound to the commands/queries registered at composition. Every call is
 * one authorized transaction; `undefined` means absent or not visible (HTTP 404).
 */
export class EmployeeService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly commands: EmployeeCommandRepository,
    private readonly reads: EmployeeReadRepository,
  ) {}

  list(secret: string, query: EmployeeListQuery): Promise<EmployeeListView> {
    return this.authorization.query(secret, this.reads.listEmployees, query);
  }

  detail(secret: string, employeeId: string): Promise<EmployeeView | undefined> {
    return this.authorization.query(secret, this.reads.employeeDetail, { employeeId });
  }

  async create(secret: string, input: EmployeeCreateInput): Promise<{ readonly id: string }> {
    const created = await this.authorization.execute(secret, this.commands.createEmployee, input);
    // The anchor always exists once ready, so "not visible" can only mean no grant: 403, and
    // nothing about any record is revealed by it.
    if (!created) throw new ProductAccessDenied();
    return created;
  }

  update(secret: string, input: EmployeeUpdateInput) {
    return this.authorization.execute(secret, this.commands.updateEmployee, input);
  }

  confirmOfficial(secret: string, input: EmployeeOfficialInput) {
    return this.authorization.execute(secret, this.commands.confirmOfficial, input);
  }

  terminate(secret: string, input: EmployeeTerminationInput) {
    return this.authorization.execute(secret, this.commands.terminateEmployee, input);
  }

  identity(secret: string, employeeId: string): Promise<EmployeeIdentityView | undefined> {
    return this.authorization.query(secret, this.reads.identityDetail, { employeeId });
  }

  updateIdentity(secret: string, input: EmployeeIdentityUpdateInput) {
    return this.authorization.execute(secret, this.commands.updateIdentity, input);
  }

  leaveRates(secret: string, employeeId: string): Promise<readonly LeaveRateView[]> {
    return this.authorization.query(secret, this.reads.leaveRates, { employeeId });
  }

  adjustLeaveRate(secret: string, input: LeaveRateInput) {
    return this.authorization.execute(secret, this.commands.adjustLeaveRate, input);
  }

  linkAccount(secret: string, input: AccountLinkInput) {
    return this.authorization.execute(secret, this.commands.linkAccount, input);
  }

  /**
   * The caller's own employee link and the company-scope hint (`GET /api/hr/employees/me`, ADR
   * 0037). Display only: Root or an unlinked account gets `employee: null`, and a missing
   * `employee.read` grant counts as "nothing visible". `companyScope` = the hrCompany.read plan
   * reaches the anchor (`permits`: a plan without grants reaches nothing).
   */
  async profile(secret: string): Promise<EmployeeSelfView> {
    const { own } = await this.ownEmployee(secret);
    return {
      employee: own,
      companyScope: await this.authorization.permits(secret, 'hrCompany', 'read'),
    };
  }

  /**
   * Menu keys for `GET /api/auth/me` (design §10.2); composed into the authentication port at the
   * composition root. Display only: `employees` when the caller sees someone besides themself or
   * holds company scope, `teams` when any team is visible or company scope, `requests` when the
   * caller has a linked profile and may submit (T5), `approvals` when the caller holds an
   * approval right, whether or not anything waits (T6 part C): the current lead of a team
   * (team.approvals over ledTeams) or the company's final step (hrCompany.approvals: hr.coo, and
   * Root); `accounts` when account.read reaches an IAM account (Root, or a runtime grant: no
   * release role holds it), `settings` when setting.read reaches the settings (admin and COO by
   * release grant, Root, a runtime grant), `roles` when role.read reaches the role anchor (the
   * administrative role by release grant, Root, a runtime grant). Each page still authorizes every read and write itself.
   */
  async menus(secret: string): Promise<readonly MeMenu[]> {
    const employees = await this.ownEmployee(secret);

    // Only a linked profile can submit, read its own balance or sheet (selfEmployee); a Root or
    // unlinked account has none, so those probes are not asked. One transaction answers all.
    const probe = (resource: string, action: string) => ({ resource, action });

    const linked = employees.own !== null;
    const answers = await this.authorization.permitsMany(secret, [
      probe('team', 'read'),
      probe('hrCompany', 'read'),
      probe('workCalendar', 'read'),
      // Either approval right (team lead, company final step); stops at the first.
      [probe('team', 'approvals'), probe('hrCompany', 'approvals')],
      // Any of the six report actions reaching a row (T9 web); each report still authorizes itself.
      reportActionKeys.map((action) => probe('employee', action)),
      // The accounts page joins this one lookup, not a second one.
      probe('account', 'read'),
      // The settings page joins it too; 16 pairs for a linked account,
      // exactly MAX_PERMIT_PROBES, so the limit is not raised.
      probe('setting', 'read'),
      // The role matrix page joins it too, 17 pairs for a linked
      // account, exactly MAX_PERMIT_PROBES after the measured raise from 16.
      probe('role', 'read'),
      ...(linked
        ? ['submitRequest', 'readLeaveBalance', 'readAttendance'].map((a) => probe('employee', a))
        : []),
    ]);
    const [teams = false, company = false, calendar = false] = answers;
    const [approvals = false, reports = false] = answers.slice(3);
    const accounts = answers[5] === true;
    const settings = answers[6] === true;
    const roles = answers[7] === true;
    const [requests, leave, attendance] = linked ? answers.slice(8) : [];
    const menus: MeMenu[] = [];
    if (requests === true) menus.push('requests');
    if (approvals) menus.push('approvals');
    if (company || employees.others) menus.push('employees');
    if (company || teams) menus.push('teams');
    if (calendar) menus.push('calendar');
    if (leave === true) menus.push('leave');
    if (attendance === true) menus.push('attendance');
    if (reports) menus.push('reports');
    if (accounts) menus.push('accounts');
    if (settings) menus.push('settings');
    if (roles) menus.push('roles');
    return menus;
  }

  /** Display-only read: a denial is "nothing visible". Never used for an operation (403 there). */
  private ownEmployee(secret: string) {
    return this.authorization
      .query(secret, this.reads.ownEmployee, undefined)
      .catch((error: unknown) => {
        if (error instanceof ProductAccessDenied) return { own: null, others: false };
        throw error;
      });
  }
}
