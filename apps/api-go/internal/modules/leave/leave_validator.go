package leave

import (
	"net/url"
	"regexp"
	"strconv"
	"time"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/modules/hrbase"
)

const (
	// maxAdjustmentMinutes is the ledger CHECK ck_leave_ledger_shape bound for opening/adjustment entries.
	maxAdjustmentMinutes = 175680
	referenceLimit       = 200
)

var (
	dateGrammar    = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	yearGrammar    = regexp.MustCompile(`^[0-9]{4}$`)
	integerGrammar = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,18})$`)
)

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

// adjustmentBody is exactly minutes, effectiveOn and reference: the entry kind is always `adjustment`
// and the employee comes from the path only.
type adjustmentBody struct {
	Minutes     wholeNumber `json:"minutes"`
	EffectiveOn string      `json:"effectiveOn"`
	Reference   string      `json:"reference"`
}

// parseDate is a business date YYYY-MM-DD between 1900 and 2100 that exists on the calendar.
func parseDate(value string) (string, error) {
	if !dateGrammar.MatchString(value) {
		return "", apperror.ErrInvalidRequest
	}
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil || parsed.Year() < 1900 || parsed.Year() > 2100 {
		return "", apperror.ErrInvalidRequest
	}
	return value, nil
}

// parseBalanceQuery is `…/employees/:id/leave-balance[?date=YYYY-MM-DD]`; nothing else is accepted.
func parseBalanceQuery(id, rawQuery string) (BalanceQuery, error) {
	employeeID, err := httpapi.InputUUID(id)
	if err != nil {
		return BalanceQuery{}, err
	}
	if query, err := url.ParseQuery(rawQuery); err == nil && len(query) == 0 {
		return BalanceQuery{EmployeeID: employeeID}, nil
	}
	query, err := httpapi.InputQuery(rawQuery, "date")
	if err != nil {
		return BalanceQuery{}, err
	}
	date, err := parseDate(query["date"])
	if err != nil {
		return BalanceQuery{}, err
	}
	return BalanceQuery{EmployeeID: employeeID, AsOn: &date}, nil
}

// parseReconciliationQuery is `[?year=YYYY&limit=&offset=]`, page budgets as everywhere.
func parseReconciliationQuery(rawQuery string) (ReconciliationQuery, error) {
	page, err := httpapi.InputPageQuery(rawQuery, "year")
	if err != nil {
		return ReconciliationQuery{}, err
	}
	query := ReconciliationQuery{Limit: page.Limit, Offset: page.Offset}
	text, ok := page.Extra["year"]
	if !ok {
		return query, nil
	}
	if !yearGrammar.MatchString(text) {
		return ReconciliationQuery{}, apperror.ErrInvalidRequest
	}
	year, err := strconv.Atoi(text)
	if err != nil || year < 1900 || year > 2100 {
		return ReconciliationQuery{}, apperror.ErrInvalidRequest
	}
	query.Year = &year
	return query, nil
}

// parseAdjustment is the path id, the Idempotency-Key header values and the body of one adjustment.
func parseAdjustment(id string, keys []string, body adjustmentBody) (AdjustmentInput, error) {
	var input AdjustmentInput
	var err error
	if input.EmployeeID, err = httpapi.InputUUID(id); err != nil {
		return AdjustmentInput{}, err
	}
	if input.IdempotencyKey, err = hrbase.ParseIdempotencyKey(keys); err != nil {
		return AdjustmentInput{}, err
	}
	minutes := body.Minutes.Value
	if !body.Minutes.Present || minutes == 0 || minutes < -maxAdjustmentMinutes || minutes > maxAdjustmentMinutes {
		return AdjustmentInput{}, apperror.ErrInvalidRequest
	}
	input.Minutes = int(minutes)
	if input.EffectiveOn, err = parseDate(body.EffectiveOn); err != nil {
		return AdjustmentInput{}, err
	}
	if input.Reference, err = httpapi.InputText(body.Reference, referenceLimit); err != nil {
		return AdjustmentInput{}, err
	}
	return input, nil
}
