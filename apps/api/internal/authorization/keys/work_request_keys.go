package keys

type WorkRequestResource string

const (
	WorkRequestResourceWorkRequest WorkRequestResource = "workRequest"
)

type WorkRequestRelation string

const (
	WorkRequestRelationRequestOwner                 WorkRequestRelation = "workRequest.owner"
	WorkRequestRelationRequestLead                  WorkRequestRelation = "workRequest.lead"
	WorkRequestRelationRequestDecider               WorkRequestRelation = "workRequest.decider"
	WorkRequestRelationRequestLeadRejectedLeadOwned WorkRequestRelation = "workRequest.leadRejectedLeadOwned"
)

type WorkRequestPolicy string

const (
	WorkRequestPolicyLeadStage     WorkRequestPolicy = "leadStage"
	WorkRequestPolicyFinalStage    WorkRequestPolicy = "finalStage"
	WorkRequestPolicyPendingStage  WorkRequestPolicy = "pendingStage"
	WorkRequestPolicyApprovedFresh WorkRequestPolicy = "approvedFresh"
)

type WorkRequestTemplate string

const (
	WorkRequestTemplateOwnRequests              WorkRequestTemplate = "ownRequests"
	WorkRequestTemplateLedRequests              WorkRequestTemplate = "ledRequests"
	WorkRequestTemplateDecidedRequests          WorkRequestTemplate = "decidedRequests"
	WorkRequestTemplateFinalQueue               WorkRequestTemplate = "finalQueue"
	WorkRequestTemplateLeadRejectedLeadRequests WorkRequestTemplate = "leadRejectedLeadRequests"
	WorkRequestTemplateAllRequests              WorkRequestTemplate = "allRequests"
)

type WorkRequestAction string

const (
	WorkRequestActionRead             WorkRequestAction = "read"
	WorkRequestActionDecideLead       WorkRequestAction = "decideLead"
	WorkRequestActionDecideFinal      WorkRequestAction = "decideFinal"
	WorkRequestActionReadDecided      WorkRequestAction = "readDecided"
	WorkRequestActionReadLeadRejected WorkRequestAction = "readLeadRejected"
	WorkRequestActionCancel           WorkRequestAction = "cancel"
	WorkRequestActionCancelApproved   WorkRequestAction = "cancelApproved"
)

type WorkRequestDomain string

const (
	WorkRequestDomainRequestOwner        WorkRequestDomain = "hrRequestOwner"
	WorkRequestDomainRequestLead         WorkRequestDomain = "hrRequestLead"
	WorkRequestDomainRequestDecider      WorkRequestDomain = "hrRequestDecider"
	WorkRequestDomainRequestLeadRejected WorkRequestDomain = "hrRequestLeadRejected"
)
