import type { SystemDeclarations } from '../../authorization/core/authorization.declarations.js';
import type { ProductReleaseSource } from '../../authorization/services/product-manifest.service.js';
import type {
  ProductDomainRelationBinding,
  ProductResourceBinding,
} from '../../authorization/product-sql.compiler.js';
import {
  defaultGrant,
  identityRelation,
  optionalAction,
  permissionKey,
  permissionPolicy,
  relatedScope,
  scopeTemplate,
  stateScope,
} from '../permission/permission-declaration.helper.js';
import { PermissionPolicy, PermissionRole } from '../permission/permission-authorization.types.js';
import {
  WorkRequestAction,
  WorkRequestDomain,
  WorkRequestPolicy,
  WorkRequestRelation,
  WorkRequestResource,
  WorkRequestTemplate,
} from './work-request-authorization.types.js';

/**
 * Work request authorization fragment (ADR 0016, ADR 0035): data only, composed into the release
 * in authorization/product.manifest.ts. The design's `work-request.decide-lead` is stored as
 * `workRequest.decideLead` (design §5.3).
 */
export const workRequestDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries' | 'relations'
> = {
  resources: [
    {
      key: WorkRequestResource.WorkRequest,
      keyKind: 'uuid',
      fields: { kind: { kind: 'string' }, state: { kind: 'string' }, version: { kind: 'integer' } },
      actions: {
        [WorkRequestAction.Read]: optionalAction(PermissionPolicy.Read),
        [WorkRequestAction.DecideLead]: optionalAction(WorkRequestPolicy.LeadStage),
        [WorkRequestAction.DecideFinal]: optionalAction(WorkRequestPolicy.FinalStage),
        // Release 8 (T6 part C): the decided history of the caller's approval scope (§5.2); the
        // query adds "decided" and "not the caller's own" before count and page.
        [WorkRequestAction.ReadDecided]: optionalAction(PermissionPolicy.Read),
        // Release 9: detail only, of a lead-owned request rejected at the lead step (COO, read
        // only: no queue, no decision). `WorkRequestService.detail` falls back to it.
        [WorkRequestAction.ReadLeadRejected]: optionalAction(PermissionPolicy.Read),
        // Owner cancels a pending request; HR cancels an approved one with fresh auth (design §6.2).
        [WorkRequestAction.Cancel]: optionalAction(WorkRequestPolicy.PendingStage),
        [WorkRequestAction.CancelApproved]: optionalAction(WorkRequestPolicy.ApprovedFresh),
      },
    },
  ],
  relations: [
    identityRelation(
      WorkRequestRelation.RequestOwner,
      WorkRequestResource.WorkRequest,
      WorkRequestDomain.RequestOwner,
    ),
    identityRelation(
      WorkRequestRelation.RequestLead,
      WorkRequestResource.WorkRequest,
      WorkRequestDomain.RequestLead,
    ),
    identityRelation(
      WorkRequestRelation.RequestDecider,
      WorkRequestResource.WorkRequest,
      WorkRequestDomain.RequestDecider,
    ),
    // Release 9: the request was rejected at the lead step and its owner leads a team now.
    identityRelation(
      WorkRequestRelation.RequestLeadRejectedLeadOwned,
      WorkRequestResource.WorkRequest,
      WorkRequestDomain.RequestLeadRejected,
    ),
  ],
  policies: [
    // Stage policies are code-owned: a grant on the wrong stage cannot open a decision.
    permissionPolicy(WorkRequestPolicy.LeadStage, stateScope('pending_lead')),
    permissionPolicy(WorkRequestPolicy.FinalStage, stateScope('pending_final')),
    permissionPolicy(WorkRequestPolicy.PendingStage, {
      op: 'or',
      args: [stateScope('pending_lead'), stateScope('pending_final')],
    }),
    permissionPolicy(WorkRequestPolicy.ApprovedFresh, stateScope('approved'), true),
  ],
  templates: [
    scopeTemplate(
      WorkRequestTemplate.OwnRequests,
      WorkRequestResource.WorkRequest,
      relatedScope(WorkRequestRelation.RequestOwner),
    ),
    scopeTemplate(
      WorkRequestTemplate.LedRequests,
      WorkRequestResource.WorkRequest,
      relatedScope(WorkRequestRelation.RequestLead),
    ),
    scopeTemplate(
      WorkRequestTemplate.DecidedRequests,
      WorkRequestResource.WorkRequest,
      relatedScope(WorkRequestRelation.RequestDecider),
    ),
    scopeTemplate(
      WorkRequestTemplate.FinalQueue,
      WorkRequestResource.WorkRequest,
      stateScope('pending_final'),
    ),
    // Release 9: the relation already restricts to rejected-at-lead, lead-owned requests.
    scopeTemplate(WorkRequestTemplate.LeadRejectedLeadRequests, WorkRequestResource.WorkRequest, {
      op: 'exists',
      relation: `${WorkRequestRelation.RequestLeadRejectedLeadOwned}@1`,
      where: { op: 'constant', value: true },
    }),
    scopeTemplate(WorkRequestTemplate.AllRequests, WorkRequestResource.WorkRequest, {
      op: 'constant',
      value: true,
    }),
  ],
  boundaries: [],
};

