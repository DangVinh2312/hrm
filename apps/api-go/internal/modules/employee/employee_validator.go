package employee

import (
	"encoding/json/v2"
	"regexp"
	"strconv"
	"strings"
	"time"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/httpapi"
)

var (
	codeGrammar      = regexp.MustCompile(`^[A-Za-z0-9._-]{1,32}$`)
	dateGrammar      = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	integerGrammar   = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)
	errInvalidFields = apperror.ErrInvalidRequest
)

// nullable keeps "member absent" apart from "member null": every F2 and F1 member must be present.
type nullable[T any] struct {
	Present bool
	Value   *T
}

func (n *nullable[T]) UnmarshalJSON(raw []byte) error {
	n.Present = true
	return json.Unmarshal(raw, &n.Value)
}

// minutesField is a JSON integer read from its text, never through float64: 5760.0 and 5.76e3 are refused.
type minutesField struct {
	Present bool
	Value   int64
}

func (m *minutesField) UnmarshalJSON(raw []byte) error {
	if !integerGrammar.Match(raw) {
		return errInvalidFields
	}
	value, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil {
		return errInvalidFields
	}
	m.Present, m.Value = true, value
	return nil
}

type profileBody struct {
	Position       nullable[string] `json:"position"`
	Classification nullable[string] `json:"classification"`
}

type createBody struct {
	Code               string        `json:"code"`
	FullName           string        `json:"fullName"`
	HiredOn            string        `json:"hiredOn"`
	Status             string        `json:"status"`
	AnnualLeaveMinutes minutesField  `json:"annualLeaveMinutes"`
	Identity           *identityBody `json:"identity"`
	profileBody
}

type updateBody struct {
	ExpectedVersion string `json:"expectedVersion"`
	Code            string `json:"code"`
	FullName        string `json:"fullName"`
	profileBody
}

type officialBody struct {
	EffectiveOn string `json:"effectiveOn"`
}

type terminationBody struct {
	TerminatedOn string `json:"terminatedOn"`
}

type identityUpdateBody struct {
	ExpectedVersion string        `json:"expectedVersion"`
	Identity        *identityBody `json:"identity"`
}

type leaveRateBody struct {
	EffectiveFrom string       `json:"effectiveFrom"`
	AnnualMinutes minutesField `json:"annualMinutes"`
}

type accountLinkBody struct {
	ExpectedVersion string           `json:"expectedVersion"`
	AccountID       nullable[string] `json:"accountId"`
}

