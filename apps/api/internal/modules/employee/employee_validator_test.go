package employee

import (
	"encoding/json/v2"
	"errors"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
)

var (
	bom              = string(rune(0xfeff))
	ideographicSpace = string(rune(0x3000))
)

const testID = "10000000-0000-4000-8000-000000000001"

func decodeBody[T any](body string) (T, error) {
	var decoded T
	if err := json.Unmarshal([]byte(body), &decoded, json.RejectUnknownMembers(true)); err != nil {
		var zero T
		return zero, apperror.ErrInvalidRequest
	}
	return decoded, nil
}

func identityJSON(overrides map[string]string) string {
	members := map[string]string{
		"dateOfBirth": "null", "documentKind": "null", "documentNumber": "null", "taxCode": "null",
		"gender": "null", "phone": "null", "workEmail": "null",
	}
	for key, value := range overrides {
		members[key] = value
	}
	parts := make([]string, 0, len(members))
	for key, value := range members {
		if value != "absent" {
			parts = append(parts, `"`+key+`":`+value)
		}
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func quoted(text string) string { return `"` + text + `"` }

func identityOf(t *testing.T, overrides map[string]string) (Identity, error) {
	t.Helper()
	body, err := decodeBody[identityBody](identityJSON(overrides))
	if err != nil {
		return Identity{}, err
	}
	return parseIdentity(&body)
}

func TestIdentityDocumentAndTaxCodeGrammar(t *testing.T) {
	kind := quoted("cccd")
	accepted := []map[string]string{
		{"documentKind": kind, "documentNumber": quoted("ABC123")},
		{"documentKind": kind, "documentNumber": quoted(strings.Repeat("A", 20))},
		{"documentKind": quoted("passport"), "documentNumber": quoted("B1234567")},
		{"taxCode": quoted("0123456789")},
		{"taxCode": quoted("0123456789012")},
		{"taxCode": quoted("0123456789-001")},
		{},
	}
	for _, overrides := range accepted {
		if _, err := identityOf(t, overrides); err != nil {
			t.Errorf("%v refused: %v", overrides, err)
		}
	}
	refused := []map[string]string{
		{"documentKind": kind, "documentNumber": quoted("ABC12")},
		{"documentKind": kind, "documentNumber": quoted(strings.Repeat("A", 21))},
		{"documentKind": kind, "documentNumber": quoted("abc123")},
		{"documentKind": kind, "documentNumber": quoted("ABC-123")},
		{"documentKind": kind, "documentNumber": quoted(`ABC123\n`)},
		{"documentKind": kind, "documentNumber": quoted(" ABC123")},
		{"documentKind": kind, "documentNumber": "123456"},
		{"documentKind": kind, "documentNumber": "null"},
		{"documentKind": "null", "documentNumber": quoted("ABC123")},
		{"documentKind": quoted("CCCD"), "documentNumber": quoted("ABC123")},
		{"documentKind": quoted("license"), "documentNumber": quoted("ABC123")},
		{"documentKind": quoted(""), "documentNumber": quoted("ABC123")},
		{"taxCode": quoted("012345678")},
		{"taxCode": quoted("01234567890123")},
		{"taxCode": quoted("0123456789-00")},
		{"taxCode": quoted("0123456789-0011")},
		{"taxCode": quoted("0123456789-")},
		{"taxCode": quoted("012345678A")},
		{"taxCode": quoted(`0123456789\n`)},
		{"taxCode": "123456789012"},
	}
	for _, overrides := range refused {
		if _, err := identityOf(t, overrides); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%v accepted", overrides)
		}
	}
}

func TestIdentityNeedsEveryMemberAndRefusesTheUnknown(t *testing.T) {
	for _, member := range []string{"dateOfBirth", "documentKind", "documentNumber", "taxCode", "gender", "phone", "workEmail"} {
		if _, err := identityOf(t, map[string]string{member: "absent"}); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("identity without %s accepted", member)
		}
	}
	if _, err := decodeBody[identityBody](`{"extra":1}`); err == nil {
		t.Error("unknown member decoded")
	}
	if _, err := parseIdentity(nil); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Error("nil identity accepted")
	}
	for _, overrides := range []map[string]string{{"gender": "7"}, {"phone": "912345678"}, {"workEmail": "true"}, {"dateOfBirth": "[]"}, {"gender": quoted("MALE")}, {"gender": quoted("x")}} {
		if _, err := identityOf(t, overrides); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%v accepted", overrides)
		}
	}
	if _, err := identityOf(t, map[string]string{"gender": quoted("female")}); err != nil {
		t.Errorf("gender refused: %v", err)
	}
}

