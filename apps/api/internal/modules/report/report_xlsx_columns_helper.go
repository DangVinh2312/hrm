package report

import "hrm/api/internal/modules/attendancecore"

type cellKind uint8

const (
	cellEmpty cellKind = iota
	cellText
	cellNumber
	cellDate
)

// cellValue is one typed cell: text is always a string cell, a number a numeric one, a date the calendar day
// `YYYY-MM-DD` at UTC midnight.
type cellValue struct {
	kind   cellKind
	text   string
	number int
	date   string
}

func textCell(text string) cellValue { return cellValue{kind: cellText, text: text} }

func numberCell(number int) cellValue { return cellValue{kind: cellNumber, number: number} }

func optionalNumberCell(number *int) cellValue {
	if number == nil {
		return cellValue{kind: cellEmpty}
	}
	return numberCell(*number)
}

func dateCell(date string) cellValue { return cellValue{kind: cellDate, date: date} }

type column[R any] struct {
	header string
	width  float64
	numFmt string
	value  func(R) cellValue
}

const (
	dayFormat      = "dd/mm/yyyy"
	monthFormat    = "mm/yyyy"
	birthdayFormat = "dd/mm"
)

type employed interface{ person() Employee }

func text[R any](header string, width float64, value func(R) string) column[R] {
	return column[R]{header: header, width: width, value: func(row R) cellValue { return textCell(value(row)) }}
}

func count[R any](header string, value func(R) int) column[R] {
	return column[R]{header: header, width: 16, value: func(row R) cellValue { return numberCell(value(row)) }}
}

func date[R any](header, numFmt string, value func(R) string) column[R] {
	return column[R]{header: header, width: 14, numFmt: numFmt, value: func(row R) cellValue { return dateCell(value(row)) }}
}

func employeeColumns[R employed]() []column[R] {
	return []column[R]{
		text("Mã NV", 12, func(row R) string { return row.person().EmployeeCode }),
		text("Họ tên", 28, func(row R) string { return row.person().EmployeeName }),
	}
}

func monthColumn[R any](month func(R) string) column[R] {
	return column[R]{header: "Tháng", width: 10, numFmt: monthFormat, value: func(row R) cellValue { return dateCell(month(row) + "-01") }}
}

func stateColumn[R any](state func(R) attendancecore.PeriodState) column[R] {
	return text("Kỳ công", 12, func(row R) string {
		if state(row) == attendancecore.PeriodClosed {
			return "Đã chốt"
		}
		return "Đang mở"
	})
}

type lateEarlyCounts struct{ lateCount, lateMinutes, earlyCount, earlyMinutes int }

func lateEarlyColumns[R any](counts func(R) lateEarlyCounts) []column[R] {
	return []column[R]{
		count("Số lần đi muộn", func(row R) int { return counts(row).lateCount }),
		count("Phút đi muộn", func(row R) int { return counts(row).lateMinutes }),
		count("Số lần về sớm", func(row R) int { return counts(row).earlyCount }),
		count("Phút về sớm", func(row R) int { return counts(row).earlyMinutes }),
	}
}

func join[R any](parts ...[]column[R]) []column[R] {
	var all []column[R]
	for _, part := range parts {
		all = append(all, part...)
	}
	return all
}

var attendanceColumns = join(
	employeeColumns[AttendanceRow](),
	[]column[AttendanceRow]{
		monthColumn(func(row AttendanceRow) string { return row.Month }),
		stateColumn(func(row AttendanceRow) attendancecore.PeriodState { return row.PeriodState }),
		count("Phút theo lịch", func(row AttendanceRow) int { return row.ScheduledMinutes }),
		count("Phút nghỉ lễ hưởng lương", func(row AttendanceRow) int { return row.PaidHolidayMinutes }),
		count("Phút nghỉ không lương", func(row AttendanceRow) int { return row.UnpaidMinutes }),
		count("Phút phép năm", func(row AttendanceRow) int { return row.AnnualLeaveMinutes }),
		count("Phút được trả lương", func(row AttendanceRow) int { return row.PaidMinutes }),
		count("Ngày WFH", func(row AttendanceRow) int { return row.WfhDays }),
	},
	lateEarlyColumns(func(row AttendanceRow) lateEarlyCounts {
		return lateEarlyCounts{row.LateCount, row.LateMinutes, row.EarlyCount, row.EarlyMinutes}
	}),
	[]column[AttendanceRow]{count("Phút điều chỉnh công", func(row AttendanceRow) int { return row.AdjustmentMinutes })},
)

