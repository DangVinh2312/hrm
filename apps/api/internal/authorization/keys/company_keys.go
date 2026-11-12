package keys

type CompanyResource string

const (
	CompanyResourceCompany CompanyResource = "hrCompany"
)

type CompanyTemplate string

const (
	CompanyTemplateCompany CompanyTemplate = "company"
)

type CompanyAction string

const (
	CompanyActionRead           CompanyAction = "read"
	CompanyActionCreateEmployee CompanyAction = "createEmployee"
	CompanyActionCreateTeam     CompanyAction = "createTeam"
	CompanyActionApprovals      CompanyAction = "approvals"
	CompanyActionManagePeriod   CompanyAction = "managePeriod"
)
