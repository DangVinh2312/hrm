package workrequest

import (
	"cmp"
	"encoding/json/v2"
	"regexp"
	"slices"
	"strconv"
	"time"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/modules/hrbase"
)

const (
	// maxDays is the ceiling hr.requestMaxDays can only lower; the submit checks the value in force.
	maxDays     = 31
	reasonLimit = 1000
	dayMinutes  = 1440
)

var (
	dateGrammar    = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
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

// minute is a JSON integer read from its text, so 1.0, 6e2, "600" and null are refused.
type minute struct {
	Present bool
	Value   int
}

func (m *minute) UnmarshalJSON(raw []byte) error {
	if !integerGrammar.Match(raw) {
		return apperror.ErrInvalidRequest
	}
	value, err := strconv.Atoi(string(raw))
	if err != nil {
		return apperror.ErrInvalidRequest
	}
	m.Present, m.Value = true, value
	return nil
}

type slotBody struct {
	Date        *string `json:"date"`
	StartMinute minute  `json:"startMinute"`
	EndMinute   minute  `json:"endMinute"`
}

// submitBody holds the members of every kind; a member of another kind is refused even when null, since
// it is an unknown key of that kind. Employee, owner, state and version are never accepted.
type submitBody struct {
	Kind           *string             `json:"kind"`
	TeamID         *string             `json:"teamId"`
	Reason         *string             `json:"reason"`
	Date           present[string]     `json:"date"`
	ExpectedMinute minute              `json:"expectedMinute"`
	Dates          present[[]string]   `json:"dates"`
	Segments       present[[]slotBody] `json:"segments"`
}

// parseDate is a business date YYYY-MM-DD between 1900 and 2100 that exists on the calendar.
func parseDate(value *string) (string, error) {
	if value == nil || !dateGrammar.MatchString(*value) {
		return "", apperror.ErrInvalidRequest
	}
	parsed, err := time.Parse(time.DateOnly, *value)
	if err != nil || parsed.Year() < 1900 || parsed.Year() > 2100 {
		return "", apperror.ErrInvalidRequest
	}
	return *value, nil
}

func parseMinute(m minute) (int, error) {
	if !m.Present || m.Value < 0 || m.Value > dayMinutes {
		return 0, apperror.ErrInvalidRequest
	}
	return m.Value, nil
}

// days is 1..31 entries sorted by date, one per date; one calendar year is the helper's rule.
func days[B, T any](items *[]B, parse func(B) (T, error), dateOf func(T) string) ([]T, error) {
	if items == nil || len(*items) < 1 || len(*items) > maxDays {
		return nil, apperror.ErrInvalidRequest
	}
	parsed := make([]T, 0, len(*items))
	for _, item := range *items {
		value, err := parse(item)
		if err != nil {
			return nil, err
		}
		parsed = append(parsed, value)
	}
	slices.SortFunc(parsed, func(a, b T) int { return cmp.Compare(dateOf(a), dateOf(b)) })
	for i := 1; i < len(parsed); i++ {
		if dateOf(parsed[i]) == dateOf(parsed[i-1]) {
			return nil, apperror.ErrInvalidRequest
		}
	}
	return parsed, nil
}

func parseSlot(body slotBody) (Slot, error) {
	date, err := parseDate(body.Date)
	if err != nil {
		return Slot{}, err
	}
	start, err := parseMinute(body.StartMinute)
	if err != nil {
		return Slot{}, err
	}
	end, err := parseMinute(body.EndMinute)
	if err != nil {
		return Slot{}, err
	}
	return Slot{Date: date, StartMinute: start, EndMinute: end}, nil
}

// ownMembers checks that exactly the members of kind are present, besides kind, reason and teamId.
func ownMembers(kind hrbase.RequestKind, body submitBody) bool {
	timed := body.Date.Present || body.ExpectedMinute.Present
	switch kind {
	case hrbase.RequestLateArrival, hrbase.RequestEarlyDeparture:
		return body.Date.Present && body.ExpectedMinute.Present && !body.Dates.Present && !body.Segments.Present
	case hrbase.RequestWfh:
		return body.Dates.Present && !timed && !body.Segments.Present
	case hrbase.RequestAnnualLeave, hrbase.RequestUnpaidLeave:
		return body.Segments.Present && !timed && !body.Dates.Present
	}
	return false
}

// parseSubmit is the Idempotency-Key header values and the body of POST /api/hr/requests.
func parseSubmit(keys []string, body submitBody) (SubmitInput, error) {
	var input SubmitInput
	var err error
	if input.IdempotencyKey, err = hrbase.ParseIdempotencyKey(keys); err != nil {
		return SubmitInput{}, err
	}
	if body.Kind == nil || !ownMembers(hrbase.RequestKind(*body.Kind), body) || body.Reason == nil {
		return SubmitInput{}, apperror.ErrInvalidRequest
	}
	input.Kind = hrbase.RequestKind(*body.Kind)
	if body.TeamID != nil {
		team, err := httpapi.InputUUID(*body.TeamID)
		if err != nil {
			return SubmitInput{}, err
		}
		input.TeamID = &team
	}
	if input.Reason, err = httpapi.InputText(*body.Reason, reasonLimit); err != nil {
		return SubmitInput{}, err
	}
	switch input.Kind {
	case hrbase.RequestLateArrival, hrbase.RequestEarlyDeparture:
		if input.Date, err = parseDate(body.Date.Value); err != nil {
			return SubmitInput{}, err
		}
		input.ExpectedMinute, err = parseMinute(body.ExpectedMinute)
	case hrbase.RequestWfh:
		input.Dates, err = days(body.Dates.Value, func(date string) (string, error) { return parseDate(&date) }, func(date string) string { return date })
	case hrbase.RequestAnnualLeave, hrbase.RequestUnpaidLeave:
		input.Segments, err = days(body.Segments.Value, parseSlot, func(slot Slot) string { return slot.Date })
	}
	if err != nil {
		return SubmitInput{}, err
	}
	return input, nil
}

// decisionBody is exactly expectedVersion, decision, reason and acknowledgeWfhLimit; stage, actor or state are
// never accepted. The acknowledgement is optional but never null.
type decisionBody struct {
	ExpectedVersion     *string       `json:"expectedVersion"`
	Decision            *string       `json:"decision"`
	Reason              *string       `json:"reason"`
	AcknowledgeWfhLimit present[bool] `json:"acknowledgeWfhLimit"`
}

// parseDecision is the path id, the Idempotency-Key header values and the body of a decision. A reject needs
// its reason; an approval note is optional.
func parseDecision(id string, keys []string, body decisionBody) (DecisionInput, error) {
	var input DecisionInput
	var err error
	if input.RequestID, err = httpapi.InputUUID(id); err != nil {
		return DecisionInput{}, err
	}
	if input.IdempotencyKey, err = hrbase.ParseIdempotencyKey(keys); err != nil {
		return DecisionInput{}, err
	}
	if body.Decision == nil || (*body.Decision != decisionApprove && *body.Decision != decisionReject) || body.ExpectedVersion == nil {
		return DecisionInput{}, apperror.ErrInvalidRequest
	}
	input.Decision = *body.Decision
	if input.ExpectedVersion, err = httpapi.InputVersion(*body.ExpectedVersion); err != nil {
		return DecisionInput{}, err
	}
	if body.Reason != nil || input.Decision == decisionReject {
		if body.Reason == nil {
			return DecisionInput{}, apperror.ErrInvalidRequest
		}
		reason, err := httpapi.InputText(*body.Reason, reasonLimit)
		if err != nil {
			return DecisionInput{}, err
		}
		input.Reason = &reason
	}
	if body.AcknowledgeWfhLimit.Present {
		if input.AcknowledgeWfhLimit, err = httpapi.InputBoolean(body.AcknowledgeWfhLimit.Value); err != nil {
			return DecisionInput{}, err
		}
	}
	return input, nil
}

// cancelBody is exactly expectedVersion and an optional reason; state, stage and actor are never accepted.
type cancelBody struct {
	ExpectedVersion *string `json:"expectedVersion"`
	Reason          *string `json:"reason"`
}

// parseCancel is the path id, the Idempotency-Key header values and the body of a cancellation.
func parseCancel(id string, keys []string, body cancelBody) (CancelInput, error) {
	var input CancelInput
	var err error
	if input.RequestID, err = httpapi.InputUUID(id); err != nil {
		return CancelInput{}, err
	}
	if input.IdempotencyKey, err = hrbase.ParseIdempotencyKey(keys); err != nil {
		return CancelInput{}, err
	}
	if body.ExpectedVersion == nil {
		return CancelInput{}, apperror.ErrInvalidRequest
	}
	if input.ExpectedVersion, err = httpapi.InputVersion(*body.ExpectedVersion); err != nil {
		return CancelInput{}, err
	}
	if body.Reason != nil {
		reason, err := httpapi.InputText(*body.Reason, reasonLimit)
		if err != nil {
			return CancelInput{}, err
		}
		input.Reason = &reason
	}
	return input, nil
}

// parseRequestList is `[?limit=&offset=]` only.
func parseRequestList(rawQuery string) (ListQuery, error) {
	page, err := httpapi.InputPageQuery(rawQuery)
	if err != nil {
		return ListQuery{}, err
	}
	return ListQuery{Limit: page.Limit, Offset: page.Offset}, nil
}
