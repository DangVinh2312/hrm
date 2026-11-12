package report

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var codePoint = regexp.MustCompile(`\{([0-9a-f]+)\}`)

// vi writes non-ASCII text as {hex} code points, so the expected Vietnamese stays ASCII in this file.
func vi(text string) string {
	return codePoint.ReplaceAllStringFunc(text, func(match string) string {
		point, err := strconv.ParseUint(match[1:len(match)-1], 16, 32)
		if err != nil {
			panic(err)
		}
		return string(rune(point))
	})
}

type rawCell struct {
	Ref string `xml:"r,attr"`
	S   int    `xml:"s,attr"`
	T   string `xml:"t,attr"`
	F   *struct {
		Text string `xml:",chardata"`
	} `xml:"f"`
	V  string `xml:"v"`
	IS *struct {
		T string `xml:"t"`
		R []struct {
			T string `xml:"t"`
		} `xml:"r"`
	} `xml:"is"`
}

type rawSheet struct {
	Dimension struct {
		Ref string `xml:"ref,attr"`
	} `xml:"dimension"`
	Views []struct {
		Pane *struct {
			YSplit      string `xml:"ySplit,attr"`
			TopLeftCell string `xml:"topLeftCell,attr"`
			State       string `xml:"state,attr"`
		} `xml:"pane"`
	} `xml:"sheetViews>sheetView"`
	Cols []struct {
		Min   int     `xml:"min,attr"`
		Max   int     `xml:"max,attr"`
		Width float64 `xml:"width,attr"`
	} `xml:"cols>col"`
	Rows []struct {
		R     int       `xml:"r,attr"`
		Cells []rawCell `xml:"c"`
	} `xml:"sheetData>row"`
}

type rawStyles struct {
	NumFmts []struct {
		ID   int    `xml:"numFmtId,attr"`
		Code string `xml:"formatCode,attr"`
	} `xml:"numFmts>numFmt"`
	Fonts []struct {
		B *struct {
			Val string `xml:"val,attr"`
		} `xml:"b"`
	} `xml:"fonts>font"`
	Xfs []struct {
		NumFmtID int `xml:"numFmtId,attr"`
		FontID   int `xml:"fontId,attr"`
	} `xml:"cellXfs>xf"`
}

// workbook is a file read from its zip parts with encoding/xml only, so a blind spot of the writer is not
// shared by the reader.
type workbook struct {
	sheets   []string
	sheetXML string
	sheet    rawSheet
	styles   rawStyles
	shared   []string
}

// cell is "s:<text>" for a string cell, "n:<number>" for a numeric one, "f:<formula>" for a formula, then
// "|<numFmt>" when the style has a format, "|b" when the font is bold; "" is an absent cell.
func (w workbook) cell(t *testing.T, c rawCell) string {
	t.Helper()
	var value string
	switch {
	case c.F != nil:
		value = "f:" + c.F.Text
	case c.T == "inlineStr" && c.IS != nil:
		text := c.IS.T
		for _, run := range c.IS.R {
			text += run.T
		}
		value = "s:" + text
	case c.T == "s":
		index, err := strconv.Atoi(c.V)
		if err != nil || index >= len(w.shared) {
			t.Fatalf("shared string %q of %d", c.V, len(w.shared))
		}
		value = "s:" + w.shared[index]
	case c.T == "" || c.T == "n":
		value = "n:" + c.V
	default:
		value = c.T + ":" + c.V
	}
	if c.S >= len(w.styles.Xfs) {
		t.Fatalf("style %d of %d", c.S, len(w.styles.Xfs))
	}
	xf := w.styles.Xfs[c.S]
	if xf.NumFmtID != 0 {
		format := "#" + strconv.Itoa(xf.NumFmtID)
		for _, custom := range w.styles.NumFmts {
			if custom.ID == xf.NumFmtID {
				format = custom.Code
			}
		}
		value += "|" + format
	}
	if bold := w.styles.Fonts[xf.FontID].B; bold != nil && bold.Val != "0" && bold.Val != "false" {
		value += "|b"
	}
	return value
}

func columnIndex(t *testing.T, ref string) int {
	t.Helper()
	index := 0
	for _, r := range ref {
		if r < 'A' || r > 'Z' {
			break
		}
		index = index*26 + int(r-'A'+1)
	}
	if index == 0 {
		t.Fatalf("cell reference %q", ref)
	}
	return index - 1
}

// grid is every row of the sheet, each cell as cell() writes it.
func (w workbook) grid(t *testing.T) [][]string {
	t.Helper()
	rows := make([][]string, len(w.sheet.Rows))
	for i, row := range w.sheet.Rows {
		if row.R != i+1 {
			t.Fatalf("row %d at position %d", row.R, i+1)
		}
		for _, c := range row.Cells {
			index := columnIndex(t, c.Ref)
			for len(rows[i]) <= index {
				rows[i] = append(rows[i], "")
			}
			rows[i][index] = w.cell(t, c)
		}
	}
	return rows
}

func unmarshalPart(t *testing.T, parts map[string][]byte, name string, into any) {
	t.Helper()
	data, ok := parts[name]
	if !ok {
		t.Fatalf("no part %s", name)
	}
	if err := xml.Unmarshal(data, into); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func readWorkbook(t *testing.T, content []byte) workbook {
	t.Helper()
	archive, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	parts := map[string][]byte{}
	var sheets []string
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		if closeErr := reader.Close(); err != nil || closeErr != nil {
			t.Fatal(err, closeErr)
		}
		parts[file.Name] = data
		if strings.HasPrefix(file.Name, "xl/worksheets/") && strings.HasSuffix(file.Name, ".xml") {
			sheets = append(sheets, file.Name)
		}
	}
	if len(sheets) != 1 {
		t.Fatalf("worksheet parts %v", sheets)
	}
	var w workbook
	var book struct {
		Sheets []struct {
			Name string `xml:"name,attr"`
		} `xml:"sheets>sheet"`
	}
	unmarshalPart(t, parts, "xl/workbook.xml", &book)
	for _, sheet := range book.Sheets {
		w.sheets = append(w.sheets, sheet.Name)
	}
	w.sheetXML = string(parts[sheets[0]])
	unmarshalPart(t, parts, sheets[0], &w.sheet)
	// ECMA-376 CT_Cols: <col> ranges ascend and do not overlap; Excel may call the file corrupt otherwise.
	for i, col := range w.sheet.Cols {
		if col.Min < 1 || col.Max < col.Min || (i > 0 && col.Min <= w.sheet.Cols[i-1].Max) {
			t.Fatalf("<col> %d is %d..%d after %+v", i, col.Min, col.Max, w.sheet.Cols[:i])
		}
	}
	unmarshalPart(t, parts, "xl/styles.xml", &w.styles)
	if _, ok := parts["xl/sharedStrings.xml"]; ok {
		var shared struct {
			Items []struct {
				T string `xml:"t"`
			} `xml:"si"`
		}
		unmarshalPart(t, parts, "xl/sharedStrings.xml", &shared)
		for _, item := range shared.Items {
			w.shared = append(w.shared, item.T)
		}
	}
	return w
}
