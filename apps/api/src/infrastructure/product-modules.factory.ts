import type {
  ProductAuthorization,
  ProductCommand,
  ProductQuery,
} from '../authorization/services/product-authority.service.js';
import { AttendanceFactsRepository } from '../modules/attendance/repositories/attendance-facts.repository.js';
import { AttendanceEffectRepository } from '../modules/attendance/repositories/attendance-effect.repository.js';
import { AttendanceAdjustRepository } from '../modules/attendance/repositories/attendance-adjust.repository.js';
import { AttendancePeriodRepository } from '../modules/attendance/repositories/attendance-period.repository.js';
import {
  AttendanceService,
  attendanceCommands,
  attendanceQueries,
} from '../modules/attendance/attendance.service.js';
import { PermissionObjectRepository } from '../modules/permission/permission-object.repository.js';
import { EmployeeWriteRepository } from '../modules/employee/repositories/employee-write.repository.js';
import { EmployeeCommandRepository } from '../modules/employee/repositories/employee-command.repository.js';
import { EmployeeRateRepository } from '../modules/employee/repositories/employee-rate.repository.js';
import { EmployeeReadRepository } from '../modules/employee/repositories/employee-read.repository.js';
import {
  EmployeeService,
  employeeCommands,
  employeeQueries,
} from '../modules/employee/employee.service.js';
import { LeaveFactsRepository } from '../modules/leave/repositories/leave-facts.repository.js';
import { LeaveEffectRepository } from '../modules/leave/repositories/leave-effect.repository.js';
import { LeaveReadRepository } from '../modules/leave/repositories/leave-read.repository.js';
import {
  LeaveService,
  createAdjustLeaveBalance,
  leaveCommands,
  leaveQueries,
} from '../modules/leave/leave.service.js';
import { ReportExportRepository } from '../modules/report/repositories/report-export.repository.js';
import { ReportBirthdayRepository } from '../modules/report/repositories/report-birthday.repository.js';
import { ReportLeaveRepository } from '../modules/report/repositories/report-leave.repository.js';
import { ReportSeniorityRepository } from '../modules/report/repositories/report-seniority.repository.js';
import { ReportSheetRepository } from '../modules/report/repositories/report-sheet.repository.js';
import {
  type ReportRepositories,
  ReportService,
  reportQueries,
} from '../modules/report/services/report.service.js';
import { TeamReadRepository } from '../modules/team/team-read.repository.js';
import {
  TeamService,
  createTeam,
  teamCommands,
  teamQueries,
} from '../modules/team/team.service.js';
import { RequestApprovalReadRepository } from '../modules/work-request/repositories/request-approval-read.repository.js';
import { WorkRequestReadRepository } from '../modules/work-request/repositories/work-request-read.repository.js';
import {
  type ApprovedEffects,
  RequestApprovalService,
  approvalCommands,
  approvalQueries,
  createApprovalCommands,
  createApprovedEffects,
} from '../modules/work-request/services/request-approval.service.js';
import {
  RequestCancelService,
  cancelCommands,
  cancelQueries,
  createCancelCommands,
} from '../modules/work-request/services/request-cancel.service.js';
import {
  WorkRequestService,
  createSubmitRequest,
  workRequestCommands,
  workRequestQueries,
} from '../modules/work-request/services/work-request.service.js';
import { RoleReadRepository } from '../modules/role/repositories/role-read.repository.js';
import { RoleService, roleQueries } from '../modules/role/role.service.js';
import { SettingCommandRepository } from '../modules/setting/repositories/setting-command.repository.js';
import { SettingReadRepository } from '../modules/setting/repositories/setting-read.repository.js';
import {
  SettingService,
  settingCommands,
  settingQueries,
} from '../modules/setting/setting.service.js';
import {
  WorkCalendarService,
  createSetCalendarDay,
  createSetCalendarHolidays,
  workCalendarCommands,
  workCalendarQueries,
} from '../modules/work-calendar/work-calendar.service.js';

