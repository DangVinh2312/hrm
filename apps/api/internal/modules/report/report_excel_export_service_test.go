package report

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/modules/attendancecore"
)

var ceiling = ExportLimits{MaxRows: ExportMaxRows, MaxBytes: ExportMaxBytes}

func who(n int) Employee {
	return Employee{
		EmployeeID:   fmt.Sprintf("00000000-0000-4000-8000-%012d", n),
		EmployeeCode: fmt.Sprintf("NV%03d", n),
		EmployeeName: vi("Nh{e2}n vi{ea}n ") + strconv.Itoa(n),
	}
}

var totals = attendancecore.Totals{
	ScheduledMinutes: 10560, PaidHolidayMinutes: 480, UnpaidMinutes: 240, AnnualLeaveMinutes: 600, PaidMinutes: 10320,
	WfhDays: 2, LateCount: 1, LateMinutes: 60, EarlyCount: 1, EarlyMinutes: 30, AdjustmentMinutes: -60,
}

func openTotals() attendancecore.Totals {
	open := totals
	open.WfhDays = 0
	return open
}

var annualRate = 5760

var results = map[Kind]Result{
	KindAttendance: Page[AttendanceRow]{Kind: KindAttendance, Total: "2", Rows: []AttendanceRow{
		{Employee: who(1), Month: "2026-03", PeriodState: attendancecore.PeriodClosed, Totals: totals},
		{Employee: who(1), Month: "2026-04", PeriodState: attendancecore.PeriodOpen, Totals: openTotals()},
	}},
	KindLateEarly: Page[LateEarlyRow]{Kind: KindLateEarly, Total: "1", Rows: []LateEarlyRow{
		{Employee: who(2), Month: "2026-03", PeriodState: attendancecore.PeriodOpen, LateCount: 3, LateMinutes: 90},
	}},
	KindWfh: Page[WfhRow]{Kind: KindWfh, Total: "2", Rows: []WfhRow{
		{Employee: who(3), Month: "2026-05", PeriodState: attendancecore.PeriodOpen, WfhDays: 5, OverLimit: true},
		{Employee: who(4), Month: "2026-05", PeriodState: attendancecore.PeriodOpen, WfhDays: 1},
	}},
	KindLeave: Page[LeaveRow]{Kind: KindLeave, Total: "1", Rows: []LeaveRow{
		{Employee: who(5), Year: 2026, AsOn: "2026-06-30", AnnualMinutes: &annualRate, EntitledMinutes: 2880, UsedMinutes: 1080,
			FutureApprovedMinutes: 480, PendingMinutes: 480, AvailableMinutes: 840},
	}},
	KindSeniority: Page[SeniorityRow]{Kind: KindSeniority, Total: "1", Rows: []SeniorityRow{
		{Employee: who(6), HiredOn: "2025-01-01", AsOn: "2026-12-31", Seniority: Seniority{Years: 2, TotalDays: 730}},
	}},
	KindBirthday: Page[BirthdayRow]{Kind: KindBirthday, Total: "1", Rows: []BirthdayRow{
		{Employee: who(7), Month: "2027-02", BirthdayOn: "2027-02-28"},
	}},
}

type expectedColumn struct {
	header string
	width  float64
}

var (
	employeeHeaders = []expectedColumn{{"M{e3} NV", 12}, {"H{1ecd} t{ea}n", 28}}
	periodHeaders   = []expectedColumn{{"Th{e1}ng", 10}, {"K{1ef3} c{f4}ng", 12}}
	lateEarlyHeader = []expectedColumn{
		{"S{1ed1} l{1ea7}n {111}i mu{1ed9}n", 16}, {"Ph{fa}t {111}i mu{1ed9}n", 16},
		{"S{1ed1} l{1ea7}n v{1ec1} s{1edb}m", 16}, {"Ph{fa}t v{1ec1} s{1edb}m", 16},
	}
)

func headers(parts ...[]expectedColumn) []expectedColumn {
	var all []expectedColumn
	for _, part := range parts {
		all = append(all, part...)
	}
	return all
}

