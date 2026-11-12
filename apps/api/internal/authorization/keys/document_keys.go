package keys

type DocumentRole string

const (
	DocumentRoleReviewer DocumentRole = "reviewer"
)

type DocumentResource string

const (
	DocumentResourceDocument DocumentResource = "document"
)

type DocumentAction string

const (
	DocumentActionRead   DocumentAction = "read"
	DocumentActionUpdate DocumentAction = "update"
)

type DocumentTemplate string

const (
	DocumentTemplateOwnedDocuments DocumentTemplate = "ownedDocuments"
)

type DocumentPolicy string

const (
	DocumentPolicyReadable DocumentPolicy = "readable"
	DocumentPolicyEditable DocumentPolicy = "editable"
)