/** Every HR repository, created once at the composition root and passed down explicitly. */
export interface ProductModuleRepositories {
  readonly attendanceFacts: AttendanceFactsRepository;
  readonly attendancePeriod: AttendancePeriodRepository;
  readonly attendanceAdjust: AttendanceAdjustRepository;
  readonly attendanceEffect: AttendanceEffectRepository;
  readonly permissionObject: PermissionObjectRepository;
  readonly employeeCommand: EmployeeCommandRepository;
  readonly employeeRead: EmployeeReadRepository;
  readonly leaveFacts: LeaveFactsRepository;
  readonly leaveEffect: LeaveEffectRepository;
  readonly leaveRead: LeaveReadRepository;
  readonly reports: ReportRepositories;
  readonly requestApprovalRead: RequestApprovalReadRepository;
  readonly roleRead: RoleReadRepository;
  readonly settingCommand: SettingCommandRepository;
  readonly settingRead: SettingReadRepository;
  readonly teamRead: TeamReadRepository;
  readonly workRequestRead: WorkRequestReadRepository;
}

/** The HR services bound to one `ProductAuthorization`. */
export interface ProductModuleServices {
  readonly employees: EmployeeService;
  readonly teams: TeamService;
  readonly workCalendar: WorkCalendarService;
  readonly workRequests: WorkRequestService;
  readonly approvals: RequestApprovalService;
  readonly cancellations: RequestCancelService;
  readonly leave: LeaveService;
  readonly attendance: AttendanceService;
  readonly reports: ReportService;
  readonly roles: RoleService;
  readonly settings: SettingService;
}

export interface ProductModuleOptions {
  /**
   * A stand-in effect set for tests of the approval effects themselves. Without it the
   * production set (`leave`, `wfh`, `attendance`) is used, as in `ProductRuntime`.
   */
  readonly effects?: ApprovedEffects;
}

export interface ProductModules {
  readonly repositories: ProductModuleRepositories;
  /** Commands and queries fixed at composition; `ProductAuthorization` refuses others. */
  readonly commands: readonly ProductCommand<never, unknown>[];
  readonly queries: readonly ProductQuery<never, unknown>[];
  /** The registered final-decision command (the gated one when `effects` was given). */
  readonly finalDecision: ReturnType<typeof createApprovalCommands>['finalDecision'];
  /** The registered submit command (over `effects` when given). */
  readonly submitRequest: ReturnType<typeof createSubmitRequest>;
  readonly effects: ApprovedEffects;

  bindServices(authorization: ProductAuthorization): ProductModuleServices;
}

export function createProductModuleRepositories(): ProductModuleRepositories {
  const attendanceFacts = new AttendanceFactsRepository();
  const leaveFacts = new LeaveFactsRepository();
  const permissionObject = new PermissionObjectRepository();
  const settingRead = new SettingReadRepository();
  const sources = {
    sheet: new ReportSheetRepository(settingRead),
    leave: new ReportLeaveRepository(),
    seniority: new ReportSeniorityRepository(),
    birthday: new ReportBirthdayRepository(settingRead),
  };
  const reports: ReportRepositories = {
    ...sources,
    exports: new ReportExportRepository(sources, settingRead),
  };
  return {
    permissionObject,
    settingRead,
    roleRead: new RoleReadRepository(),
    settingCommand: new SettingCommandRepository(),
    attendanceFacts,
    attendanceEffect: new AttendanceEffectRepository(attendanceFacts, settingRead),
    attendancePeriod: new AttendancePeriodRepository(attendanceFacts),
    attendanceAdjust: new AttendanceAdjustRepository(attendanceFacts),
    employeeCommand: new EmployeeCommandRepository(
      permissionObject,
      new EmployeeWriteRepository(),
      new EmployeeRateRepository(permissionObject, settingRead),
    ),
    employeeRead: new EmployeeReadRepository(),
    leaveFacts,
    leaveEffect: new LeaveEffectRepository(leaveFacts),
    leaveRead: new LeaveReadRepository(leaveFacts),
    reports,
    requestApprovalRead: new RequestApprovalReadRepository(),
    teamRead: new TeamReadRepository(),
    workRequestRead: new WorkRequestReadRepository(),
  };
}

