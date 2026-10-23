import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountAction,
  AccountPolicy,
  AccountResource,
  AccountTemplate,
} from '../dist/administration/account-authorization.types.js';
import {
  ProductObligation,
  ProductValidator,
} from '../dist/authorization/product-capability.types.js';
import {
  DocumentAction,
  DocumentPolicy,
  DocumentResource,
  DocumentRole,
  DocumentTemplate,
} from '../dist/document/document-authorization.types.js';
import {
  EmployeeAction,
  EmployeeDomain,
  EmployeeIdentityAction,
  EmployeeRelation,
  EmployeeResource,
  EmployeeTemplate,
  LeaveRateAction,
} from '../dist/modules/employee/employee-authorization.types.js';
import {
  CompanyAction,
  CompanyResource,
  CompanyTemplate,
  PermissionBoundary,
  PermissionPolicy,
  PermissionRole,
} from '../dist/modules/permission/permission-authorization.types.js';
import { permissionKey } from '../dist/modules/permission/permission-declaration.helper.js';
import {
  TeamAction,
  TeamDomain,
  TeamRelation,
  TeamResource,
  TeamTemplate,
} from '../dist/modules/team/team-authorization.types.js';
import {
  WorkRequestAction,
  WorkRequestDomain,
  WorkRequestPolicy,
  WorkRequestRelation,
  WorkRequestResource,
  WorkRequestTemplate,
} from '../dist/modules/work-request/work-request-authorization.types.js';
import { ReportAction } from '../dist/modules/report/report-authorization.types.js';
import {
  WorkCalendarAction,
  WorkCalendarResource,
  WorkCalendarTemplate,
} from '../dist/modules/work-calendar/work-calendar-authorization.types.js';
import { productDeclarations } from '../dist/authorization/product.manifest.js';

// The enum values are the strings stored in the manifest, database and audit log (ADR 0016): the
// literals below are a deliberate second copy, so renaming a value cannot pass unnoticed.
test('authorization key constants keep the exact stored strings', () => {
  assert.deepEqual(Object.values(EmployeeResource), ['employee', 'employeeIdentity', 'leaveRate']);
  assert.deepEqual(Object.values(TeamResource), ['team']);
  assert.deepEqual(Object.values(CompanyResource), ['hrCompany']);
  assert.deepEqual(Object.values(WorkRequestResource), ['workRequest']);
  assert.deepEqual(Object.values(EmployeeAction), [
    'read',
    'submitRequest',
    'update',
    'adjustLeaveRate',
    'readLeaveBalance',
    'readAttendance',
    'adjustLeaveBalance',
    'adjustAttendance',
    'readAttendanceAdjustment',
    'linkAccount',
  ]);
  assert.deepEqual(Object.values(ReportAction), [
    'reportAttendance',
    'reportLeave',
    'reportLateEarly',
    'reportWfh',
    'reportSeniority',
    'reportBirthday',
  ]);
  assert.deepEqual(Object.values(TeamAction), ['read', 'update', 'assign', 'approvals']);
  assert.deepEqual(Object.values(CompanyAction), [
    'read',
    'createEmployee',
    'createTeam',
    'approvals',
    'managePeriod',
  ]);
  assert.deepEqual(Object.values(EmployeeIdentityAction), ['read', 'update']);
  assert.deepEqual(Object.values(LeaveRateAction), ['read']);
  assert.deepEqual(Object.values(WorkRequestAction), [
    'read',
    'decideLead',
    'decideFinal',
    'readDecided',
    'readLeadRejected',
    'cancel',
    'cancelApproved',
  ]);
  assert.deepEqual(Object.values(PermissionPolicy), ['hrRead', 'hrSubmit', 'hrWrite', 'hrFresh']);
  assert.deepEqual(Object.values(WorkRequestPolicy), [
    'leadStage',
    'finalStage',
    'pendingStage',
    'approvedFresh',
  ]);
  assert.deepEqual(Object.values(PermissionRole), ['hr.employee', 'hr.coo', 'hr.admin']);
  assert.deepEqual(Object.values(EmployeeRelation), [
    'employee.lead',
    'employeeIdentity.owner',
    'leaveRate.owner',
  ]);
  assert.deepEqual(Object.values(TeamRelation), ['team.member', 'team.lead']);
  assert.deepEqual(Object.values(WorkRequestRelation), [
    'workRequest.owner',
    'workRequest.lead',
    'workRequest.decider',
    'workRequest.leadRejectedLeadOwned',
  ]);
  assert.deepEqual(Object.values(EmployeeDomain), [
    'hrEmployeeLead',
    'hrEmployeeOwner',
    'hrLeaveRateOwner',
  ]);
  assert.deepEqual(Object.values(TeamDomain), ['hrTeamMember', 'hrTeamLead']);
  assert.deepEqual(Object.values(WorkRequestDomain), [
    'hrRequestOwner',
    'hrRequestLead',
    'hrRequestDecider',
    'hrRequestLeadRejected',
  ]);
  assert.deepEqual(Object.values(PermissionBoundary), ['hrAdministration']);
  assert.deepEqual(Object.values(EmployeeTemplate), [
    'selfEmployee',
    'ledEmployees',
    'allEmployees',
    'selfIdentity',
    'allIdentities',
    'selfLeaveRates',
    'allLeaveRates',
  ]);
  assert.deepEqual(Object.values(TeamTemplate), ['memberTeams', 'ledTeams', 'allTeams']);
  assert.deepEqual(Object.values(WorkRequestTemplate), [
    'ownRequests',
    'ledRequests',
    'decidedRequests',
    'finalQueue',
    'leadRejectedLeadRequests',
    'allRequests',
  ]);
  assert.deepEqual(Object.values(CompanyTemplate), ['company']);
  assert.deepEqual(Object.values(AccountAction), ['suspend', 'provision', 'read']);
  assert.deepEqual(Object.values(AccountPolicy), ['freshAuthentication', 'auditedRead']);
  assert.equal(AccountResource.Account, 'account');
  assert.deepEqual(Object.values(WorkCalendarAction), ['read', 'manage']);
  assert.equal(WorkCalendarResource.WorkCalendar, 'workCalendar');
  assert.deepEqual(Object.values(DocumentAction), ['read', 'update']);
  assert.deepEqual(Object.values(DocumentPolicy), ['readable', 'editable']);
  assert.equal(DocumentResource.Document, 'document');
  assert.equal(DocumentRole.Reviewer, 'reviewer');
  assert.equal(ProductValidator.Fresh, 'fresh@1');
  assert.equal(ProductObligation.Audit, 'audit@1');
  assert.equal(
    permissionKey(EmployeeResource.Employee, EmployeeAction.ReadLeaveBalance),
    'employee.readLeaveBalance',
  );
  assert.equal(
    permissionKey(CompanyResource.Company, CompanyAction.ManagePeriod),
    'hrCompany.managePeriod',
  );
});

