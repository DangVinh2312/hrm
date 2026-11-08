// Package gateway executes bounded read queries (List, Count, Detail) under an authorized plan
// inside a fenced database transaction.
package gateway

import "hrm/api-go/internal/authorization/core"

const (
	DefaultLimit   = 20
	MaxLimit       = 100
	MaxOffset      = 10_000
	MaxFilterNodes = 32
)

type SortDirection string

const (
	SortAsc  SortDirection = "asc"
	SortDesc SortDirection = "desc"
)

type Row map[string]core.FieldValue

type Page struct {
	Items []Row
	Total string
}

type Filter interface {
	isFilter()
}

type LogicalFilter struct {
	Op   core.LogicalOp
	Args []Filter
}

func (LogicalFilter) isFilter() {}

type CompareFilter struct {
	Op    core.CompareOp
	Field string
	Value core.FieldValue
}

func (CompareFilter) isFilter() {}

type IsNullFilter struct {
	Field string
}

func (IsNullFilter) isFilter() {}

type ListQuery struct {
	Filter    Filter
	OrderBy   string
	Direction SortDirection
	Limit     *int
	Offset    int
}

type CountQuery struct {
	Filter Filter
}

func Limit(n int) *int {
	return &n
}
