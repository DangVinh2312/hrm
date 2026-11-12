package team

import "hrm/api/internal/apperror"

type membership struct {
	ID, Team string
	Primary  bool
}

func checkAssignable(account *string, working bool, actor string) error {
	if !working {
		return apperror.ErrCommandRejected
	}
	return checkOther(account, actor)
}
func checkOther(account *string, actor string) error {
	if account != nil && *account == actor {
		return apperror.ErrCommandRejected
	}
	return nil
}
func requireMember(current []membership, team string) error {
	for _, row := range current {
		if row.Team == team {
			return nil
		}
	}
	return apperror.ErrCommandRejected
}