var sheets = map[Kind]struct {
	name    string
	columns []expectedColumn
	rows    [][]string
}{
	KindAttendance: {
		name: "Ch{1ea5}m c{f4}ng",
		columns: headers(employeeHeaders, periodHeaders, []expectedColumn{
			{"Ph{fa}t theo l{1ecb}ch", 16}, {"Ph{fa}t ngh{1ec9} l{1ec5} h{1b0}{1edf}ng l{1b0}{1a1}ng", 16},
			{"Ph{fa}t ngh{1ec9} kh{f4}ng l{1b0}{1a1}ng", 16}, {"Ph{fa}t ph{e9}p n{103}m", 16},
			{"Ph{fa}t {111}{1b0}{1ee3}c tr{1ea3} l{1b0}{1a1}ng", 16}, {"Ng{e0}y WFH", 16},
		}, lateEarlyHeader, []expectedColumn{{"Ph{fa}t {111}i{1ec1}u ch{1ec9}nh c{f4}ng", 16}}),
		rows: [][]string{
			{"s:NV001", "s:Nh{e2}n vi{ea}n 1", "n:46082|mm/yyyy", "s:{110}{e3} ch{1ed1}t", "n:10560", "n:480", "n:240", "n:600", "n:10320", "n:2", "n:1", "n:60", "n:1", "n:30", "n:-60"},
			{"s:NV001", "s:Nh{e2}n vi{ea}n 1", "n:46113|mm/yyyy", "s:{110}ang m{1edf}", "n:10560", "n:480", "n:240", "n:600", "n:10320", "n:0", "n:1", "n:60", "n:1", "n:30", "n:-60"},
		},
	},
	KindLateEarly: {
		name:    "{110}i mu{1ed9}n - V{1ec1} s{1edb}m",
		columns: headers(employeeHeaders, periodHeaders, lateEarlyHeader),
		rows:    [][]string{{"s:NV002", "s:Nh{e2}n vi{ea}n 2", "n:46082|mm/yyyy", "s:{110}ang m{1edf}", "n:3", "n:90", "n:0", "n:0"}},
	},
	KindWfh: {
		name:    "WFH",
		columns: headers(employeeHeaders, periodHeaders, []expectedColumn{{"S{1ed1} ng{e0}y WFH", 16}, {"V{1b0}{1ee3}t 4 ng{e0}y/th{e1}ng", 18}}),
		rows: [][]string{
			{"s:NV003", "s:Nh{e2}n vi{ea}n 3", "n:46143|mm/yyyy", "s:{110}ang m{1edf}", "n:5", "s:C{f3}"},
			{"s:NV004", "s:Nh{e2}n vi{ea}n 4", "n:46143|mm/yyyy", "s:{110}ang m{1edf}", "n:1", "s:Kh{f4}ng"},
		},
	},
	KindLeave: {
		name: "Ph{e9}p n{103}m",
		columns: headers(employeeHeaders, []expectedColumn{
			{"N{103}m", 16}, {"Ng{e0}y c{1eaf}t", 14}, {"{110}{1ecb}nh m{1ee9}c n{103}m (ph{fa}t)", 16},
			{"Ph{fa}t {111}{e3} t{ed}ch l{169}y", 16}, {"Ph{fa}t {111}{e3} d{f9}ng", 16},
			{"Ph{fa}t {111}{e3} duy{1ec7}t sau ng{e0}y c{1eaf}t", 16}, {"Ph{fa}t {111}ang ch{1edd}", 16}, {"Ph{fa}t kh{1ea3} d{1ee5}ng", 16},
		}),
		rows: [][]string{{"s:NV005", "s:Nh{e2}n vi{ea}n 5", "n:2026", "n:46203|dd/mm/yyyy", "n:5760", "n:2880", "n:1080", "n:480", "n:480", "n:840"}},
	},
	KindSeniority: {
		name: "Th{e2}m ni{ea}n",
		columns: headers(employeeHeaders, []expectedColumn{
			{"Ng{e0}y v{e0}o l{e0}m", 14}, {"Ng{e0}y c{1eaf}t", 14}, {"S{1ed1} n{103}m", 16}, {"S{1ed1} th{e1}ng", 16},
			{"S{1ed1} ng{e0}y", 16}, {"T{1ed5}ng s{1ed1} ng{e0}y", 16},
		}),
		rows: [][]string{{"s:NV006", "s:Nh{e2}n vi{ea}n 6", "n:45658|dd/mm/yyyy", "n:46387|dd/mm/yyyy", "n:2", "n:0", "n:0", "n:730"}},
	},
	KindBirthday: {
		name:    "Sinh nh{1ead}t",
		columns: headers(employeeHeaders, []expectedColumn{{"Th{e1}ng", 10}, {"Ng{e0}y sinh nh{1ead}t", 14}}),
		rows:    [][]string{{"s:NV007", "s:Nh{e2}n vi{ea}n 7", "n:46419|mm/yyyy", "n:46446|dd/mm"}},
	},
}