func isScriptSpace(r rune) bool {
	switch r {
	case 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func parseCode(value string) (string, error) {
	if !codeGrammar.MatchString(value) {
		return "", errInvalidFields
	}
	return value, nil
}

// parseDate is a business date YYYY-MM-DD of the calendar between 1900 and 2100; the grammar alone does not
// prove that 2026-02-30 or 2100-02-29 exist.
func parseDate(value string) (string, error) {
	if !dateGrammar.MatchString(value) {
		return "", errInvalidFields
	}
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil || parsed.Year() < 1900 || parsed.Year() > 2100 {
		return "", errInvalidFields
	}
	return value, nil
}

func parseMinutes(value int64) (int, error) {
	if value < minAnnualMinutes || value > maxAnnualMinutes {
		return 0, errInvalidFields
	}
	return int(value), nil
}

func parseOptional[T any](field nullable[string], parse func(string) (T, error)) (*T, error) {
	if !field.Present {
		return nil, errInvalidFields
	}
	if field.Value == nil {
		return nil, nil
	}
	parsed, err := parse(*field.Value)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func parseClassification(value string) (Classification, error) {
	switch classification := Classification(value); classification {
	case ClassificationFullTime, ClassificationContractor:
		return classification, nil
	default:
		return "", errInvalidFields
	}
}

func parseStatus(value string) (Status, error) {
	switch status := Status(value); status {
	case StatusProbation, StatusOfficial:
		return status, nil
	default:
		return "", errInvalidFields
	}
}

func parsePosition(value string) (string, error) { return httpapi.InputText(value, 100) }

func parseProfile(body profileBody) (Profile, error) {
	position, err := parseOptional(body.Position, parsePosition)
	if err != nil {
		return Profile{}, err
	}
	classification, err := parseOptional(body.Classification, parseClassification)
	return Profile{Position: position, Classification: classification}, err
}

// parseCreateRate: probation has no leave rate and refuses the member; an official hire may give one
// (bounded) and otherwise takes the default setting in force when the row is written.
func parseCreateRate(status Status, field minutesField) (*LeaveMinutes, error) {
	if status == StatusProbation {
		if field.Present {
			return nil, errInvalidFields
		}
		return nil, nil
	}
	if !field.Present {
		return &LeaveMinutes{Default: true}, nil
	}
	minutes, err := parseMinutes(field.Value)
	return &LeaveMinutes{Minutes: minutes}, err
}

func parseCreate(body createBody) (CreateInput, error) {
	var input CreateInput
	var err error
	if input.Status, err = parseStatus(body.Status); err != nil {
		return CreateInput{}, err
	}
	if input.Code, err = parseCode(body.Code); err != nil {
		return CreateInput{}, err
	}
	if input.FullName, err = httpapi.InputText(body.FullName, 200); err != nil {
		return CreateInput{}, err
	}
	if input.HiredOn, err = parseDate(body.HiredOn); err != nil {
		return CreateInput{}, err
	}
	if input.AnnualLeave, err = parseCreateRate(input.Status, body.AnnualLeaveMinutes); err != nil {
		return CreateInput{}, err
	}
	if input.Identity, err = parseIdentity(body.Identity); err != nil {
		return CreateInput{}, err
	}
	input.Profile, err = parseProfile(body.profileBody)
	return input, err
}

func parseUpdate(employeeID string, body updateBody) (UpdateInput, error) {
	input := UpdateInput{}
	var err error
	if input.EmployeeID, err = httpapi.InputUUID(employeeID); err != nil {
		return UpdateInput{}, err
	}
	if input.ExpectedVersion, err = httpapi.InputVersion(body.ExpectedVersion); err != nil {
		return UpdateInput{}, err
	}
	if input.Code, err = parseCode(body.Code); err != nil {
		return UpdateInput{}, err
	}
	if input.FullName, err = httpapi.InputText(body.FullName, 200); err != nil {
		return UpdateInput{}, err
	}
	input.Profile, err = parseProfile(body.profileBody)
	return input, err
}

func parseOfficial(employeeID string, body officialBody) (OfficialInput, error) {
	id, err := httpapi.InputUUID(employeeID)
	if err != nil {
		return OfficialInput{}, err
	}
	on, err := parseDate(body.EffectiveOn)
	return OfficialInput{EmployeeID: id, EffectiveOn: on}, err
}

func parseTermination(employeeID string, body terminationBody) (TerminationInput, error) {
	id, err := httpapi.InputUUID(employeeID)
	if err != nil {
		return TerminationInput{}, err
	}
	on, err := parseDate(body.TerminatedOn)
	return TerminationInput{EmployeeID: id, TerminatedOn: on}, err
}

func parseIdentityUpdate(employeeID string, body identityUpdateBody) (IdentityUpdateInput, error) {
	input := IdentityUpdateInput{}
	var err error
	if input.EmployeeID, err = httpapi.InputUUID(employeeID); err != nil {
		return IdentityUpdateInput{}, err
	}
	if input.ExpectedVersion, err = httpapi.InputVersion(body.ExpectedVersion); err != nil {
		return IdentityUpdateInput{}, err
	}
	input.Identity, err = parseIdentity(body.Identity)
	return input, err
}

func parseLeaveRate(employeeID string, body leaveRateBody) (LeaveRateInput, error) {
	input := LeaveRateInput{}
	var err error
	if input.EmployeeID, err = httpapi.InputUUID(employeeID); err != nil {
		return LeaveRateInput{}, err
	}
	if input.EffectiveFrom, err = parseDate(body.EffectiveFrom); err != nil {
		return LeaveRateInput{}, err
	}
	if !body.AnnualMinutes.Present {
		return LeaveRateInput{}, errInvalidFields
	}
	input.AnnualMinutes, err = parseMinutes(body.AnnualMinutes.Value)
	return input, err
}

func parseAccountLink(employeeID string, body accountLinkBody) (AccountLinkInput, error) {
	input := AccountLinkInput{}
	var err error
	if input.EmployeeID, err = httpapi.InputUUID(employeeID); err != nil {
		return AccountLinkInput{}, err
	}
	if input.ExpectedVersion, err = httpapi.InputVersion(body.ExpectedVersion); err != nil {
		return AccountLinkInput{}, err
	}
	input.AccountID, err = parseOptional(body.AccountID, httpapi.InputUUID)
	return input, err
}

// parseList is ?limit=&offset=&search= only; a search of nothing but whitespace is no filter.
func parseList(rawQuery string) (ListQuery, error) {
	page, err := httpapi.InputPageQuery(rawQuery, "search")
	if err != nil {
		return ListQuery{}, err
	}
	query := ListQuery{Limit: page.Limit, Offset: page.Offset}
	if search := page.Extra["search"]; strings.TrimFunc(search, isScriptSpace) != "" {
		query.Search, err = httpapi.InputText(search, 100)
	}
	return query, err
}