var lateEarlySheetColumns = join(
	employeeColumns[LateEarlyRow](),
	[]column[LateEarlyRow]{
		monthColumn(func(row LateEarlyRow) string { return row.Month }),
		stateColumn(func(row LateEarlyRow) attendancecore.PeriodState { return row.PeriodState }),
	},
	lateEarlyColumns(func(row LateEarlyRow) lateEarlyCounts {
		return lateEarlyCounts{row.LateCount, row.LateMinutes, row.EarlyCount, row.EarlyMinutes}
	}),
)

// The header keeps the 4 of the default hr.wfhMonthLimit; OverLimit itself follows the setting in force.
var wfhColumns = join(employeeColumns[WfhRow](), []column[WfhRow]{
	monthColumn(func(row WfhRow) string { return row.Month }),
	stateColumn(func(row WfhRow) attendancecore.PeriodState { return row.PeriodState }),
	count("Số ngày WFH", func(row WfhRow) int { return row.WfhDays }),
	text("Vượt 4 ngày/tháng", 18, func(row WfhRow) string {
		if row.OverLimit {
			return "Có"
		}
		return "Không"
	}),
})

var leaveColumns = join(employeeColumns[LeaveRow](), []column[LeaveRow]{
	count("Năm", func(row LeaveRow) int { return row.Year }),
	date("Ngày cắt", dayFormat, func(row LeaveRow) string { return row.AsOn }),
	{header: "Định mức năm (phút)", width: 16, value: func(row LeaveRow) cellValue { return optionalNumberCell(row.AnnualMinutes) }},
	count("Phút đã tích lũy", func(row LeaveRow) int { return row.EntitledMinutes }),
	count("Phút đã dùng", func(row LeaveRow) int { return row.UsedMinutes }),
	count("Phút đã duyệt sau ngày cắt", func(row LeaveRow) int { return row.FutureApprovedMinutes }),
	count("Phút đang chờ", func(row LeaveRow) int { return row.PendingMinutes }),
	count("Phút khả dụng", func(row LeaveRow) int { return row.AvailableMinutes }),
})

var seniorityColumns = join(employeeColumns[SeniorityRow](), []column[SeniorityRow]{
	date("Ngày vào làm", dayFormat, func(row SeniorityRow) string { return row.HiredOn }),
	date("Ngày cắt", dayFormat, func(row SeniorityRow) string { return row.AsOn }),
	count("Số năm", func(row SeniorityRow) int { return row.Years }),
	count("Số tháng", func(row SeniorityRow) int { return row.Months }),
	count("Số ngày", func(row SeniorityRow) int { return row.Days }),
	count("Tổng số ngày", func(row SeniorityRow) int { return row.TotalDays }),
})

// The birthday cell is the day celebrated in the report's year shown as day/month: no birth year.
var birthdayColumns = join(employeeColumns[BirthdayRow](), []column[BirthdayRow]{
	monthColumn(func(row BirthdayRow) string { return row.Month }),
	date("Ngày sinh nhật", birthdayFormat, func(row BirthdayRow) string { return row.BirthdayOn }),
})

// exportFileName is fixed by the report and its validated range, so nothing else the caller typed
// reaches the header.
func exportFileName(query ExportQuery) string {
	span := query.AsOn
	if query.Kind.monthly() {
		span = query.From + "_" + query.To
	}
	return "hrm-report-" + string(query.Kind) + "-" + span + ".xlsx"
}
