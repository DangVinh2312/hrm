package employee

type Status string
type State string
type DocumentKind string
type Gender string
type Classification string

const (
	StatusProbation Status = "probation"
	StatusOfficial  Status = "official"

	StateProbation  State = "probation"
	StateOfficial   State = "official"
	StateNotStarted State = "notStarted"
	StateTerminated State = "terminated"

	DocumentCCCD     DocumentKind = "cccd"
	DocumentCMND     DocumentKind = "cmnd"
	DocumentPassport DocumentKind = "passport"

	GenderMale   Gender = "male"
	GenderFemale Gender = "female"
	GenderOther  Gender = "other"

	ClassificationFullTime   Classification = "fullTime"
	ClassificationContractor Classification = "contractor"
)

const (
	minAnnualMinutes = 5760
	maxAnnualMinutes = 175_680
)

// Identity is the F2 data of one employee; nil clears a field. It never goes to a log, an audit or a URL.
// Phone is canonical national digits and WorkEmail canonical lowercase; neither is a login identity.
type Identity struct {
	DateOfBirth    *string       `json:"dateOfBirth"`
	DocumentKind   *DocumentKind `json:"documentKind"`
	DocumentNumber *string       `json:"documentNumber"`
	TaxCode        *string       `json:"taxCode"`
	Gender         *Gender       `json:"gender"`
	Phone          *string       `json:"phone"`
	WorkEmail      *string       `json:"workEmail"`
}

// Profile is the F1 data shared by create and update; nil is "not recorded".
type Profile struct {
	Position       *string         `json:"position"`
	Classification *Classification `json:"classification"`
}

// LeaveMinutes is the first leave rate of an official hire: the given minutes, or the default setting
// in force when the row is written (Default, Minutes unused).
type LeaveMinutes struct {
	Default bool
	Minutes int
}

// CreateInput carries no rate (AnnualLeave nil) for probation: the rate arrives with the official period.
type CreateInput struct {
	Code        string
	FullName    string
	HiredOn     string
	Status      Status
	AnnualLeave *LeaveMinutes
	Identity    Identity
	Profile
}

type UpdateInput struct {
	EmployeeID      string
	ExpectedVersion string
	Code            string
	FullName        string
	Profile
}

type OfficialInput struct{ EmployeeID, EffectiveOn string }

// TerminationInput: TerminatedOn is the last working day, inclusive.
type TerminationInput struct{ EmployeeID, TerminatedOn string }

type IdentityUpdateInput struct {
	EmployeeID      string
	ExpectedVersion string
	Identity        Identity
}

type LeaveRateInput struct {
	EmployeeID    string
	EffectiveFrom string
	AnnualMinutes int
}

// AccountLinkInput links the profile to an existing IAM account, or unlinks it with a nil AccountID.
type AccountLinkInput struct {
	EmployeeID      string
	ExpectedVersion string
	AccountID       *string
}

// ListQuery: Search matches code or full name literally, 1..100 code points; empty means no filter.
type ListQuery struct {
	Limit, Offset int
	Search        string
}

type TeamRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Summary struct {
	ID          string   `json:"id"`
	Code        string   `json:"code"`
	FullName    string   `json:"fullName"`
	State       State    `json:"state"`
	PrimaryTeam *TeamRef `json:"primaryTeam"`
}

type ListView struct {
	Items []Summary `json:"items"`
	Total string    `json:"total"`
}

type PeriodView struct {
	Status   Status  `json:"status"`
	StartsOn string  `json:"startsOn"`
	EndsOn   *string `json:"endsOn"`
}

type MembershipView struct {
	TeamRef
	Primary bool   `json:"primary"`
	Since   string `json:"since"`
}

// View is the F1 of one employee: no F2 or F3 field.
type View struct {
	ID           string           `json:"id"`
	Code         string           `json:"code"`
	FullName     string           `json:"fullName"`
	HiredOn      string           `json:"hiredOn"`
	TerminatedOn *string          `json:"terminatedOn"`
	State        State            `json:"state"`
	Version      string           `json:"version"`
	AccountID    *string          `json:"accountId"`
	Periods      []PeriodView     `json:"periods"`
	Teams        []MembershipView `json:"teams"`
	Profile
}

type IdentityView struct {
	EmployeeID string `json:"employeeId"`
	Version    string `json:"version"`
	Identity
}

type LeaveRateView struct {
	ID            string `json:"id"`
	EffectiveFrom string `json:"effectiveFrom"`
	AnnualMinutes int    `json:"annualMinutes"`
}

type LeaveRateListView struct {
	Items []LeaveRateView `json:"items"`
}

type Created struct {
	ID string `json:"id"`
}

type Versioned struct {
	Version string `json:"version"`
}

type OwnEmployee struct {
	ID       string `json:"id"`
	Code     string `json:"code"`
	FullName string `json:"fullName"`
}

// SelfView is GET /api/hr/employees/me; CompanyScope is a display hint, every operation is still authorized.
type SelfView struct {
	Employee     *OwnEmployee `json:"employee"`
	CompanyScope bool         `json:"companyScope"`
}
