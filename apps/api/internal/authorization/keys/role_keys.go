package keys

type RoleResource string

const (
	RoleResourceRole RoleResource = "role"
)

type RoleAction string

const (
	RoleActionRead   RoleAction = "read"
	RoleActionCreate RoleAction = "create"
	RoleActionUpdate RoleAction = "update"
	RoleActionDelete RoleAction = "delete"
)

type RoleTemplate string

const (
	RoleTemplateRole RoleTemplate = "role"
)
