package report

import (
	"errors"
	"testing"

	"hrm/api/internal/apperror"
)

func refused(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("accepted %s: %v", what, err)
	}
}

func monthly(kind Kind, from, to string, limit, offset int) Query {
	return Query{ExportQuery: ExportQuery{Kind: kind, From: from, To: to}, Limit: limit, Offset: offset}
}

func cutoff(kind Kind, asOn string, limit, offset int) Query {
	return Query{ExportQuery: ExportQuery{Kind: kind, AsOn: asOn}, Limit: limit, Offset: offset}
}

func TestMonthlyReportsNeedAnExplicitRangeOfAtMostTwelveMonths(t *testing.T) {
	accepted := []struct {
		kind  Kind
		query string
		want  Query
	}{
		{KindWfh, "from=2026-01&to=2026-12", monthly(KindWfh, "2026-01", "2026-12", 20, 0)},
		{KindLateEarly, "from=2026-11&to=2026-11&limit=100&offset=10000", monthly(KindLateEarly, "2026-11", "2026-11", 100, 10000)},
		{KindAttendance, "from=2025-12&to=2026-11", monthly(KindAttendance, "2025-12", "2026-11", 20, 0)},
		{KindAttendance, "to=2026-11&offset=0&from=2026-11&limit=1", monthly(KindAttendance, "2026-11", "2026-11", 1, 0)},
		{KindAttendance, "%66rom=2026-11&to=2026-11", monthly(KindAttendance, "2026-11", "2026-11", 20, 0)},
		{KindAttendance, "from=1900-01&to=1900-12", monthly(KindAttendance, "1900-01", "1900-12", 20, 0)},
		{KindAttendance, "from=2100-01&to=2100-12", monthly(KindAttendance, "2100-01", "2100-12", 20, 0)},
		{KindBirthday, "from=2027-02&to=2027-02&limit=50", monthly(KindBirthday, "2027-02", "2027-02", 50, 0)},
		{KindBirthday, "from=2026-12&to=2027-11", monthly(KindBirthday, "2026-12", "2027-11", 20, 0)},
	}
	for _, c := range accepted {
		got, err := parseQuery(c.kind, c.query)
		if err != nil || got != c.want {
			t.Errorf("%s %q: %+v, %v", c.kind, c.query, got, err)
		}
	}
	for _, kind := range []Kind{KindAttendance, KindLateEarly, KindWfh, KindBirthday} {
		for _, query := range []string{
			"from=2025-11&to=2026-11", "from=2026-12&to=2026-11", "from=2026-11", "to=2026-11", "",
			"from=2026-13&to=2026-13", "from=2026-1&to=2026-11", "from=2026-11-01&to=2026-11", "from=1899-12&to=1900-01",
			"from=2100-12&to=2101-01", "from=2026-11&to=2026-11&asOn=2026-11-30", "from=2026-11&to=2026-11&employeeId=x",
			"from=2026-11&to=2026-11&limit=101", "from=2026-11&to=2026-11&limit=0", "from=2026-11&to=2026-11&offset=10001",
			"from=2026-11&to=2026-11&limit=1.0", "from=2026-11&to=2026-11&limit=1e2", "from=2026-11&to=2026-11&limit=-1",
			"from=2026-11&to=2026-11&limit=+5", "from=2026-11&to=2026-11&limit=", "from=2026-11&to=2026-11&offset=%2D1",
			"from=2026-11&from=2026-12&to=2026-12", "from=2026-11&%66rom=2026-11&to=2026-11", "from=2026-11&to=2026-11&limit=5&limit=5",
			"from=2026-11&to=2026-11&%6Cimit=5&limit=5", "from=2026-11&to=%zz", "From=2026-11&to=2026-11", "from=&to=2026-11",
			"from=2026-11&to=2026-11&from", "asOn=2027-02-28",
		} {
			_, err := parseQuery(kind, query)
			refused(t, string(kind)+" "+query, err)
		}
	}
}

func TestLeaveAndSeniorityNeedAnExplicitValidCutoff(t *testing.T) {
	for _, kind := range []Kind{KindLeave, KindSeniority} {
		for query, want := range map[string]Query{
			"asOn=2026-11-30&limit=5":         cutoff(kind, "2026-11-30", 5, 0),
			"asOn=2024-02-29":                 cutoff(kind, "2024-02-29", 20, 0),
			"asOn=1900-01-01&offset=10000":    cutoff(kind, "1900-01-01", 20, 10000),
			"limit=100&asOn=2100-12-31":       cutoff(kind, "2100-12-31", 100, 0),
			"%61sOn=2026-11-30&offset=0001":   cutoff(kind, "2026-11-30", 20, 1),
			"asOn=2026-11-30&limit=00100":     cutoff(kind, "2026-11-30", 100, 0),
			"offset=0&limit=20&asOn=2026-1-1": {},
		} {
			got, err := parseQuery(kind, query)
			if want == (Query{}) {
				refused(t, string(kind)+" "+query, err)
				continue
			}
			if err != nil || got != want {
				t.Errorf("%s %q: %+v, %v", kind, query, got, err)
			}
		}
		for _, query := range []string{
			"", "asOn=2026-02-30", "asOn=2026-11", "asOn=2026-11-30&from=2026-11", "asOn=2026-11-30&asOn=2026-11-30",
			"asOn=1899-12-31", "asOn=2101-01-01", "asOn=2026-11-30T00:00:00Z", "asOn=", "asOn=2026-11-30&limit=101",
			"from=2026-11&to=2026-11", "asOn=2026-11-30&x=1", "AsOn=2026-11-30", "asOn=2026-11-31",
		} {
			_, err := parseQuery(kind, query)
			refused(t, string(kind)+" "+query, err)
		}
	}
	_, err := parseQuery("nobody", "asOn=2026-11-30")
	refused(t, "an unknown kind", err)
	_, err = parseQuery("", "from=2026-11&to=2026-11")
	refused(t, "an empty kind", err)
}

