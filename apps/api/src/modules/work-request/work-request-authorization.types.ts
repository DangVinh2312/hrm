/** Keys of the work request authorization fragment; values are stored strings. */
export const WorkRequestResource = { WorkRequest: 'workRequest' } as const;

export type WorkRequestResource = (typeof WorkRequestResource)[keyof typeof WorkRequestResource];

export const WorkRequestAction = {
  Read: 'read',
  DecideLead: 'decideLead',
  DecideFinal: 'decideFinal',
  ReadDecided: 'readDecided',
  ReadLeadRejected: 'readLeadRejected',
  Cancel: 'cancel',
  CancelApproved: 'cancelApproved',
} as const;

export type WorkRequestAction = (typeof WorkRequestAction)[keyof typeof WorkRequestAction];

/** Stage policies are code-owned: a grant on the wrong stage cannot open a decision. */
export const WorkRequestPolicy = {
  LeadStage: 'leadStage',
  FinalStage: 'finalStage',
  PendingStage: 'pendingStage',
  /** `approved` state and a fresh reauthentication. */
  ApprovedFresh: 'approvedFresh',
} as const;

export type WorkRequestPolicy = (typeof WorkRequestPolicy)[keyof typeof WorkRequestPolicy];

export const WorkRequestTemplate = {
  OwnRequests: 'ownRequests',
  LedRequests: 'ledRequests',
  DecidedRequests: 'decidedRequests',
  FinalQueue: 'finalQueue',
  LeadRejectedLeadRequests: 'leadRejectedLeadRequests',
  AllRequests: 'allRequests',
} as const;

export type WorkRequestTemplate = (typeof WorkRequestTemplate)[keyof typeof WorkRequestTemplate];

export const WorkRequestRelation = {
  RequestOwner: 'workRequest.owner',
  RequestLead: 'workRequest.lead',
  RequestDecider: 'workRequest.decider',
  RequestLeadRejectedLeadOwned: 'workRequest.leadRejectedLeadOwned',
} as const;

export type WorkRequestRelation = (typeof WorkRequestRelation)[keyof typeof WorkRequestRelation];

export const WorkRequestDomain = {
  RequestOwner: 'hrRequestOwner',
  RequestLead: 'hrRequestLead',
  RequestDecider: 'hrRequestDecider',
  RequestLeadRejected: 'hrRequestLeadRejected',
} as const;

export type WorkRequestDomain = (typeof WorkRequestDomain)[keyof typeof WorkRequestDomain];