func render(t *testing.T, result Result) workbook {
	t.Helper()
	content, err := renderXLSX(result, ceiling)
	if err != nil {
		t.Fatal(err)
	}
	return readWorkbook(t, content)
}

func tooLarge(t *testing.T, what string, err error) {
	t.Helper()
	status, code, known := apperror.Response(err)
	if !errors.Is(err, errExportTooLarge) || status != 422 || code != "error.exportTooLarge" || !known {
		t.Errorf("%s: %v (%d %s)", what, err, status, code)
	}
}

func TestEachReportIsOneSheetOfTypedCellsUnderVietnameseHeaders(t *testing.T) {
	for kind, want := range sheets {
		w := render(t, results[kind])
		if !reflect.DeepEqual(w.sheets, []string{vi(want.name)}) {
			t.Errorf("%s: sheets %q", kind, w.sheets)
		}
		grid := w.grid(t)
		var header []string
		for i, column := range want.columns {
			header = append(header, "s:"+vi(column.header)+"|b")
			var width float64
			for _, col := range w.sheet.Cols {
				if col.Min <= i+1 && i+1 <= col.Max {
					width = col.Width
				}
			}
			if width != column.width {
				t.Errorf("%s: width of %s is %v, want %v", kind, vi(column.header), width, column.width)
			}
		}
		rows := [][]string{header}
		for _, row := range want.rows {
			decoded := make([]string, len(row))
			for i, value := range row {
				decoded[i] = vi(value)
			}
			rows = append(rows, decoded)
		}
		if !reflect.DeepEqual(grid, rows) {
			t.Errorf("%s:\n got %q\nwant %q", kind, grid, rows)
		}
		if want := fmt.Sprintf("A1:%c%d", 'A'+len(want.columns)-1, len(want.rows)+1); w.sheet.Dimension.Ref != want {
			t.Errorf("%s: dimension %q, want %q", kind, w.sheet.Dimension.Ref, want)
		}
		if len(w.sheet.Views) != 1 || w.sheet.Views[0].Pane == nil {
			t.Fatalf("%s: views %+v", kind, w.sheet.Views)
		}
		if pane := *w.sheet.Views[0].Pane; pane.YSplit != "1" || pane.State != "frozen" || pane.TopLeftCell != "A2" {
			t.Errorf("%s: pane %+v", kind, pane)
		}
		if strings.Contains(w.sheetXML, "<f") {
			t.Errorf("%s: a formula in %s", kind, w.sheetXML)
		}
	}
}

func TestAProbationRowLeavesTheRateCellEmpty(t *testing.T) {
	leave := results[KindLeave].(Page[LeaveRow])
	row := leave.Rows[0]
	row.AnnualMinutes = nil
	grid := render(t, Page[LeaveRow]{Kind: KindLeave, Total: "1", Rows: []LeaveRow{row}}).grid(t)
	want := []string{"s:NV005", vi("s:Nh{e2}n vi{ea}n 5"), "n:2026", "n:46203|dd/mm/yyyy", "", "n:2880", "n:1080", "n:480", "n:480", "n:840"}
	if !reflect.DeepEqual(grid[1], want) {
		t.Errorf("probation row %q", grid[1])
	}
}

func TestDatesBeforeMarch1900AreTheDaysExcelShows(t *testing.T) {
	grid := render(t, Page[SeniorityRow]{Kind: KindSeniority, Total: "1", Rows: []SeniorityRow{
		{Employee: who(1), HiredOn: "1900-01-15", AsOn: "1900-03-01", Seniority: Seniority{Months: 1, Days: 15, TotalDays: 46}},
		{Employee: who(2), HiredOn: "1900-01-01", AsOn: "2100-12-31", Seniority: Seniority{Years: 201, TotalDays: 73414}},
	}}).grid(t)
	if got := [][]string{grid[1][2:4], grid[2][2:4]}; !reflect.DeepEqual(got, [][]string{
		{"n:15|dd/mm/yyyy", "n:61|dd/mm/yyyy"}, {"n:1|dd/mm/yyyy", "n:73415|dd/mm/yyyy"},
	}) {
		t.Errorf("serials %q", got)
	}
}