func TestDateIsACalendarDay(t *testing.T) {
	accepted := []string{"2024-02-29", "1900-01-01", "2100-12-31", "2026-12-31", "2000-02-29"}
	for _, value := range accepted {
		if got, err := parseDate(value); err != nil || got != value {
			t.Errorf("%s refused: %v", value, err)
		}
	}
	fullWidth := string(rune(0xff12)) + "026-01-05"
	refused := []string{
		"2026-02-30", "2025-02-29", "2100-02-29", "1900-02-29", "1899-12-31", "2101-01-01", "2026-13-01", "2026-00-10",
		"2026-01-00", "2026-04-31", "2026-2-3", "26-02-03", "2026/02/03", "2026-02-03\n", " 2026-02-03", "2026-02-03T00:00:00Z",
		"20260203", "", "0000-01-01", fullWidth, "+2026-02-03", "2026-02-033",
	}
	for _, value := range refused {
		if _, err := parseDate(value); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%q accepted", value)
		}
	}
	if _, err := identityOf(t, map[string]string{"dateOfBirth": quoted("2026-02-30")}); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Error("impossible date of birth accepted")
	}
}

func TestPhoneIsCanonicalNationalDigits(t *testing.T) {
	accepted := map[string]string{
		"0912345678": "0912345678", "+84 912 345 678": "0912345678", "(091) 234-5678": "0912345678",
		"0912.345.678": "0912345678", "+84912345678": "0912345678", "09123456789": "09123456789",
	}
	for value, want := range accepted {
		if got, err := parsePhone(value); err != nil || got != want {
			t.Errorf("%q = %q, %v", value, got, err)
		}
	}
	for _, value := range []string{
		"84912345678", "0012345678", "091234567", "012345678901", "+85912345678", "091234567a", "", "+84", "+840912345678",
		"0 9 1 2 3 4 5 6 7 8\n", strings.Repeat(" ", 30) + "0912345678", "+1 650 555 0100",
	} {
		if _, err := parsePhone(value); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%q accepted", value)
		}
	}
}

func TestWorkEmailIsTrimmedLowercaseAscii(t *testing.T) {
	if got, err := parseWorkEmail("  " + bom + "A.B+c@Example.COM" + ideographicSpace); err != nil || got != "a.b+c@example.com" {
		t.Errorf("canonical = %q, %v", got, err)
	}
	kelvin := string(rune(0x212a))
	dotted := string(rune(0x130))
	long := strings.Repeat("a", 63)
	for _, value := range []string{
		"", "a", "a@b", "a@b.c", "a@@b.com", "a b@x.com", "a..b@x.com", ".a@x.com", "a.@x.com", "<a@x.com>", "Name <a@x.com>",
		"\"a\"@x.com", "a@[127.0.0.1]", "a@-x.com", "a@x-.com", "a@x.com1", "a@x.c0m", kelvin + "@x.com", dotted + "@x.com",
		"a@" + long + "a.com", strings.Repeat("a", 250) + "@x.com", strings.Repeat(" ", 301) + "a@x.com", "a@x.com\n b",
	} {
		if _, err := parseWorkEmail(value); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%q accepted", value)
		}
	}
	if _, err := parseWorkEmail("a@" + long + ".com"); err != nil {
		t.Errorf("63-character label refused: %v", err)
	}
}

