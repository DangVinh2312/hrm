package keys

type AccountPolicy string

const (
	AccountPolicyFreshAuthentication AccountPolicy = "freshAuthentication"
	AccountPolicyAuditedRead         AccountPolicy = "auditedRead"
)

type AccountAction string

const (
	AccountActionSuspend            AccountAction = "suspend"
	AccountActionReactivate         AccountAction = "reactivate"
	AccountActionProvision          AccountAction = "provision"
	AccountActionRead               AccountAction = "read"
	AccountActionReadPermissions    AccountAction = "readPermissions"
	AccountActionAssignRole         AccountAction = "assignRole"
	AccountActionRevokeRole         AccountAction = "revokeRole"
	AccountActionBindBoundary       AccountAction = "bindBoundary"
	AccountActionUnbindBoundary     AccountAction = "unbindBoundary"
	AccountActionChangeEmail        AccountAction = "changeEmail"
	AccountActionResetMfa           AccountAction = "resetMfa"
	AccountActionResetGoogleBinding AccountAction = "resetGoogleBinding"
)

type AccountTemplate string

const (
	AccountTemplateAllAccounts AccountTemplate = "allAccounts"
)

type AccountBoundary string

const (
	AccountBoundaryAdministration         AccountBoundary = "accountAdministration"
	AccountBoundaryIdentityAdministration AccountBoundary = "identityAdministration"
)

type AccountResource string

const (
	AccountResourceAccount AccountResource = "account"
)