func TestExportQueryTakesTheReportKeysOnly(t *testing.T) {
	for kind, cases := range map[Kind]map[string]ExportQuery{
		KindWfh:       {"from=2026-01&to=2026-12": {Kind: KindWfh, From: "2026-01", To: "2026-12"}},
		KindLeave:     {"asOn=2026-06-30": {Kind: KindLeave, AsOn: "2026-06-30"}},
		KindSeniority: {"asOn=2026-12-31": {Kind: KindSeniority, AsOn: "2026-12-31"}},
		KindBirthday:  {"to=2027-02&from=2027-02": {Kind: KindBirthday, From: "2027-02", To: "2027-02"}},
	} {
		for query, want := range cases {
			got, err := parseExportQuery(kind, query)
			if err != nil || got != want {
				t.Errorf("%s %q: %+v, %v", kind, query, got, err)
			}
		}
	}
	for _, kind := range []Kind{KindAttendance, KindLateEarly, KindWfh, KindBirthday} {
		for _, query := range []string{
			"from=2025-11&to=2026-11", "from=2026-11&to=2026-10", "from=2026-11&to=2026-11&limit=5",
			"from=2026-11&to=2026-11&offset=0", "from=2026-11&to=2026-11&limit=20&offset=0", "from=2026-11&to=2026-11&%6Cimit=5",
			"from=2026-11", "", "from=2026-11&to=2026-11&to=2026-11", "from=2026-11&to=2026-11&asOn=2026-11-30", "asOn=2026-11-30",
		} {
			_, err := parseExportQuery(kind, query)
			refused(t, "export "+string(kind)+" "+query, err)
		}
	}
	for _, kind := range []Kind{KindLeave, KindSeniority} {
		for _, query := range []string{
			"asOn=2026-02-30", "asOn=2026-06-30&limit=5", "asOn=2026-06-30&offset=0", "", "asOn=2026-06-30&asOn=2026-06-30",
			"from=2026-06&to=2026-06",
		} {
			_, err := parseExportQuery(kind, query)
			refused(t, "export "+string(kind)+" "+query, err)
		}
	}
	_, err := parseExportQuery("nobody", "asOn=2026-06-30")
	refused(t, "export of an unknown kind", err)
}

func TestTheFileNameIsFixedByTheReportAndItsValidatedRange(t *testing.T) {
	for want, query := range map[string]ExportQuery{
		"hrm-report-attendance-2026-03_2026-04.xlsx": {Kind: KindAttendance, From: "2026-03", To: "2026-04"},
		"hrm-report-late-early-2026-03_2026-03.xlsx": {Kind: KindLateEarly, From: "2026-03", To: "2026-03"},
		"hrm-report-seniority-2026-12-31.xlsx":       {Kind: KindSeniority, AsOn: "2026-12-31"},
		"hrm-report-leave-2026-06-30.xlsx":           {Kind: KindLeave, AsOn: "2026-06-30"},
		"hrm-report-birthday-2027-02_2027-02.xlsx":   {Kind: KindBirthday, From: "2027-02", To: "2027-02"},
	} {
		if got := exportFileName(query); got != want {
			t.Errorf("%+v: %s, want %s", query, got, want)
		}
	}
	if XLSXMime != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
		t.Errorf("mime %s", XLSXMime)
	}
}

func TestTheSpanIsCheckedAgainstTheLimitInForce(t *testing.T) {
	for _, c := range []struct {
		from, to string
		max      int
		ok       bool
	}{
		{"2026-01", "2026-12", 12, true},
		{"2026-01", "2026-12", 11, false},
		{"2026-01", "2026-03", 3, true},
		{"2026-01", "2026-04", 3, false},
		{"2025-12", "2026-01", 2, true},
		{"2026-02", "2026-01", 12, false},
		{"2026-01", "2026-01", 1, true},
		{"2026-01", "2026-01", 0, false},
		{"2026-13", "2026-12", 12, false},
		{"2026-01", "26-12", 12, false},
	} {
		err := checkSpan(c.from, c.to, c.max)
		if c.ok && err != nil {
			t.Errorf("%s..%s within %d: %v", c.from, c.to, c.max, err)
		}
		if !c.ok {
			refused(t, c.from+".."+c.to, err)
		}
	}
}