func createOf(extra string) (CreateInput, error) {
	body, err := decodeBody[createBody](`{"code":"NV-01","fullName":"Nguyen An","hiredOn":"2026-01-05","status":"official",` +
		`"position":null,"classification":null,"identity":` + identityJSON(nil) + extra + `}`)
	if err != nil {
		return CreateInput{}, err
	}
	return parseCreate(body)
}

func TestCreateRate(t *testing.T) {
	got, err := createOf("")
	if err != nil || got.AnnualLeave == nil || !got.AnnualLeave.Default {
		t.Fatalf("official without rate = %+v, %v", got.AnnualLeave, err)
	}
	for _, minutes := range []string{"5760", "175680", "6000"} {
		got, err := createOf(`,"annualLeaveMinutes":` + minutes)
		if err != nil || got.AnnualLeave == nil || got.AnnualLeave.Default {
			t.Errorf("%s = %+v, %v", minutes, got.AnnualLeave, err)
		}
	}
	for _, minutes := range []string{"5759", "175681", "0", "-5760", "5760.0", "5.76e3", "6000.5", "null", `"5760"`, "true", "[5760]", "9223372036854775808", "1e400"} {
		if _, err := createOf(`,"annualLeaveMinutes":` + minutes); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s accepted", minutes)
		}
	}
	probation := func(extra string) (CreateInput, error) {
		body, err := decodeBody[createBody](`{"code":"NV-01","fullName":"An","hiredOn":"2026-01-05","status":"probation",` +
			`"position":null,"classification":null,"identity":` + identityJSON(nil) + extra + `}`)
		if err != nil {
			return CreateInput{}, err
		}
		return parseCreate(body)
	}
	if got, err := probation(""); err != nil || got.AnnualLeave != nil {
		t.Errorf("probation = %+v, %v", got.AnnualLeave, err)
	}
	for _, rate := range []string{`,"annualLeaveMinutes":5760`, `,"annualLeaveMinutes":null`, `,"annualLeaveMinutes":0`} {
		if _, err := probation(rate); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("probation with %s accepted", rate)
		}
	}
}

func TestCreateFields(t *testing.T) {
	base := func(code, name, hired, status string) string {
		return `{"code":` + code + `,"fullName":` + name + `,"hiredOn":` + hired + `,"status":` + status +
			`,"position":null,"classification":null,"identity":` + identityJSON(nil) + `}`
	}
	ok := base(`"NV-01"`, `"Nguyen An"`, `"2026-01-05"`, `"official"`)
	if _, err := parseCreateFrom(ok); err != nil {
		t.Fatalf("valid create refused: %v", err)
	}
	emoji := strings.Repeat("\U0001f600", 200)
	if got, err := parseCreateFrom(base(`"NV-01"`, quoted(bom+" "+emoji+" "+bom), `"2026-01-05"`, `"official"`)); err != nil || got.FullName != emoji {
		t.Errorf("200 code points with JS whitespace around = %v", err)
	}
	bad := []string{
		base(`""`, `"A"`, `"2026-01-05"`, `"official"`),
		base(quoted(strings.Repeat("A", 33)), `"A"`, `"2026-01-05"`, `"official"`),
		base(`"NV 01"`, `"A"`, `"2026-01-05"`, `"official"`),
		base(`"NV-01\n"`, `"A"`, `"2026-01-05"`, `"official"`),
		base(quoted("NV-"+string(rune(0xe9))), `"A"`, `"2026-01-05"`, `"official"`),
		base(`"NV-01"`, `""`, `"2026-01-05"`, `"official"`),
		base(`"NV-01"`, `"   "`, `"2026-01-05"`, `"official"`),
		base(`"NV-01"`, quoted(strings.Repeat("\U0001f600", 201)), `"2026-01-05"`, `"official"`),
		base(`"NV-01"`, `"a\u0000b"`, `"2026-01-05"`, `"official"`),
		base(`"NV-01"`, `"a\u007fb"`, `"2026-01-05"`, `"official"`),
		base(`"NV-01"`, `"A"`, `"2026-02-30"`, `"official"`),
		base(`"NV-01"`, `"A"`, `"2026-01-05"`, `"intern"`),
		base(`"NV-01"`, `"A"`, `"2026-01-05"`, `"Official"`),
		base(`"NV-01"`, `"A"`, `"2026-01-05"`, `null`),
		strings.TrimSuffix(ok, "}") + `,"role":"admin"}`,
		`{"code":"NV-01","fullName":"A","hiredOn":"2026-01-05","status":"official","position":null,"classification":null}`,
		`{"code":"NV-01","fullName":"A","hiredOn":"2026-01-05","status":"official","position":null,"classification":null,"identity":null}`,
		`{"code":"NV-01","fullName":"A","hiredOn":"2026-01-05","status":"official","classification":null,"identity":` + identityJSON(nil) + `}`,
		`{"code":"NV-01","fullName":"A","hiredOn":"2026-01-05","status":"official","position":null,"identity":` + identityJSON(nil) + `}`,
		`{"code":"NV-01","code":"NV-02","fullName":"A","hiredOn":"2026-01-05","status":"official","position":null,"classification":null,"identity":` + identityJSON(nil) + `}`,
	}
	for _, body := range bad {
		if _, err := parseCreateFrom(body); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("accepted: %.120s", body)
		}
	}
}

