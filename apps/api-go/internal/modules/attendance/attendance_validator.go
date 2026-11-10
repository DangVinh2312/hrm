package attendance

import (
	"encoding/json/v2"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/modules/attendancecore"
	"hrm/api-go/internal/modules/hrbase"
)

const (
	// maxAdjustmentMinutes is one day either way, the bound of the attendance_adjustment CHECK.
	maxAdjustmentMinutes  = 1440
	adjustmentReasonLimit = 300
	reopenReasonLimit     = 1000
)

var (
	dateGrammar    = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	integerGrammar = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,18})$`)
	// referenceGrammar names a source document (`QĐ-2026/11`), not free text: any script's letters and digits,
	// then also ` . _ / # : -`, at most 64 code points.
	referenceGrammar = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} ._/#:-]{0,63}$`)
)

// wholeNumber is a JSON integer read from its text, so 1.0, 1e0, "1" and null are refused.
type wholeNumber struct {
	Present bool
	Value   int
}

func (n *wholeNumber) UnmarshalJSON(raw []byte) error {
	if !integerGrammar.Match(raw) {
		return apperror.ErrInvalidRequest
	}
	value, err := strconv.Atoi(string(raw))
	if err != nil {
		return apperror.ErrInvalidRequest
	}
	n.Present, n.Value = true, value
	return nil
}

// optionalText is a member that may be omitted but, when sent, is a string: null is refused.
type optionalText struct {
	Present bool
	Value   string
}

func (o *optionalText) UnmarshalJSON(raw []byte) error {
	if len(raw) == 0 || raw[0] != '"' {
		return apperror.ErrInvalidRequest
	}
	o.Present = true
	return json.Unmarshal(raw, &o.Value)
}

type reopenBody struct {
	Reason *string `json:"reason"`
}

// adjustmentBody is exactly workDate, minutes, reason and an optional reference: the employee comes from the
// path only, the actor from the session.
type adjustmentBody struct {
	WorkDate  *string      `json:"workDate"`
	Minutes   wholeNumber  `json:"minutes"`
	Reason    *string      `json:"reason"`
	Reference optionalText `json:"reference"`
}

func parseMonth(value string) (string, error) {
	if _, err := attendancecore.ParseMonth(value); err != nil {
		return "", apperror.ErrInvalidRequest
	}
	return value, nil
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

func requiredText(value *string, limit int) (string, error) {
	if value == nil {
		return "", apperror.ErrInvalidRequest
	}
	return httpapi.InputText(*value, limit)
}

// parseSheetQuery is `…/employees/:id/attendance[?month=YYYY-MM]`; nothing else is accepted.
func parseSheetQuery(id, rawQuery string) (SheetQuery, error) {
	employeeID, err := httpapi.InputUUID(id)
	if err != nil {
		return SheetQuery{}, err
	}
	if query, err := url.ParseQuery(rawQuery); err == nil && len(query) == 0 {
		return SheetQuery{EmployeeID: employeeID}, nil
	}
	query, err := httpapi.InputQuery(rawQuery, "month")
	if err != nil {
		return SheetQuery{}, err
	}
	month, err := parseMonth(query["month"])
	if err != nil {
		return SheetQuery{}, err
	}
	return SheetQuery{EmployeeID: employeeID, Month: &month}, nil
}

func parseReopen(month string, body reopenBody) (ReopenInput, error) {
	var input ReopenInput
	var err error
	if input.Month, err = parseMonth(month); err != nil {
		return ReopenInput{}, err
	}
	if input.Reason, err = requiredText(body.Reason, reopenReasonLimit); err != nil {
		return ReopenInput{}, err
	}
	return input, nil
}

// parseAdjustment is the path id, the Idempotency-Key header values and the body of one adjustment. The
// reference is not trimmed: its grammar refuses a leading space and keeps a trailing one.
func parseAdjustment(id string, keys []string, body adjustmentBody) (AdjustmentInput, error) {
	var input AdjustmentInput
	var err error
	if input.EmployeeID, err = httpapi.InputUUID(id); err != nil {
		return AdjustmentInput{}, err
	}
	if input.IdempotencyKey, err = hrbase.ParseIdempotencyKey(keys); err != nil {
		return AdjustmentInput{}, err
	}
	if input.WorkDate, err = parseDate(body.WorkDate); err != nil {
		return AdjustmentInput{}, err
	}
	minutes := body.Minutes.Value
	if !body.Minutes.Present || minutes == 0 || minutes < -maxAdjustmentMinutes || minutes > maxAdjustmentMinutes {
		return AdjustmentInput{}, apperror.ErrInvalidRequest
	}
	input.Minutes = minutes
	if input.Reason, err = requiredText(body.Reason, adjustmentReasonLimit); err != nil {
		return AdjustmentInput{}, err
	}
	if body.Reference.Present {
		if !referenceGrammar.MatchString(body.Reference.Value) {
			return AdjustmentInput{}, apperror.ErrInvalidRequest
		}
		reference := body.Reference.Value
		input.Reference = &reference
	}
	return input, nil
}

// parseAdjustmentQuery is `…/employees/:id/attendance-adjustments?month=YYYY-MM[&limit=&offset=]`.
func parseAdjustmentQuery(id, rawQuery string) (AdjustmentQuery, error) {
	employeeID, err := httpapi.InputUUID(id)
	if err != nil {
		return AdjustmentQuery{}, err
	}
	page, err := httpapi.InputPageQuery(rawQuery, "month")
	if err != nil {
		return AdjustmentQuery{}, err
	}
	text, ok := page.Extra["month"]
	if !ok {
		return AdjustmentQuery{}, apperror.ErrInvalidRequest
	}
	month, err := parseMonth(text)
	if err != nil {
		return AdjustmentQuery{}, err
	}
	return AdjustmentQuery{EmployeeID: employeeID, Month: month, Limit: page.Limit, Offset: page.Offset}, nil
}
