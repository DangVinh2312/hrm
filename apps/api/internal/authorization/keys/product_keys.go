package keys

const (
	RuntimeRolePrefix = "custom."
	MaxRoleGrants     = 300
)

func ReportActions() []ReportAction {
	return []ReportAction{ReportActionAttendance, ReportActionLeave, ReportActionLateEarly, ReportActionWfh, ReportActionSeniority, ReportActionBirthday}
}
