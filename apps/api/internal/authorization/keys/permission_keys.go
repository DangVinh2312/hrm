package keys

type PermissionPolicy string

const (
	PermissionPolicyRead   PermissionPolicy = "hrRead"
	PermissionPolicySubmit PermissionPolicy = "hrSubmit"
	PermissionPolicyWrite  PermissionPolicy = "hrWrite"
	PermissionPolicyFresh  PermissionPolicy = "hrFresh"
)

type PermissionBoundary string

const (
	PermissionBoundaryAdministration PermissionBoundary = "hrAdministration"
)

type PermissionRole string

const (
	PermissionRoleEmployee PermissionRole = "hr.employee"
	PermissionRoleCoo      PermissionRole = "hr.coo"
	PermissionRoleAdmin    PermissionRole = "hr.admin"
)
