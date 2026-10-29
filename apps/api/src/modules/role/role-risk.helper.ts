import type { RoleGrantSpec } from '../../authorization/helpers/role-grant.helper.js';

/**
 * A role holding both can submit and finally approve its own request: `approvals` alone makes
 * every submit end in `final_approval_unavailable`, `decideFinal` alone has no approver gate.
 */
export const SELF_APPROVAL_PERMISSIONS = [
  'hrCompany.approvals',
  'workRequest.decideFinal',
] as const;

export const hasSelfApproval = (grants: readonly RoleGrantSpec[]): boolean =>
  SELF_APPROVAL_PERMISSIONS.every((permission) => grants.some((g) => g.permission === permission));

export type GrantRisk =
  'requestDecision' | 'selfAdjustment' | 'employeeWrite' | 'accountLink' | 'accountAdministration';

export interface HighRiskGrantPair {
  readonly permission: string;
  readonly template: string;
  readonly risk: GrantRisk;
}

const requestTemplates = [
  'allRequests',
  'decidedRequests',
  'finalQueue',
  'leadRejectedLeadRequests',
  'ledRequests',
  'ownRequests',
];

const rules: readonly {
  readonly risk: GrantRisk;
  readonly permissions: readonly string[];
  readonly templates: readonly string[];
}[] = [
  {
    risk: 'requestDecision',
    permissions: [
      'workRequest.decideFinal',
      'workRequest.decideLead',
      'workRequest.cancelApproved',
      'workRequest.cancel',
    ],
    templates: requestTemplates,
  },
  {
    risk: 'selfAdjustment',
    permissions: [
      'employee.adjustLeaveBalance',
      'employee.adjustLeaveRate',
      'employee.adjustAttendance',
    ],
    templates: ['selfEmployee', 'ledEmployees'],
  },
  {
    risk: 'employeeWrite',
    permissions: ['employee.update', 'employee.submitRequest'],
    templates: ['allEmployees', 'ledEmployees'],
  },
  {
    risk: 'accountLink',
    permissions: ['employee.linkAccount'],
    templates: ['allEmployees', 'ledEmployees', 'selfEmployee'],
  },
  {
    risk: 'accountLink',
    permissions: ['team.assign'],
    templates: ['allTeams', 'ledTeams', 'memberTeams'],
  },
  {
    risk: 'accountAdministration',
    permissions: [
      'account.provision',
      'account.reactivate',
      'account.read',
      'account.readPermissions',
      'account.suspend',
    ],
    templates: ['allAccounts'],
  },
];

/** Closed list; `role-risk.spec.ts` pins it and the permissions it does not name. */
export const highRiskGrantPairs: readonly HighRiskGrantPair[] = rules.flatMap((rule) =>
  rule.permissions.flatMap((permission) =>
    rule.templates.map((template) => ({ permission, template, risk: rule.risk })),
  ),
);
