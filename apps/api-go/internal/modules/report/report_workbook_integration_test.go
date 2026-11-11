//go:build integration

package report

import "testing"

// WorkbookGrid and Vi lend the zip/XML reader of the renderer tests to the integration tests of report_test.
func WorkbookGrid(t *testing.T, content []byte) [][]string { return readWorkbook(t, content).grid(t) }

var Vi = vi
