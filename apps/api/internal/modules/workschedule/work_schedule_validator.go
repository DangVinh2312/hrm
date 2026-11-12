package workschedule

import (
	"encoding/json/v2"
	"regexp"
	"strconv"

	"hrm/api/internal/apperror"
	"hrm/api/internal/httpapi"
	"hrm/api/internal/modules/schedulecore"
)

const maxScheduleRangeDays = 92

var minuteGrammar = regexp.MustCompile(`^(0|[1-9][0-9]{0,3})$`)

// minute is a JSON integer 0..1440 read from its text, so 540.0, 5.4e2, "540" and null are refused.
type minute int

func (m *minute) UnmarshalJSON(raw []byte) error {
	if !minuteGrammar.Match(raw) {
		return apperror.ErrInvalidRequest
	}
	value, err := strconv.Atoi(string(raw))
	if err != nil || value > 1440 {
		return apperror.ErrInvalidRequest
	}
	*m = minute(value)
	return nil
}

// shiftBody, frameBody and weekBody refuse null themselves: a null list would otherwise read as empty,
// which for a frame is a day off.
type shiftBody []minute

func (s *shiftBody) UnmarshalJSON(raw []byte) error {
	return decodeList(raw, (*[]minute)(s), 2, 2)
}

type frameBody []shiftBody

func (f *frameBody) UnmarshalJSON(raw []byte) error {
	return decodeList(raw, (*[]shiftBody)(f), 0, schedulecore.MaxShifts)
}

type weekBody []frameBody

func (w *weekBody) UnmarshalJSON(raw []byte) error {
	return decodeList(raw, (*[]frameBody)(w), 7, 7)
}

func decodeList[T any](raw []byte, list *[]T, least, most int) error {
	if string(raw) == "null" {
		return apperror.ErrInvalidRequest
	}
	if err := json.Unmarshal(raw, list, json.RejectUnknownMembers(true)); err != nil {
		return apperror.ErrInvalidRequest
	}
	if len(*list) < least || len(*list) > most {
		return apperror.ErrInvalidRequest
	}
	return nil
}

// present tells a member set to null from a missing one; Value is nil for null.
type present[T any] struct {
	Present bool
	Value   *T
}

func (p *present[T]) UnmarshalJSON(raw []byte) error {
	p.Present = true
	return json.Unmarshal(raw, &p.Value, json.RejectUnknownMembers(true))
}

type companyScheduleBody struct {
	Days weekBody `json:"days"`
}

type employeeFrameBody struct {
	ValidFrom string          `json:"validFrom"`
	ValidTo   present[string] `json:"validTo"`
	Days      weekBody        `json:"days"`
}

// parseWeek checks the shape only: seven lists of at most three [start, end] minute pairs. Order, step,
// overlap and the daily total depend on hr.workdayMaxMinutes, so the command checks them.
func parseWeek(days weekBody) ([]schedulecore.Frame, error) {
	if len(days) != 7 {
		return nil, apperror.ErrInvalidRequest
	}
	week := make([]schedulecore.Frame, len(days))
	for i, frame := range days {
		week[i] = make(schedulecore.Frame, len(frame))
		for j, shift := range frame {
			week[i][j] = schedulecore.Shift{int(shift[0]), int(shift[1])}
		}
	}
	return week, nil
}

func parseDate(value string) (string, error) {
	if _, err := schedulecore.ParseDate(value); err != nil {
		return "", apperror.ErrInvalidRequest
	}
	return value, nil
}

func parseCompanySchedule(effectiveFrom string, body companyScheduleBody) (CompanyScheduleInput, error) {
	date, err := parseDate(effectiveFrom)
	if err != nil {
		return CompanyScheduleInput{}, err
	}
	days, err := parseWeek(body.Days)
	if err != nil {
		return CompanyScheduleInput{}, err
	}
	return CompanyScheduleInput{EffectiveFrom: date, Days: days}, nil
}

func parseEmployeeFrame(employeeID string, body employeeFrameBody) (EmployeeFrameInput, error) {
	id, err := httpapi.InputUUID(employeeID)
	if err != nil {
		return EmployeeFrameInput{}, err
	}
	from, err := parseDate(body.ValidFrom)
	if err != nil {
		return EmployeeFrameInput{}, err
	}
	if !body.ValidTo.Present {
		return EmployeeFrameInput{}, apperror.ErrInvalidRequest
	}
	var to *string
	if body.ValidTo.Value != nil {
		date, err := parseDate(*body.ValidTo.Value)
		if err != nil || date < from {
			return EmployeeFrameInput{}, apperror.ErrInvalidRequest
		}
		to = &date
	}
	days, err := parseWeek(body.Days)
	if err != nil {
		return EmployeeFrameInput{}, err
	}
	return EmployeeFrameInput{EmployeeID: id, ValidFrom: from, ValidTo: to, Days: days}, nil
}

func parseFrameKey(employeeID, frameID string) (FrameKey, error) {
	employee, err := httpapi.InputUUID(employeeID)
	if err != nil {
		return FrameKey{}, err
	}
	frame, err := httpapi.InputUUID(frameID)
	if err != nil {
		return FrameKey{}, err
	}
	return FrameKey{EmployeeID: employee, FrameID: frame}, nil
}

// parseScheduleQuery is ?from&to, inclusive, at most maxScheduleRangeDays days.
func parseScheduleQuery(employeeID, rawQuery string) (ScheduleQuery, error) {
	id, err := httpapi.InputUUID(employeeID)
	if err != nil {
		return ScheduleQuery{}, err
	}
	query, err := httpapi.InputQuery(rawQuery, "from", "to")
	if err != nil {
		return ScheduleQuery{}, err
	}
	from, err := parseDate(query["from"])
	if err != nil {
		return ScheduleQuery{}, err
	}
	to, err := parseDate(query["to"])
	if err != nil || len(schedulecore.DatesBetween(from, to, maxScheduleRangeDays)) == 0 {
		return ScheduleQuery{}, apperror.ErrInvalidRequest
	}
	return ScheduleQuery{EmployeeID: id, From: from, To: to}, nil
}