var hostile = []string{
	"=1+1", "+SUM(A1:A2)", "-2+3", "@SUM(1)", "\t=1+1", "\r=1+1", `=HYPERLINK("http://example.invalid","x")`,
	" =1+1 ", "=1+1\n", "<x>&amp;",
}

func withNames[R any](rows []R, set func(*R, Employee)) []R {
	out := make([]R, len(rows))
	for i, row := range rows {
		set(&row, Employee{EmployeeCode: hostile[(i+1)%len(hostile)], EmployeeName: hostile[i%len(hostile)]})
		out[i] = row
	}
	return out
}

func hostileResults() map[Kind]Result {
	many := func(n int) []int { return make([]int, n) }
	attendance := make([]AttendanceRow, len(hostile))
	lateEarly := make([]LateEarlyRow, len(hostile))
	wfh := make([]WfhRow, len(hostile))
	leave := make([]LeaveRow, len(hostile))
	seniority := make([]SeniorityRow, len(hostile))
	birthday := make([]BirthdayRow, len(hostile))
	for i := range many(len(hostile)) {
		attendance[i] = AttendanceRow{Month: "2026-03", PeriodState: attendancecore.PeriodOpen}
		lateEarly[i] = LateEarlyRow{Month: "2026-03", PeriodState: attendancecore.PeriodOpen}
		wfh[i] = WfhRow{Month: "2026-03", PeriodState: attendancecore.PeriodOpen}
		leave[i] = LeaveRow{Year: 2026, AsOn: "2026-06-30"}
		seniority[i] = SeniorityRow{HiredOn: "2025-01-01", AsOn: "2026-12-31"}
		birthday[i] = BirthdayRow{Month: "2027-02", BirthdayOn: "2027-02-28"}
	}
	return map[Kind]Result{
		KindAttendance: Page[AttendanceRow]{Kind: KindAttendance, Rows: withNames(attendance, func(r *AttendanceRow, e Employee) { r.Employee = e })},
		KindLateEarly:  Page[LateEarlyRow]{Kind: KindLateEarly, Rows: withNames(lateEarly, func(r *LateEarlyRow, e Employee) { r.Employee = e })},
		KindWfh:        Page[WfhRow]{Kind: KindWfh, Rows: withNames(wfh, func(r *WfhRow, e Employee) { r.Employee = e })},
		KindLeave:      Page[LeaveRow]{Kind: KindLeave, Rows: withNames(leave, func(r *LeaveRow, e Employee) { r.Employee = e })},
		KindSeniority:  Page[SeniorityRow]{Kind: KindSeniority, Rows: withNames(seniority, func(r *SeniorityRow, e Employee) { r.Employee = e })},
		KindBirthday:   Page[BirthdayRow]{Kind: KindBirthday, Rows: withNames(birthday, func(r *BirthdayRow, e Employee) { r.Employee = e })},
	}
}

// Text that starts with = + - @, a tab or CR stays the same string cell; the raw sheet XML has no formula.
func TestTextThatLooksLikeAFormulaStaysText(t *testing.T) {
	for kind, result := range hostileResults() {
		w := render(t, result)
		if strings.Contains(w.sheetXML, "<f") {
			t.Errorf("%s: a formula element in the sheet", kind)
		}
		grid := w.grid(t)
		for i := range hostile {
			code, name := hostile[(i+1)%len(hostile)], hostile[i%len(hostile)]
			if got := grid[i+1][:2]; got[0] != "s:"+code || got[1] != "s:"+name {
				t.Errorf("%s row %d: %q, want %q and %q", kind, i, got, code, name)
			}
		}
	}
}

func longName(units int, emoji bool) Result {
	name := strings.Repeat("x", units)
	if emoji {
		name = strings.Repeat(string(rune(0x1f600)), units/2) + strings.Repeat("x", units%2)
	}
	row := SeniorityRow{Employee: Employee{EmployeeCode: "NV001", EmployeeName: name}, HiredOn: "2025-01-01", AsOn: "2026-12-31"}
	return Page[SeniorityRow]{Kind: KindSeniority, Total: "1", Rows: []SeniorityRow{row}}
}

