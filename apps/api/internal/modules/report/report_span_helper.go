package report

import (
	"time"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/attendancecore"
)

func monthIndex(month string) (int, error) {
	if _, err := attendancecore.ParseMonth(month); err != nil {
		return 0, apperror.ErrInvalidRequest
	}
	first, err := time.Parse("2006-01", month)
	if err != nil {
		return 0, apperror.ErrInvalidRequest
	}
	return first.Year()*12 + int(first.Month()), nil
}

// checkSpan refuses an inclusive From..To of fewer than one or more than maxMonths months: the validator
// checks the MaxMonths ceiling, the report repositories report.maxMonths in force.
func checkSpan(from, to string, maxMonths int) error {
	first, err := monthIndex(from)
	if err != nil {
		return err
	}
	last, err := monthIndex(to)
	if err != nil {
		return err
	}
	if span := last - first + 1; span < 1 || span > maxMonths {
		return apperror.ErrInvalidRequest
	}
	return nil
}
