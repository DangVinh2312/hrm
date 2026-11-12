package team

type CreateInput struct {
	Name string `json:"name"`
}
type RenameInput struct {
	TeamID          string `json:"-"`
	ExpectedVersion string `json:"expectedVersion"`
	Name            string `json:"name"`
}
type MemberInput struct {
	TeamID     string
	EmployeeID string
	Primary    bool
}
type MembershipRef struct{ TeamID, EmployeeID string }
type LeadInput struct {
	TeamID     string
	EmployeeID *string
}
type ListQuery struct{ Limit, Offset int }
type Created struct {
	ID string `json:"id"`
}
type Renamed struct {
	Version string `json:"version"`
}
type Status struct {
	Status string `json:"status"`
}
type Person struct {
	EmployeeID string `json:"employeeId"`
	Code       string `json:"code"`
	FullName   string `json:"fullName"`
}
type Summary struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Lead        *Person `json:"lead"`
	MemberCount int     `json:"memberCount"`
}
type ListView struct {
	Items []Summary `json:"items"`
	Total string    `json:"total"`
}
type MemberView struct {
	Person
	Primary bool   `json:"primary"`
	Since   string `json:"since"`
}
type LeadHistoryView struct {
	Person
	StartsAt string  `json:"startsAt"`
	EndsAt   *string `json:"endsAt"`
}
type View struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Version     string            `json:"version"`
	Lead        *Person           `json:"lead"`
	Members     []MemberView      `json:"members"`
	LeadHistory []LeadHistoryView `json:"leadHistory"`
}