// Excel holds 32767 UTF-16 units in a cell. A longer text is refused, never cut.
func TestALongTextIsKeptWholeOrRefused(t *testing.T) {
	for _, emoji := range []bool{false, true} {
		grid := render(t, longName(32767, emoji)).grid(t)
		if want := longName(32767, emoji).(Page[SeniorityRow]).Rows[0].EmployeeName; grid[1][1] != "s:"+want {
			t.Errorf("emoji %v: 32767 units came back as %d bytes", emoji, len(grid[1][1]))
		}
		for _, units := range []int{32768, 100000} {
			_, err := renderXLSX(longName(units, emoji), ceiling)
			tooLarge(t, fmt.Sprintf("%d units (emoji %v)", units, emoji), err)
		}
	}
}

func seniorityRows(n int, name func(int) string) Page[SeniorityRow] {
	rows := make([]SeniorityRow, n)
	for i := range rows {
		e := who(i + 1)
		if name != nil {
			e.EmployeeName = name(i)
		}
		rows[i] = SeniorityRow{Employee: e, HiredOn: "2025-01-01", AsOn: "2026-12-31", Seniority: Seniority{Years: 1, TotalDays: 365}}
	}
	return Page[SeniorityRow]{Kind: KindSeniority, Total: strconv.Itoa(n), Rows: rows}
}

func TestTheRendererAppliesTheLoweredBudgetsNeverAboveTheCeilings(t *testing.T) {
	three := seniorityRows(3, nil)
	_, err := renderXLSX(three, ExportLimits{MaxRows: 2, MaxBytes: ExportMaxBytes})
	tooLarge(t, "3 rows over a budget of 2", err)
	_, err = renderXLSX(three, ExportLimits{MaxRows: 3, MaxBytes: 1000})
	tooLarge(t, "3 rows over 1000 bytes", err)
	if content, err := renderXLSX(three, ExportLimits{MaxRows: 3, MaxBytes: ExportMaxBytes}); err != nil || len(readWorkbook(t, content).sheet.Rows) != 4 {
		t.Errorf("3 rows within the budgets: %v", err)
	}
	wide := ExportLimits{MaxRows: 2 * ExportMaxRows, MaxBytes: 2 * ExportMaxBytes}
	_, err = renderXLSX(seniorityRows(ExportMaxRows+1, nil), wide)
	tooLarge(t, "a row past the ceiling", err)
	content, err := renderXLSX(seniorityRows(ExportMaxRows, nil), wide)
	if err != nil || len(readWorkbook(t, content).sheet.Rows) != ExportMaxRows+1 {
		t.Errorf("%d rows: %v", ExportMaxRows, err)
	}
	wfh := make([]WfhRow, 200)
	for i := range wfh {
		wfh[i] = WfhRow{Employee: who(i + 1), Month: "2026-05", PeriodState: attendancecore.PeriodOpen, WfhDays: 5, OverLimit: true}
	}
	_, err = renderXLSX(Page[WfhRow]{Kind: KindWfh, Total: "200", Rows: wfh}, ExportLimits{MaxRows: ExportMaxRows, MaxBytes: 1000})
	tooLarge(t, "200 rows over 1000 bytes", err)
}

// Names of random bytes barely compress: 5000 rows of 3 KiB pass 5 MiB, of 256 bytes stay under it.
func TestTheDefaultByteBudgetIsFiveMebibytes(t *testing.T) {
	if ExportMaxBytes != 5*1024*1024 || ExportMaxRows != 5000 {
		t.Fatalf("budgets %d rows, %d bytes", ExportMaxRows, ExportMaxBytes)
	}
	random := func(length int) func(int) string {
		return func(int) string {
			data := make([]byte, length)
			_, _ = rand.Read(data)
			return base64.StdEncoding.EncodeToString(data)
		}
	}
	wide := ExportLimits{MaxRows: ExportMaxRows, MaxBytes: 1 << 30}
	_, err := renderXLSX(seniorityRows(ExportMaxRows, random(3072)), wide)
	tooLarge(t, "5000 rows of 3 KiB names", err)
	content, err := renderXLSX(seniorityRows(ExportMaxRows, random(256)), ceiling)
	if err != nil || len(content) == 0 || len(content) >= ExportMaxBytes {
		t.Errorf("5000 rows of 256-byte names: %d bytes, %v", len(content), err)
	}
}

func TestNoResultIsRefusedWithoutAFile(t *testing.T) {
	if content, err := renderXLSX(nil, ceiling); err == nil || content != nil {
		t.Errorf("nil result: %d bytes, %v", len(content), err)
	}
}
