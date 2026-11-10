package report

import "context"

// HTTPPort is the bound report operations; Export answers delivered=false when the client has gone.
type HTTPPort interface {
	Query(ctx context.Context, secret string, input Query) (Result, error)
	Export(ctx context.Context, secret string, input ExportQuery) (ExportedReport, bool, error)
}
