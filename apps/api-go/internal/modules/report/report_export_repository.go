package report

import (
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/modules/settingcore"
)

// exportData is the scoped rows of an export with the budget in force when they were read.
type exportData struct {
	result Result
	limits ExportLimits
}

// readExport reads export.maxRows and export.maxBytes, then runs the report's own reader in the same
// transaction with the page set to the row budget: no second statement for the data, no second plan.
func readExport(read reader) func(authority.QueryContext, ExportQuery) (authority.QueryResult[exportData], error) {
	return func(c authority.QueryContext, input ExportQuery) (authority.QueryResult[exportData], error) {
		var none authority.QueryResult[exportData]
		budget, err := settingcore.Read(c.Tx, []settingcore.Key{settingcore.KeyExportMaxRows, settingcore.KeyExportMaxBytes})
		if err != nil {
			return none, err
		}
		limits := ExportLimits{MaxRows: int(budget[settingcore.KeyExportMaxRows].Int), MaxBytes: int(budget[settingcore.KeyExportMaxBytes].Int)}
		result, err := read(c, Query{ExportQuery: input, Limit: limits.MaxRows})
		if err != nil {
			return none, err
		}
		return authority.QueryResult[exportData]{Found: true, Value: exportData{result: result, limits: limits}}, nil
	}
}
