package keys

type ReportAction string

const (
	ReportActionAttendance ReportAction = "reportAttendance"
	ReportActionLeave      ReportAction = "reportLeave"
	ReportActionLateEarly  ReportAction = "reportLateEarly"
	ReportActionWfh        ReportAction = "reportWfh"
	ReportActionSeniority  ReportAction = "reportSeniority"
	ReportActionBirthday   ReportAction = "reportBirthday"
)
