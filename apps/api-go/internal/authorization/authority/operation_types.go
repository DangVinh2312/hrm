package authority

import (
	"hrm/api-go/internal/audit"
	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/database"
)

type Actor struct{ ID, Kind string }
type Target struct{ Key, ObjectID string }
type Scope struct {
	SQL        string
	Parameters []compiler.Param
}
type QueryContext struct {
	Tx    *database.Tx
	Actor Actor
	Scope Scope
}
type CommandContext struct {
	Tx         *database.Tx
	Actor      Actor
	Permission string
	Target     Target
	Reaches    func(resource, action, key string) (bool, error)
	Audit      func(kind audit.Kind, target AuditTarget, detail *PermissionAuditDetail) error
}
type AuditTarget struct{ Resource, Key, ObjectID string }
type PermissionAuditDetail struct {
	RoleKey         string
	GrantCount      *int
	GrantsDigest    string
	BoundaryKey     string
	BoundaryVersion *int
	TargetUserID    string
}

type operation struct{ pair Probe }
type Operation interface {
	operationRef() *operation
	validOperation() bool
	adminOperation() bool
}

type Query[I, R any] struct {
	self   *Query[I, R]
	op     *operation
	target func(I) string
	run    func(QueryContext, I) (QueryResult[R], error)
}

type QueryResult[R any] struct {
	Found bool
	Value R
}

func NewQuery[I, R any](resource, action string, target func(I) string, run func(QueryContext, I) (QueryResult[R], error)) *Query[I, R] {
	query := &Query[I, R]{op: &operation{pair: Probe{resource, action}}, target: target, run: run}
	query.self = query
	return query
}
func (q *Query[I, R]) operationRef() *operation {
	if q == nil {
		return nil
	}
	return q.op
}
func (q *Query[I, R]) validOperation() bool { return q != nil && q.self == q && q.run != nil }
func (q *Query[I, R]) adminOperation() bool { return false }

type Command[I, R any] struct {
	self   *Command[I, R]
	op     *operation
	mode   database.Mode
	target func(I) string
	run    func(CommandContext, I) (R, error)
}

func NewCommand[I, R any](resource, action string, mode database.Mode, target func(I) string, run func(CommandContext, I) (R, error)) *Command[I, R] {
	command := &Command[I, R]{op: &operation{pair: Probe{resource, action}}, mode: mode, target: target, run: run}
	command.self = command
	return command
}
func (c *Command[I, R]) operationRef() *operation {
	if c == nil {
		return nil
	}
	return c.op
}
func (c *Command[I, R]) validOperation() bool {
	return c != nil && c.self == c && c.run != nil && c.target != nil && (c.mode == database.ModeWrite || c.mode == database.ModeAdmin)
}
func (c *Command[I, R]) adminOperation() bool { return c.mode == database.ModeAdmin }