func parseCreateFrom(raw string) (CreateInput, error) {
	body, err := decodeBody[createBody](raw)
	if err != nil {
		return CreateInput{}, err
	}
	return parseCreate(body)
}

func TestProfile(t *testing.T) {
	parse := func(position, classification string) (UpdateInput, error) {
		body, err := decodeBody[updateBody](`{"expectedVersion":"1","code":"NV-01","fullName":"A","position":` + position + `,"classification":` + classification + `}`)
		if err != nil {
			return UpdateInput{}, err
		}
		return parseUpdate(testID, body)
	}
	got, err := parse(quoted(" Dev "), quoted("contractor"))
	if err != nil || got.Position == nil || *got.Position != "Dev" || got.Classification == nil || *got.Classification != ClassificationContractor {
		t.Fatalf("profile = %+v, %v", got.Profile, err)
	}
	if got, err := parse("null", "null"); err != nil || got.Position != nil || got.Classification != nil {
		t.Fatalf("null profile = %+v, %v", got.Profile, err)
	}
	if _, err := parse(quoted(strings.Repeat("a", 100)), quoted("fullTime")); err != nil {
		t.Errorf("100-character position refused: %v", err)
	}
	for _, pair := range [][2]string{
		{quoted(strings.Repeat("a", 101)), "null"}, {`""`, "null"}, {`"  "`, "null"}, {`"a\u0000"`, "null"}, {"1", "null"},
		{"null", quoted("parttime")}, {"null", quoted("fulltime")}, {"null", "1"}, {"null", `""`},
	} {
		if _, err := parse(pair[0], pair[1]); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%v accepted", pair)
		}
	}
}

func TestPathIDsAndVersions(t *testing.T) {
	for _, id := range []string{"", "bad", testID + "\n", "A0000000-0000-4000-8000-00000000000A", "10000000-0000-0000-8000-000000000001"} {
		if _, err := parseOfficial(id, officialBody{EffectiveOn: "2026-01-05"}); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("official id %q accepted", id)
		}
		if _, err := parseTermination(id, terminationBody{TerminatedOn: "2026-01-05"}); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("termination id %q accepted", id)
		}
		if _, err := parseLeaveRate(id, leaveRateBody{EffectiveFrom: "2026-01-05", AnnualMinutes: minutesField{true, 5760}}); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("rate id %q accepted", id)
		}
	}
	for _, version := range []string{"", "0", "01", "-1", "1.0", "9223372036854775808", "1\n"} {
		if _, err := parseAccountLink(testID, accountLinkBody{ExpectedVersion: version, AccountID: nullable[string]{Present: true}}); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("link version %q accepted", version)
		}
		if _, err := parseIdentityUpdate(testID, identityUpdateBody{ExpectedVersion: version, Identity: &identityBody{}}); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("identity version %q accepted", version)
		}
	}
	if got, err := parseOfficial(testID, officialBody{EffectiveOn: "2026-01-05"}); err != nil || got.EffectiveOn != "2026-01-05" {
		t.Errorf("official = %+v, %v", got, err)
	}
	for _, date := range []string{"2026-02-30", "", "2026-1-05"} {
		if _, err := parseTermination(testID, terminationBody{TerminatedOn: date}); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("termination date %q accepted", date)
		}
	}
}