// Every declared action has a constant and every constant is declared: a member added to (or left
// out of) one side only is a release change that must be deliberate.
test('declared resources, actions and are covered exactly by the constants', () => {
  const declared = Object.fromEntries(
    productDeclarations.resources.map((resource) => [resource.key, Object.keys(resource.actions)]),
  );

  const own = (...sets: readonly Record<string, string>[]): string[] => {
    const values: string[] = [];
    for (const set of sets) values.push(...Object.values(set));
    return values.sort();
  };

  assert.deepEqual(declared.employee?.slice().sort(), own(EmployeeAction, ReportAction));
  assert.deepEqual(declared.team?.slice().sort(), own(TeamAction));
  assert.deepEqual(declared.hrCompany?.slice().sort(), own(CompanyAction));
  assert.deepEqual(declared.employeeIdentity?.slice().sort(), own(EmployeeIdentityAction));
  assert.deepEqual(declared.leaveRate?.slice().sort(), own(LeaveRateAction));
  assert.deepEqual(declared.workRequest?.slice().sort(), own(WorkRequestAction));
  assert.deepEqual(declared.account?.slice().sort(), own(AccountAction));
  assert.deepEqual(declared.workCalendar?.slice().sort(), own(WorkCalendarAction));
  assert.deepEqual(declared.document?.slice().sort(), own(DocumentAction));
  assert.deepEqual(
    productDeclarations.policies.map((policy) => policy.key).sort(),
    own(PermissionPolicy, WorkRequestPolicy, AccountPolicy, DocumentPolicy),
  );
  assert.deepEqual(
    productDeclarations.templates.map((template) => template.key).sort(),
    own(
      EmployeeTemplate,
      TeamTemplate,
      WorkRequestTemplate,
      CompanyTemplate,
      AccountTemplate,
      WorkCalendarTemplate,
      DocumentTemplate,
    ),
  );
  assert.deepEqual(
    (productDeclarations.relations ?? []).map((relation) => relation.key).sort(),
    own(EmployeeRelation, TeamRelation, WorkRequestRelation),
  );
});
