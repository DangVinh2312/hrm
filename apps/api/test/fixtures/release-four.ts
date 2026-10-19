// Release 4 (ADR 0020) rebuilt from today's source: the HR fragment as it was before release 5
// (T3) added hrCompany, employeeIdentity, leaveRate, the employee/team write actions, their
// policies, scopes and grants. The pinned hash proves the rebuild equals the published release.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import {
  productDeclarations,
  productReleaseSource,
} from '../../dist/authorization/product.manifest.js';

/** Published hash of release 4 (structure.spec.ts before T3). */
export const releaseFourHash = '9be03a37d18a225654478c582b694b415aa32fb438299b27b0add5421bcef666';

const t3Resources = new Set(['hrCompany', 'employeeIdentity', 'leaveRate']);
const t3Actions: Readonly<Record<string, readonly string[]>> = {
  employee: ['update', 'adjustLeaveRate', 'linkAccount'],
  team: ['update', 'assign'],
};
const t3Policies = new Set(['hrWrite', 'hrFresh']);
const t3Relations = new Set(['employeeIdentity.owner', 'leaveRate.owner']);
const t3Grants = new Set([
  'employee.update',
  'employee.adjustLeaveRate',
  'employee.linkAccount',
  'team.update',
  'team.assign',
]);

const declarations = productDeclarations;

export const releaseFourSource: ProductReleaseSource = {
  ...productReleaseSource,
  sequence: '4',
  predecessor: '3',
  declarations: {
    ...declarations,
    resources: declarations.resources
      .filter((resource) => !t3Resources.has(resource.key))
      .map((resource) => {
        const removed = t3Actions[resource.key];
        if (!removed) return resource;
        return {
          ...resource,
          actions: Object.fromEntries(
            Object.entries(resource.actions).filter(([action]) => !removed.includes(action)),
          ),
        };
      }),
    policies: declarations.policies.filter((policy) => !t3Policies.has(policy.key)),
    templates: declarations.templates.filter((template) => !t3Resources.has(template.resource)),
    relations: (declarations.relations ?? []).filter((relation) => !t3Relations.has(relation.key)),
  },
  defaultGrants: productReleaseSource.defaultGrants.filter(
    (grant) =>
      !t3Grants.has(grant.permission) && !t3Resources.has(grant.permission.split('.')[0] ?? ''),
  ),
};
