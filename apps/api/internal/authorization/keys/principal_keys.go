package keys

type PrincipalKind string

const (
	PrincipalRoot PrincipalKind = "root"
	PrincipalIAM  PrincipalKind = "iam"
)

type MeMenu string

const (
	MeMenuRequests   MeMenu = "requests"
	MeMenuApprovals  MeMenu = "approvals"
	MeMenuEmployees  MeMenu = "employees"
	MeMenuTeams      MeMenu = "teams"
	MeMenuCalendar   MeMenu = "calendar"
	MeMenuLeave      MeMenu = "leave"
	MeMenuAttendance MeMenu = "attendance"
	MeMenuReports    MeMenu = "reports"
	MeMenuAccounts   MeMenu = "accounts"
	MeMenuSettings   MeMenu = "settings"
	MeMenuRoles      MeMenu = "roles"
)
