package report

import (
	"errors"
	"time"
	"unicode/utf16"

	"github.com/xuri/excelize/v2"

	"hrm/api-go/internal/apperror"
)

// Export budgets: a file is the whole scoped set or a refusal, never a cut one. export.maxRows and
// export.maxBytes can only lower them.
const (
	ExportMaxRows  = 5000
	ExportMaxBytes = 5 << 20
	XLSXMime       = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	// maxCellUnits is the longest text Excel keeps in a cell, in UTF-16 code units; excelize would cut it.
	maxCellUnits = 32767
)

var (
	errExportTooLarge = apperror.Rejection{Code: "error.exportTooLarge"}
	errUnknownReport  = errors.New("unknown report")
)

// ExportLimits are export.maxRows and export.maxBytes in force when the rows were read.
type ExportLimits struct{ MaxRows, MaxBytes int }

// renderXLSX writes the projection a report already returns (never an entity) as one flat sheet with
// Vietnamese headers and typed cells, under the lowered budgets and never above the ceilings.
func renderXLSX(result Result, limits ExportLimits) ([]byte, error) {
	switch page := result.(type) {
	case Page[AttendanceRow]:
		return writeSheet("Chấm công", attendanceColumns, page.Rows, limits)
	case Page[LateEarlyRow]:
		return writeSheet("Đi muộn - Về sớm", lateEarlySheetColumns, page.Rows, limits)
	case Page[WfhRow]:
		return writeSheet("WFH", wfhColumns, page.Rows, limits)
	case Page[LeaveRow]:
		return writeSheet("Phép năm", leaveColumns, page.Rows, limits)
	case Page[SeniorityRow]:
		return writeSheet("Thâm niên", seniorityColumns, page.Rows, limits)
	case Page[BirthdayRow]:
		return writeSheet("Sinh nhật", birthdayColumns, page.Rows, limits)
	}
	return nil, errUnknownReport
}

func utf16Units(text string) int {
	units := 0
	for _, r := range text {
		units += utf16.RuneLen(r)
	}
	return units
}

// Rows go through the stream writer: each row is XML in a buffer at once, not a cell tree in memory. Past
// 16 MiB of sheet XML excelize spills to a temp file, which Close removes.
func writeSheet[R any](name string, columns []column[R], rows []R, limits ExportLimits) (content []byte, err error) {
	if len(rows) > min(limits.MaxRows, ExportMaxRows) {
		return nil, errExportTooLarge
	}
	file := excelize.NewFile()
	defer func() {
		if closeErr := file.Close(); closeErr != nil && err == nil {
			content, err = nil, closeErr
		}
	}()
	if err := file.SetSheetName(file.GetSheetName(0), name); err != nil {
		return nil, err
	}
	// The stream writer copies <dimension> when it is created and never updates it.
	last, err := excelize.CoordinatesToCellName(len(columns), len(rows)+1)
	if err != nil {
		return nil, err
	}
	if err := file.SetSheetDimension(name, "A1:"+last); err != nil {
		return nil, err
	}
	stream, err := file.NewStreamWriter(name)
	if err != nil {
		return nil, err
	}
	styles, err := columnStyles(file, columns)
	if err != nil {
		return nil, err
	}
	if err := stream.SetPanes(&excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"}); err != nil {
		return nil, err
	}
	// SetColWidth puts each new <col> before the earlier ones and the stream writer keeps that order, so the
	// widths go from the last column to the first for the ascending order Excel requires.
	for i := len(columns) - 1; i >= 0; i-- {
		if err := stream.SetColWidth(i+1, i+1, columns[i].width); err != nil {
			return nil, err
		}
	}
	header := make([]interface{}, len(columns))
	for i, c := range columns {
		header[i] = excelize.Cell{StyleID: styles.bold, Value: c.header}
	}
	if err := stream.SetRow("A1", header); err != nil {
		return nil, err
	}
	for i, row := range rows {
		values, err := rowValues(columns, styles.formats, row)
		if err != nil {
			return nil, err
		}
		ref, err := excelize.CoordinatesToCellName(1, i+2)
		if err != nil {
			return nil, err
		}
		if err := stream.SetRow(ref, values); err != nil {
			return nil, err
		}
	}
	if err := stream.Flush(); err != nil {
		return nil, err
	}
	buffer, err := file.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	if buffer.Len() > min(limits.MaxBytes, ExportMaxBytes) {
		return nil, errExportTooLarge
	}
	return buffer.Bytes(), nil
}

type sheetStyles struct {
	bold    int
	formats map[string]int
}

func columnStyles[R any](file *excelize.File, columns []column[R]) (sheetStyles, error) {
	bold, err := file.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true}})
	if err != nil {
		return sheetStyles{}, err
	}
	styles := sheetStyles{bold: bold, formats: map[string]int{}}
	for _, c := range columns {
		if _, ok := styles.formats[c.numFmt]; ok || c.numFmt == "" {
			continue
		}
		format := c.numFmt
		if styles.formats[format], err = file.NewStyle(&excelize.Style{CustomNumFmt: &format}); err != nil {
			return sheetStyles{}, err
		}
	}
	return styles, nil
}

// rowValues writes text only as a string value: excelize emits a formula for Cell.Formula alone, which no
// column sets, so a name starting with = + - @ stays text.
func rowValues[R any](columns []column[R], formats map[string]int, row R) ([]interface{}, error) {
	values := make([]interface{}, len(columns))
	for i, c := range columns {
		value := c.value(row)
		switch value.kind {
		case cellEmpty:
		case cellText:
			if utf16Units(value.text) > maxCellUnits {
				return nil, errExportTooLarge
			}
			values[i] = value.text
		case cellNumber:
			values[i] = excelize.Cell{StyleID: formats[c.numFmt], Value: value.number}
		case cellDate:
			day, err := time.Parse(time.DateOnly, value.date)
			if err != nil {
				return nil, err
			}
			values[i] = excelize.Cell{StyleID: formats[c.numFmt], Value: day}
		}
	}
	return values, nil
}