func TestLeaveRateInput(t *testing.T) {
	parse := func(raw string) (LeaveRateInput, error) {
		body, err := decodeBody[leaveRateBody](raw)
		if err != nil {
			return LeaveRateInput{}, err
		}
		return parseLeaveRate(testID, body)
	}
	if got, err := parse(`{"effectiveFrom":"2026-03-01","annualMinutes":6000}`); err != nil || got.AnnualMinutes != 6000 {
		t.Fatalf("rate = %+v, %v", got, err)
	}
	for _, raw := range []string{
		`{"effectiveFrom":"2026-03-01"}`, `{"annualMinutes":6000}`, `{"effectiveFrom":"2026-03-01","annualMinutes":null}`,
		`{"effectiveFrom":"2026-03-01","annualMinutes":5759}`, `{"effectiveFrom":"2026-03-01","annualMinutes":175681}`,
		`{"effectiveFrom":"2026-03-01","annualMinutes":6000.0}`, `{"effectiveFrom":"2026-03-01","annualMinutes":"6000"}`,
		`{"effectiveFrom":"2026-02-30","annualMinutes":6000}`, `{"effectiveFrom":"2026-03-01","annualMinutes":6000,"employeeId":"x"}`,
	} {
		if _, err := parse(raw); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("accepted: %s", raw)
		}
	}
}

func TestAccountLinkInput(t *testing.T) {
	parse := func(raw string) (AccountLinkInput, error) {
		body, err := decodeBody[accountLinkBody](raw)
		if err != nil {
			return AccountLinkInput{}, err
		}
		return parseAccountLink(testID, body)
	}
	if got, err := parse(`{"expectedVersion":"3","accountId":"` + testID + `"}`); err != nil || got.AccountID == nil || *got.AccountID != testID {
		t.Fatalf("link = %+v, %v", got, err)
	}
	if got, err := parse(`{"expectedVersion":"3","accountId":null}`); err != nil || got.AccountID != nil {
		t.Fatalf("unlink = %+v, %v", got, err)
	}
	for _, raw := range []string{
		`{"expectedVersion":"3"}`, `{"expectedVersion":"3","accountId":"bad"}`, `{"expectedVersion":"3","accountId":5}`,
		`{"accountId":null}`, `{"expectedVersion":3,"accountId":null}`, `{"expectedVersion":"3","accountId":null,"kind":"root"}`,
	} {
		if _, err := parse(raw); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("accepted: %s", raw)
		}
	}
}

func TestListQuery(t *testing.T) {
	got, err := parseList("limit=50&offset=10&search=%20%E3%80%80")
	if err != nil || got.Limit != 50 || got.Offset != 10 || got.Search != "" {
		t.Fatalf("whitespace search = %+v, %v", got, err)
	}
	if got, err := parseList("search=%20An%20"); err != nil || got.Search != "An" || got.Limit != 20 {
		t.Fatalf("search = %+v, %v", got, err)
	}
	if _, err := parseList("search=" + strings.Repeat("a", 100)); err != nil {
		t.Errorf("100-character search refused: %v", err)
	}
	for _, query := range []string{
		"search=" + strings.Repeat("a", 101), "search=a%00b", "search=a&search=b", "q=a", "limit=0", "limit=101", "offset=10001", "limit=1.5",
	} {
		if _, err := parseList(query); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%q accepted", query)
		}
	}
}