/**
 * The composition of the HR module: repositories, the commands that need them and the services
 * that call them. Used by `ProductRuntime` and by the test stacks, so both register the same
 * objects (`ProductAuthorization.execute`/`query` compare by identity).
 */
export function createProductModules(options: ProductModuleOptions = {}): ProductModules {
  const repositories = createProductModuleRepositories();
  const effects =
    options.effects ??
    createApprovedEffects(repositories.attendanceEffect, repositories.leaveEffect);
  const submitRequest = createSubmitRequest(
    repositories.permissionObject,
    effects,
    repositories.attendanceFacts,
    repositories.attendanceEffect,
    repositories.leaveEffect,
    repositories.settingRead,
  );
  const createTeamCommand = createTeam(repositories.permissionObject);
  const approval = createApprovalCommands(effects);
  const cancel = createCancelCommands(repositories.attendanceEffect, repositories.leaveEffect);
  const setCalendarDay = createSetCalendarDay(repositories.attendanceFacts);
  const setCalendarHolidays = createSetCalendarHolidays(repositories.attendanceFacts);
  const adjustLeaveBalance = createAdjustLeaveBalance(repositories.attendanceFacts);
  return {
    repositories,
    commands: [
      ...employeeCommands(repositories.employeeCommand),
      ...teamCommands(createTeamCommand),
      ...workCalendarCommands(setCalendarDay, setCalendarHolidays),
      ...workRequestCommands(submitRequest),
      ...approvalCommands(approval),
      ...cancelCommands(cancel),
      ...leaveCommands(adjustLeaveBalance),
      ...attendanceCommands(repositories.attendancePeriod, repositories.attendanceAdjust),
      ...settingCommands(repositories.settingCommand),
    ],
    queries: [
      ...employeeQueries(repositories.employeeRead),
      ...teamQueries(repositories.teamRead),
      ...workCalendarQueries,
      ...workRequestQueries(repositories.workRequestRead),
      ...approvalQueries(repositories.requestApprovalRead),
      ...cancelQueries,
      ...leaveQueries(repositories.leaveRead),
      ...attendanceQueries(repositories.attendancePeriod, repositories.attendanceAdjust),
      ...reportQueries(repositories.reports),
      ...settingQueries(repositories.settingRead),
      ...roleQueries(repositories.roleRead),
    ],
    finalDecision: approval.finalDecision,
    submitRequest,
    effects,
    bindServices: (authorization) => ({
      employees: new EmployeeService(
        authorization,
        repositories.employeeCommand,
        repositories.employeeRead,
      ),
      teams: new TeamService(authorization, repositories.teamRead, createTeamCommand),
      workCalendar: new WorkCalendarService(authorization, setCalendarDay, setCalendarHolidays),
      workRequests: new WorkRequestService(
        authorization,
        submitRequest,
        repositories.workRequestRead,
      ),
      approvals: new RequestApprovalService(
        authorization,
        approval,
        repositories.requestApprovalRead,
      ),
      cancellations: new RequestCancelService(authorization, cancel),
      leave: new LeaveService(authorization, adjustLeaveBalance, repositories.leaveRead),
      attendance: new AttendanceService(
        authorization,
        repositories.attendancePeriod,
        repositories.attendanceAdjust,
      ),
      reports: new ReportService(authorization, repositories.reports),
      roles: new RoleService(authorization, repositories.roleRead),
      settings: new SettingService(
        authorization,
        repositories.settingCommand,
        repositories.settingRead,
      ),
    }),
  };
}
