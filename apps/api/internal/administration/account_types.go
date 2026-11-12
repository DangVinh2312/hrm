package administration

// AccountRow is the projection of one IAM account (account_directory): id, email, state, enrollment status.
type AccountRow struct {
	UserID     string  `json:"userId"`
	Email      *string `json:"email"`
	State      string  `json:"state"`
	Enrollment *string `json:"enrollment"`
}

type AccountPage struct {
	Items []AccountRow `json:"items"`
	Total string       `json:"total"`
}

type ProvisionedAccount struct {
	UserID string  `json:"userId"`
	Email  *string `json:"email"`
	State  string  `json:"state"`
}

type Status struct {
	Status string `json:"status"`
}

// BoundaryRef is a boundary version as the catalog stores it and a request names it.
type BoundaryRef struct {
	Key     string
	Version int64
}

// ProvisionInput is the request of account.provision: an email as typed and a role key of at most
// grant.MaxRoleKeyBytes bytes; the service lowers and checks the email.
type ProvisionInput struct {
	Email   string
	RoleKey string
}
