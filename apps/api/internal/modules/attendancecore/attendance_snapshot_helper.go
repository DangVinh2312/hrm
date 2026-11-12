package attendancecore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"math/big"
)

// The snapshot of a closed month (D07) is stored as jsonb, which does not keep key order, so its hash is
// defined over ONE canonical serialization per format, rebuilt from the values in a fixed key order:
//   - format 1 (no formatVersion; every close before attendance.adjust): month, calendarVersion,
//     employees[{employeeId, ten totals}];
//   - format 2: formatVersion 2 first and adjustmentMinutes appended to the totals.
// A reader verifies by hashing the canonical form of the format the document declares.

type SnapshotEmployee struct {
	EmployeeID string
	Totals
}

type Snapshot struct {
	// FormatVersion is 1 (written before attendance.adjust) or 2.
	FormatVersion int
	Month         string
	// CalendarVersion is int8 as a decimal string.
	CalendarVersion string
	// Employees are in employee id order, as the close wrote them.
	Employees []SnapshotEmployee
}

var ErrInvalidSnapshot = errors.New("invalid attendance snapshot")

var ErrSnapshotMismatch = errors.New("attendance snapshot does not match its hash")

type totalsV1 struct {
	ScheduledMinutes   int `json:"scheduledMinutes"`
	PaidHolidayMinutes int `json:"paidHolidayMinutes"`
	UnpaidMinutes      int `json:"unpaidMinutes"`
	AnnualLeaveMinutes int `json:"annualLeaveMinutes"`
	PaidMinutes        int `json:"paidMinutes"`
	WfhDays            int `json:"wfhDays"`
	LateCount          int `json:"lateCount"`
	LateMinutes        int `json:"lateMinutes"`
	EarlyCount         int `json:"earlyCount"`
	EarlyMinutes       int `json:"earlyMinutes"`
}

type employeeV1 struct {
	EmployeeID string `json:"employeeId"`
	totalsV1   `json:",inline"`
}

type employeeV2 struct {
	EmployeeID        string `json:"employeeId"`
	totalsV1          `json:",inline"`
	AdjustmentMinutes int `json:"adjustmentMinutes"`
}

type documentV1 struct {
	Month           string       `json:"month"`
	CalendarVersion string       `json:"calendarVersion"`
	Employees       []employeeV1 `json:"employees"`
}

type documentV2 struct {
	FormatVersion   int          `json:"formatVersion"`
	Month           string       `json:"month"`
	CalendarVersion string       `json:"calendarVersion"`
	Employees       []employeeV2 `json:"employees"`
}

func baseTotals(t Totals) totalsV1 {
	return totalsV1{t.ScheduledMinutes, t.PaidHolidayMinutes, t.UnpaidMinutes, t.AnnualLeaveMinutes, t.PaidMinutes,
		t.WfhDays, t.LateCount, t.LateMinutes, t.EarlyCount, t.EarlyMinutes}
}

// BuildSnapshot is the document of a close, always the newest format.
func BuildSnapshot(month, calendarVersion string, employees []SnapshotEmployee) Snapshot {
	return Snapshot{FormatVersion: 2, Month: month, CalendarVersion: calendarVersion, Employees: employees}
}

// CanonicalSnapshot is the bytes that are hashed and stored, in the key order of the snapshot's format.
// Every value is ASCII digits, a UUID or `YYYY-MM`, so the encoding equals JSON.stringify.
func CanonicalSnapshot(s Snapshot) ([]byte, error) {
	switch s.FormatVersion {
	case 1:
		doc := documentV1{Month: s.Month, CalendarVersion: s.CalendarVersion, Employees: make([]employeeV1, len(s.Employees))}
		for i, e := range s.Employees {
			doc.Employees[i] = employeeV1{e.EmployeeID, baseTotals(e.Totals)}
		}
		return json.Marshal(doc)
	case 2:
		doc := documentV2{FormatVersion: 2, Month: s.Month, CalendarVersion: s.CalendarVersion, Employees: make([]employeeV2, len(s.Employees))}
		for i, e := range s.Employees {
			doc.Employees[i] = employeeV2{e.EmployeeID, baseTotals(e.Totals), e.AdjustmentMinutes}
		}
		return json.Marshal(doc)
	}
	return nil, ErrInvalidSnapshot
}

