package keys

type EmployeeAction string

const (
	EmployeeActionRead                     EmployeeAction = "read"
	EmployeeActionSubmitRequest            EmployeeAction = "submitRequest"
	EmployeeActionUpdate                   EmployeeAction = "update"
	EmployeeActionAdjustLeaveRate          EmployeeAction = "adjustLeaveRate"
	EmployeeActionReadLeaveBalance         EmployeeAction = "readLeaveBalance"
	EmployeeActionReadAttendance           EmployeeAction = "readAttendance"
	EmployeeActionAdjustLeaveBalance       EmployeeAction = "adjustLeaveBalance"
	EmployeeActionAdjustAttendance         EmployeeAction = "adjustAttendance"
	EmployeeActionReadAttendanceAdjustment EmployeeAction = "readAttendanceAdjustment"
	EmployeeActionLinkAccount              EmployeeAction = "linkAccount"
	EmployeeActionReadSchedule             EmployeeAction = "readSchedule"
	EmployeeActionManageSchedule           EmployeeAction = "manageSchedule"
)

type EmployeeRelation string

const (
	EmployeeRelationEmployeeLead          EmployeeRelation = "employee.lead"
	EmployeeRelationEmployeeIdentityOwner EmployeeRelation = "employeeIdentity.owner"
	EmployeeRelationLeaveRateOwner        EmployeeRelation = "leaveRate.owner"
)

type EmployeeDomain string

const (
	EmployeeDomainEmployeeLead   EmployeeDomain = "hrEmployeeLead"
	EmployeeDomainEmployeeOwner  EmployeeDomain = "hrEmployeeOwner"
	EmployeeDomainLeaveRateOwner EmployeeDomain = "hrLeaveRateOwner"
)

type EmployeeTemplate string

const (
	EmployeeTemplateSelfEmployee   EmployeeTemplate = "selfEmployee"
	EmployeeTemplateLedEmployees   EmployeeTemplate = "ledEmployees"
	EmployeeTemplateAllEmployees   EmployeeTemplate = "allEmployees"
	EmployeeTemplateSelfIdentity   EmployeeTemplate = "selfIdentity"
	EmployeeTemplateAllIdentities  EmployeeTemplate = "allIdentities"
	EmployeeTemplateSelfLeaveRates EmployeeTemplate = "selfLeaveRates"
	EmployeeTemplateAllLeaveRates  EmployeeTemplate = "allLeaveRates"
)

type EmployeeResource string

const (
	EmployeeResourceEmployee         EmployeeResource = "employee"
	EmployeeResourceEmployeeIdentity EmployeeResource = "employeeIdentity"
	EmployeeResourceLeaveRate        EmployeeResource = "leaveRate"
)