const grant = (action: WorkRequestAction, role: PermissionRole, template: WorkRequestTemplate) =>
  defaultGrant(permissionKey(WorkRequestResource.WorkRequest, action), role, template);

export const workRequestDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  grant(WorkRequestAction.Read, PermissionRole.Employee, WorkRequestTemplate.OwnRequests),
  grant(WorkRequestAction.Read, PermissionRole.Employee, WorkRequestTemplate.LedRequests),
  grant(WorkRequestAction.Read, PermissionRole.Employee, WorkRequestTemplate.DecidedRequests),
  grant(WorkRequestAction.Read, PermissionRole.Coo, WorkRequestTemplate.DecidedRequests),
  grant(WorkRequestAction.Read, PermissionRole.Coo, WorkRequestTemplate.FinalQueue),
  grant(WorkRequestAction.Read, PermissionRole.Admin, WorkRequestTemplate.AllRequests),
  grant(WorkRequestAction.DecideLead, PermissionRole.Employee, WorkRequestTemplate.LedRequests),
  grant(WorkRequestAction.DecideFinal, PermissionRole.Coo, WorkRequestTemplate.AllRequests),
  // Release 8: history and menu follow the approval right — the request's current first-step
  // approver (lead) or the whole company (COO); Root is unrestricted. HR/Admin decides nothing.
  grant(WorkRequestAction.ReadDecided, PermissionRole.Employee, WorkRequestTemplate.LedRequests),
  grant(WorkRequestAction.ReadDecided, PermissionRole.Coo, WorkRequestTemplate.AllRequests),
  // Release 9: the COO reads (never decides) a lead's request rejected at the lead step. A new
  // action, because a sync seeds default grants only for permissions a release creates.
  grant(
    WorkRequestAction.ReadLeadRejected,
    PermissionRole.Coo,
    WorkRequestTemplate.LeadRejectedLeadRequests,
  ),
  grant(WorkRequestAction.Cancel, PermissionRole.Employee, WorkRequestTemplate.OwnRequests),
  grant(WorkRequestAction.CancelApproved, PermissionRole.Admin, WorkRequestTemplate.AllRequests),
];

export const workRequestBinding: ProductResourceBinding = {
  resource: WorkRequestResource.WorkRequest,
  table: 'work_request',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: { kind: 'kind', state: 'state', version: 'version' },
  projection: ['kind', 'state', 'version'],
};

export const workRequestDomains: Readonly<Record<WorkRequestDomain, ProductDomainRelationBinding>> =
  {
    [WorkRequestDomain.RequestOwner]: {
      table: 'hr_request_owner',
      sourceColumn: 'request_id',
      targetColumn: 'account_id',
    },
    [WorkRequestDomain.RequestLead]: {
      table: 'hr_request_lead',
      sourceColumn: 'request_id',
      targetColumn: 'lead_account_id',
    },
    [WorkRequestDomain.RequestDecider]: {
      table: 'hr_request_decider',
      sourceColumn: 'request_id',
      targetColumn: 'actor_account_id',
    },
    [WorkRequestDomain.RequestLeadRejected]: {
      table: 'hr_request_lead_rejected',
      sourceColumn: 'request_id',
      targetColumn: 'owner_account_id',
    },
  };
