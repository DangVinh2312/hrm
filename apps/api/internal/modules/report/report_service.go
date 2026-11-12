package report

import (
	"context"
	"strconv"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/keys"
)

type reader func(authority.QueryContext, Query) (Result, error)

// actions is the permission action of each report; an export has no action of its own.
var actions = map[Kind]keys.ReportAction{
	KindAttendance: keys.ReportActionAttendance,
	KindLateEarly:  keys.ReportActionLateEarly,
	KindWfh:        keys.ReportActionWfh,
	KindBirthday:   keys.ReportActionBirthday,
	KindLeave:      keys.ReportActionLeave,
	KindSeniority:  keys.ReportActionSeniority,
}

var readers = map[Kind]reader{
	KindAttendance: readAttendance,
	KindLateEarly:  readLateEarly,
	KindWfh:        readWfh,
	KindBirthday:   readBirthday,
	KindLeave:      readLeave,
	KindSeniority:  readSeniority,
}

// Operations are the report queries, to register with authority.New: per report one page query and one
// export query on the same action, so an export is scoped by the report's own plan.
type Operations struct {
	pages   map[Kind]*authority.Query[Query, Result]
	exports map[Kind]*authority.Query[ExportQuery, exportData]
}

func NewOperations() *Operations {
	o := &Operations{pages: map[Kind]*authority.Query[Query, Result]{}, exports: map[Kind]*authority.Query[ExportQuery, exportData]{}}
	employee := string(keys.EmployeeResourceEmployee)
	for _, kind := range kinds {
		read := readers[kind]
		o.pages[kind] = authority.NewQuery(employee, string(actions[kind]), nil, func(c authority.QueryContext, q Query) (authority.QueryResult[Result], error) {
			result, err := read(c, q)
			return authority.QueryResult[Result]{Found: err == nil, Value: result}, err
		})
		o.exports[kind] = authority.NewQuery(employee, string(actions[kind]), nil, readExport(read))
	}
	return o
}

func (o *Operations) All() []authority.Operation {
	all := make([]authority.Operation, 0, 2*len(kinds))
	for _, kind := range kinds {
		all = append(all, o.pages[kind], o.exports[kind])
	}
	return all
}

// Service is the report operations bound to the authority.
type Service struct {
	authorization *authority.Authorization
	operations    *Operations
}

func (o *Operations) Bind(a *authority.Authorization) *Service {
	return &Service{authorization: a, operations: o}
}

// ExportedReport is a rendered report ready to deliver; FileName is fixed by the report and its range.
type ExportedReport struct {
	FileName    string
	ContentType string
	Content     []byte
}

// Query is one page of a report. A caller with no grant reads an empty page (total "0"), not a status that
// tells absent from foreign.
func (s *Service) Query(ctx context.Context, secret string, input Query) (Result, error) {
	query, ok := s.operations.pages[input.Kind]
	if !ok {
		return nil, apperror.ErrInvalidRequest
	}
	result, err := authority.Read(ctx, s.authorization, secret, query, input)
	return result.Value, err
}

// Export is the XLSX of one report: the same reader and scope as the page with the page set to the row
// budget, more rows than export.maxRows refused (422), never cut. Outside the transaction the file is rendered,
// then the caller is authorized again, so a grant revoked while the file was built, or no grant at all, is 403
// instead of a file. The bool (delivered) is false when the client has gone between steps (ctx done): the remaining steps
// are skipped and nothing is stored. The runner ignores the request's cancellation, so ctx is only checked
// between steps.
// shortcut: a revoke between the re-check and the last byte sent cannot be fenced, and the re-check only proves
// the plan still reaches some row; a scope that narrowed during the render still delivers the rows read before.
func (s *Service) Export(ctx context.Context, secret string, input ExportQuery) (ExportedReport, bool, error) {
	query, ok := s.operations.exports[input.Kind]
	if !ok {
		return ExportedReport{}, false, apperror.ErrInvalidRequest
	}
	read, err := authority.Read(ctx, s.authorization, secret, query, input)
	if err != nil {
		return ExportedReport{}, false, err
	}
	data := read.Value
	total, err := strconv.ParseInt(data.result.count(), 10, 64)
	if err != nil {
		return ExportedReport{}, false, err
	}
	if total > int64(data.limits.MaxRows) {
		return ExportedReport{}, false, errExportTooLarge
	}
	if gone(ctx) {
		return ExportedReport{}, false, nil
	}
	content, err := renderXLSX(data.result, data.limits)
	if err != nil {
		return ExportedReport{}, false, err
	}
	if gone(ctx) {
		return ExportedReport{}, false, nil
	}
	permitted, err := s.authorization.Permits(ctx, secret, string(keys.EmployeeResourceEmployee), string(actions[input.Kind]))
	if err != nil {
		return ExportedReport{}, false, err
	}
	if !permitted {
		return ExportedReport{}, false, apperror.ErrAccessDenied
	}
	if gone(ctx) {
		return ExportedReport{}, false, nil
	}
	return ExportedReport{FileName: exportFileName(input), ContentType: XLSXMime, Content: content}, true, nil
}

func gone(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return true
	default:
		return false
	}
}