// SnapshotHash is the SHA-256 hex of the canonical serialization.
func SnapshotHash(s Snapshot) (string, error) {
	canonical, err := CanonicalSnapshot(s)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

var totalKeys = []string{"scheduledMinutes", "paidHolidayMinutes", "unpaidMinutes", "annualLeaveMinutes", "paidMinutes",
	"wfhDays", "lateCount", "lateMinutes", "earlyCount", "earlyMinutes"}

const maxSafeInteger = 1<<53 - 1

// safeInteger reads a JSON number as JavaScript's Number.isSafeInteger would accept it (480.0 is 480).
func safeInteger(raw jsontext.Value, signed bool) (int, bool) {
	if raw.Kind() != '0' {
		return 0, false
	}
	value, ok := new(big.Rat).SetString(string(raw))
	if !ok || !value.IsInt() || !value.Num().IsInt64() {
		return 0, false
	}
	n := value.Num().Int64()
	if n > maxSafeInteger || n < -maxSafeInteger || (n < 0 && !signed) {
		return 0, false
	}
	return int(n), true
}

func parseEmployee(raw jsontext.Value, format int) (SnapshotEmployee, error) {
	var fields map[string]jsontext.Value
	if err := json.Unmarshal(raw, &fields); err != nil {
		return SnapshotEmployee{}, ErrInvalidSnapshot
	}
	var id string
	if json.Unmarshal(fields["employeeId"], &id) != nil {
		return SnapshotEmployee{}, ErrInvalidSnapshot
	}
	keys := totalKeys
	if format == 2 {
		keys = append(append([]string{}, totalKeys...), "adjustmentMinutes")
	}
	values := map[string]int{}
	for _, key := range keys {
		n, ok := safeInteger(fields[key], key == "paidMinutes" || key == "adjustmentMinutes")
		if !ok {
			return SnapshotEmployee{}, ErrInvalidSnapshot
		}
		values[key] = n
	}
	return SnapshotEmployee{EmployeeID: id, Totals: Totals{
		ScheduledMinutes: values["scheduledMinutes"], PaidHolidayMinutes: values["paidHolidayMinutes"],
		UnpaidMinutes: values["unpaidMinutes"], AnnualLeaveMinutes: values["annualLeaveMinutes"], PaidMinutes: values["paidMinutes"],
		WfhDays: values["wfhDays"], LateCount: values["lateCount"], LateMinutes: values["lateMinutes"],
		EarlyCount: values["earlyCount"], EarlyMinutes: values["earlyMinutes"], AdjustmentMinutes: values["adjustmentMinutes"],
	}}, nil
}

// ParseSnapshot reads a stored snapshot (the jsonb read back) as the canonical typed document. A format 1
// entry reads as zero adjustments and keeps its own canonical form.
func ParseSnapshot(raw []byte) (Snapshot, error) {
	var doc struct {
		FormatVersion jsontext.Value   `json:"formatVersion"`
		Month         *string          `json:"month"`
		Calendar      *string          `json:"calendarVersion"`
		Employees     []jsontext.Value `json:"employees"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Month == nil || doc.Calendar == nil || doc.Employees == nil {
		return Snapshot{}, ErrInvalidSnapshot
	}
	format := 1
	if doc.FormatVersion != nil {
		if n, ok := safeInteger(doc.FormatVersion, false); !ok || n != 2 {
			return Snapshot{}, ErrInvalidSnapshot
		}
		format = 2
	}
	s := Snapshot{FormatVersion: format, Month: *doc.Month, CalendarVersion: *doc.Calendar, Employees: make([]SnapshotEmployee, len(doc.Employees))}
	for i, e := range doc.Employees {
		employee, err := parseEmployee(e, format)
		if err != nil {
			return Snapshot{}, err
		}
		s.Employees[i] = employee
	}
	return s, nil
}

// VerifiedSnapshot checks the stored jsonb of a closed month against its stored hash and month; a report never
// serves a snapshot it cannot prove (fail closed).
func VerifiedSnapshot(month string, stored []byte, hash string) (Snapshot, error) {
	s, err := ParseSnapshot(stored)
	if err != nil {
		return Snapshot{}, err
	}
	got, err := SnapshotHash(s)
	if err != nil {
		return Snapshot{}, err
	}
	if s.Month != month || got != hash {
		return Snapshot{}, ErrSnapshotMismatch
	}
	return s, nil
}
