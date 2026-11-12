package workcalendar

import (
	"encoding/json/v2"
	"regexp"
	"strconv"

	"hrm/api/internal/apperror"
	"hrm/api/internal/httpapi"
	"hrm/api/internal/modules/schedulecore"
)

const nameLimit = 200

var (
	yearGrammar    = regexp.MustCompile(`^[0-9]{4}$`)
	integerGrammar = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,18})$`)
)

// present tells a member set to null from a missing one; Value is nil for null.
type present[T any] struct {
	Present bool
	Value   *T
}

func (p *present[T]) UnmarshalJSON(raw []byte) error {
	p.Present = true
	return json.Unmarshal(raw, &p.Value, json.RejectUnknownMembers(true))
}

// wholeNumber is a JSON integer read from its text, so 1.0, 1e0, "1" and null are refused.
type wholeNumber struct {
	Present bool
	Value   int64
}

func (n *wholeNumber) UnmarshalJSON(raw []byte) error {
	if !integerGrammar.Match(raw) {
		return apperror.ErrInvalidRequest
	}
	value, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil {
		return apperror.ErrInvalidRequest
	}
	n.Present, n.Value = true, value
	return nil
}

type makeupBody struct {
	AsWeekday   wholeNumber `json:"asWeekday"`
	FrameSource string      `json:"frameSource"`
}

// dayBody is {expectedVersion, holiday} or {expectedVersion, makeup}; parseDay refuses both and neither.
type dayBody struct {
	ExpectedVersion string              `json:"expectedVersion"`
	Holiday         present[string]     `json:"holiday"`
	Makeup          present[makeupBody] `json:"makeup"`
}

type holidaysBody struct {
	ExpectedVersion string `json:"expectedVersion"`
	From            string `json:"from"`
	To              string `json:"to"`
	Name            string `json:"name"`
}

// parseYear is ?year=YYYY only, 1900..2100 (the business date range).
func parseYear(rawQuery string) (int, error) {
	query, err := httpapi.InputQuery(rawQuery, "year")
	if err != nil {
		return 0, err
	}
	if !yearGrammar.MatchString(query["year"]) {
		return 0, apperror.ErrInvalidRequest
	}
	year, err := strconv.Atoi(query["year"])
	if err != nil || year < 1900 || year > 2100 {
		return 0, apperror.ErrInvalidRequest
	}
	return year, nil
}

func parseDate(value string) (string, error) {
	if _, err := schedulecore.ParseDate(value); err != nil {
		return "", apperror.ErrInvalidRequest
	}
	return value, nil
}

func parseMakeup(body *makeupBody) (*MakeupHours, error) {
	if body == nil {
		return nil, nil
	}
	source := schedulecore.FrameSource(body.FrameSource)
	if !body.AsWeekday.Present || body.AsWeekday.Value < 1 || body.AsWeekday.Value > 7 ||
		(source != schedulecore.FrameSourceCompany && source != schedulecore.FrameSourceEmployee) {
		return nil, apperror.ErrInvalidRequest
	}
	return &MakeupHours{AsWeekday: int(body.AsWeekday.Value), FrameSource: source}, nil
}

// parseDay checks the shape only. Whether the day is off in the company schedule, as a makeup day needs,
// is the command's check (it reads the schedule).
func parseDay(date string, body dayBody) (DayInput, error) {
	day, err := parseDate(date)
	if err != nil {
		return DayInput{}, err
	}
	version, err := httpapi.InputVersion(body.ExpectedVersion)
	if err != nil {
		return DayInput{}, err
	}
	input := DayInput{ExpectedVersion: version, Date: day}
	switch {
	case body.Makeup.Present && !body.Holiday.Present:
		input.IsMakeup = true
		input.Makeup, err = parseMakeup(body.Makeup.Value)
		return input, err
	case body.Holiday.Present && !body.Makeup.Present:
		if body.Holiday.Value == nil {
			return input, nil
		}
		name, err := httpapi.InputText(*body.Holiday.Value, nameLimit)
		input.Holiday = &name
		return input, err
	}
	return DayInput{}, apperror.ErrInvalidRequest
}

// parseHolidays is from <= to, at most MaxHolidayRangeDays calendar days.
func parseHolidays(body holidaysBody) (HolidaysInput, error) {
	version, err := httpapi.InputVersion(body.ExpectedVersion)
	if err != nil {
		return HolidaysInput{}, err
	}
	from, err := parseDate(body.From)
	if err != nil {
		return HolidaysInput{}, err
	}
	to, err := parseDate(body.To)
	if err != nil {
		return HolidaysInput{}, err
	}
	name, err := httpapi.InputText(body.Name, nameLimit)
	if err != nil {
		return HolidaysInput{}, err
	}
	if len(schedulecore.DatesBetween(from, to, schedulecore.MaxHolidayRangeDays)) == 0 {
		return HolidaysInput{}, apperror.ErrInvalidRequest
	}
	return HolidaysInput{ExpectedVersion: version, From: from, To: to, Name: name}, nil
}
