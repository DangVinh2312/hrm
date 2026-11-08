//go:build integration

package gateway_test

import (
	"bytes"
	"context"
	"fmt"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/authorization/compiler"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/test"
)

const fixtureDDL = `
CREATE TABLE site (
  id uuid PRIMARY KEY,
  object_id uuid UNIQUE NOT NULL REFERENCES object_ref (object_id),
  name text NOT NULL
);
CREATE TABLE submission (
  id bigint PRIMARY KEY,
  object_id uuid UNIQUE NOT NULL REFERENCES object_ref (object_id),
  status text NOT NULL,
  amount numeric(20, 4) NOT NULL,
  title text,
  priority integer,
  submitted_at timestamptz(6) NOT NULL,
  archived boolean NOT NULL,
  internal_note text NOT NULL
);
CREATE TABLE tag (
  code text PRIMARY KEY,
  object_id uuid UNIQUE NOT NULL REFERENCES object_ref (object_id),
  label text NOT NULL
);
CREATE TABLE site_manager (
  site_id uuid NOT NULL REFERENCES site (id),
  user_id uuid NOT NULL REFERENCES app_user (id),
  starts_at timestamptz(6) NOT NULL,
  expires_at timestamptz(6),
  PRIMARY KEY (site_id, user_id)
);
CREATE INDEX ix_site_manager_user ON site_manager (user_id);
`

func findFixtureSite(f productFixture, id string) siteRow {
	for _, s := range f.sites {
		if s.id == id {
			return s
		}
	}
	panic("unknown fixture site " + id)
}

func submissionObject(row submissionRow) core.FactObject {
	titleVal := core.NullValue()
	if row.title != nil {
		titleVal = core.TextValue(*row.title)
	}
	prioVal := core.NullValue()
	if row.priority != nil {
		prioVal = core.TextValue(*row.priority)
	}
	return core.FactObject{
		Type:     "submission",
		Key:      core.Key{Kind: core.KeyInteger, Value: row.id},
		ObjectID: row.objectID,
		Fields: map[string]core.FieldValue{
			"status":      core.TextValue(row.status),
			"amount":      core.TextValue(row.amount),
			"title":       titleVal,
			"priority":    prioVal,
			"submittedAt": core.TextValue(row.submittedAt),
			"archived":    core.BoolValue(row.archived),
		},
	}
}

func submissionFacts(fixture productFixture, row submissionRow, nowTS string) core.CompleteFacts {
	record := submissionObject(row)
	objects := make([]core.FactObject, 0, len(fixture.sites)+1)
	objects = append(objects, record)
	for _, s := range fixture.sites {
		objects = append(objects, core.FactObject{
			Type:     "site",
			Key:      core.Key{Kind: core.KeyUUID, Value: s.id},
			ObjectID: s.objectID,
			Fields:   map[string]core.FieldValue{"name": core.TextValue(s.name)},
		})
	}
	var edges []core.EdgeFact
	for _, siteID := range row.sites {
		site := findFixtureSite(fixture, siteID)
		edges = append(edges, core.EdgeFact{
			Relation: core.RelationRef{Key: "submission.site", Version: 1},
			Source:   row.objectID,
			Target:   core.EdgeTarget{Kind: core.EdgeTargetObject, ObjectID: site.objectID},
			StartsAt: pastInstant,
		})
	}
	for _, a := range row.assignees {
		edges = append(edges, core.EdgeFact{
			Relation:  core.RelationRef{Key: "submission.assignee", Version: 1},
			Source:    row.objectID,
			Target:    core.EdgeTarget{Kind: core.EdgeTargetIdentity, Identity: a.identity},
			StartsAt:  a.startsAt,
			ExpiresAt: a.expiresAt,
		})
	}
	for _, s := range fixture.sites {
		for _, m := range s.managers {
			edges = append(edges, core.EdgeFact{
				Relation:  core.RelationRef{Key: "site.manager", Version: 1},
				Source:    s.objectID,
				Target:    core.EdgeTarget{Kind: core.EdgeTargetIdentity, Identity: m.identity},
				StartsAt:  m.startsAt,
				ExpiresAt: m.expiresAt,
			})
		}
	}
	return core.CompleteFacts{
		Now:        nowTS,
		Record:     record,
		Objects:    objects,
		Edges:      edges,
		Exceptions: slices.Clone(fixture.exceptions),
	}
}

func seedProduct(t *testing.T, ctx context.Context, conn *pgx.Conn, fixture productFixture) {
	t.Helper()
	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed exec failed (%s): %s", sql, test.Redact(err))
		}
	}
	mustExec(fixtureDDL)
	for _, pair := range [][2]string{
		{"submission", "integer"},
		{"site", "uuid"},
		{"tag", "string"},
	} {
		mustExec(`INSERT INTO resource_type VALUES ($1, $2, $1) ON CONFLICT DO NOTHING`, []byte(pair[0]), pair[1])
	}
	hash := bytes.Repeat([]byte{7}, 32)
	mustExec(
		`INSERT INTO permission_policy VALUES ($1, 1, $2, '{}', 'active'), ($3, 1, $2, '{}', 'active') ON CONFLICT DO NOTHING`,
		[]byte("baseline"), hash, []byte("approval"),
	)
	for _, row := range [][4]string{
		{"submission.read", "submission", "read", "baseline"},
		{"submission.approve", "submission", "approve", "approval"},
		{"site.read", "site", "read", "baseline"},
		{"tag.read", "tag", "read", "baseline"},
	} {
		mustExec(
			`INSERT INTO permission_catalog VALUES ($1, $2, $3, $4, 1, 'active', 'optional') ON CONFLICT DO NOTHING`,
			[]byte(row[0]), []byte(row[1]), []byte(row[2]), []byte(row[3]),
		)
	}
	for _, tmpl := range fullDeclarationsSource().Templates {
		mustExec(`INSERT INTO scope_template VALUES ($1, 1, $2) ON CONFLICT DO NOTHING`, []byte(tmpl.Key), hash)
	}
	for _, role := range []string{"custom.reviewer", "custom.manager"} {
		mustExec(`INSERT INTO role_definition VALUES ($1, 'runtime', $2) ON CONFLICT DO NOTHING`, []byte(role), role)
	}
	for _, u := range []core.IdentityID{alice, bob, carol} {
		mustExec(`INSERT INTO app_user (id, state) VALUES ($1, 'active') ON CONFLICT DO NOTHING`, string(u))
	}
	mustExec(`INSERT INTO user_role VALUES ($1, $2) ON CONFLICT DO NOTHING`, string(alice), []byte("custom.reviewer"))
	mustExec(
		`INSERT INTO resource_relation_definition VALUES ($1, 1, $2, $3, 'edgeStore', $1, $4, 'active') ON CONFLICT DO NOTHING`,
		[]byte("submission.site"), []byte("submission"), []byte("site"), hash,
	)

	insertObjectRef := func(id, typ, kind, key string) {
		mustExec(`INSERT INTO object_ref VALUES ($1, $2, $3, $4)`, id, []byte(typ), kind, []byte(key))
	}
	for _, site := range fixture.sites {
		insertObjectRef(site.objectID, "site", "uuid", site.id)
		mustExec(`INSERT INTO site VALUES ($1, $2, $3)`, site.id, site.objectID, site.name)
		for _, m := range site.managers {
			mustExec(`INSERT INTO site_manager VALUES ($1, $2, $3, $4)`, site.id, string(m.identity), m.startsAt, m.expiresAt)
		}
	}
	for _, row := range fixture.submissions {
		insertObjectRef(row.objectID, "submission", "integer", row.id)
		mustExec(
			`INSERT INTO submission VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			row.id, row.objectID, row.status, row.amount, row.title, row.priority, row.submittedAt, row.archived, row.internalNote,
		)
		for _, siteID := range row.sites {
			site := findFixtureSite(fixture, siteID)
			mustExec(
				`INSERT INTO relation_edge (relation_key, relation_version, source_object, source_type, target_object, target_type, starts_at)
				 VALUES ($1, 1, $2, $3, $4, $5, $6)`,
				[]byte("submission.site"), row.objectID, []byte("submission"), site.objectID, []byte("site"), pastInstant,
			)
		}
		for _, a := range row.assignees {
			mustExec(
				`INSERT INTO user_relation (relation_key, relation_version, object_id, user_id, starts_at, expires_at)
				 VALUES ($1, 1, $2, $3, $4, $5)`,
				[]byte("submission.assignee"), row.objectID, string(a.identity), a.startsAt, a.expiresAt,
			)
		}
	}
	for _, tag := range fixture.tags {
		insertObjectRef(tag.objectID, "tag", "string", tag.code)
		mustExec(`INSERT INTO tag VALUES ($1, $2, $3)`, tag.code, tag.objectID, tag.label)
	}
	for _, exc := range fixture.exceptions {
		var userID *string
		var roleKey []byte
		if exc.Subject.Kind == core.SubjectIdentity {
			id := string(exc.Subject.Identity)
			userID = &id
		} else {
			roleKey = []byte(exc.Subject.Role)
		}
		mustExec(
			`INSERT INTO record_exception (exception_id, object_id, type_key, permission_key, user_id,
			   role_key, effect, purpose, starts_at, expires_at, reason, issued_by, revoked_at)
			 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'fixture', $10, $11)`,
			exc.ObjectID, []byte("submission"), []byte(exc.Permission), userID, roleKey,
			string(exc.Effect), string(exc.Purpose), exc.StartsAt, exc.ExpiresAt, string(alice), exc.RevokedAt,
		)
	}
	mustExec(`GRANT SELECT ON site, submission, tag, site_manager TO product_data`)
}

type planOptions struct {
	resource   string
	action     string
	roles      []string
	hasRoles   bool
	identity   core.IdentityID
	validUntil string
	revision   string
}

func readPlan(t *testing.T, rules []core.RuleFact, opts planOptions) *core.AuthorizedPlan {
	t.Helper()
	nowTime := time.Now().UTC()
	id := opts.identity
	if id == "" {
		id = alice
	}
	res := opts.resource
	if res == "" {
		res = "submission"
	}
	act := opts.action
	if act == "" {
		act = "read"
	}
	until := opts.validUntil
	if until == "" {
		until = nowTime.Add(time.Hour).Format("2006-01-02T15:04:05.000000Z")
	}
	rev := opts.revision
	if rev == "" {
		rev = "1"
	}
	roles := []string{"custom.reviewer"}
	if opts.hasRoles {
		roles = opts.roles
	}
	baseline := core.RelationRef{Key: "baseline", Version: 1}
	in := core.TrustedInput{
		Principal:  core.TrustedPrincipal{ID: id, Assurance: 2},
		Resource:   res,
		Action:     act,
		Context:    map[string]core.Scalar{},
		Now:        nowTime.Format("2006-01-02T15:04:05.000000Z"),
		ValidUntil: until,
	}
	snap := core.AuthoritySnapshot{
		Revision:     rev,
		Declarations: fixtureDeclarations(t),
		User:         &core.AuthorityUser{ID: id, State: core.UserActive},
		Roles:        roles,
		Permissions: []core.PermissionFact{
			{Key: "submission.read", Resource: "submission", Action: "read", Policy: baseline, Boundary: core.BoundaryOptional, Lifecycle: core.LifecycleActive},
			{Key: "submission.approve", Resource: "submission", Action: "approve", Policy: core.RelationRef{Key: "approval", Version: 1}, Boundary: core.BoundaryOptional, Lifecycle: core.LifecycleActive},
			{Key: "site.read", Resource: "site", Action: "read", Policy: baseline, Boundary: core.BoundaryOptional, Lifecycle: core.LifecycleActive},
			{Key: "tag.read", Resource: "tag", Action: "read", Policy: baseline, Boundary: core.BoundaryOptional, Lifecycle: core.LifecycleActive},
		},
		Rules:      rules,
		Boundaries: []core.BoundaryBindingFact{},
		Registry: core.Registry{
			Validators:         map[string]core.ContextValidator{},
			ObligationHandlers: []string{},
		},
	}
	decision := integrationCore.Plan(in, snap)
	if !decision.Allowed() {
		t.Fatalf("fixture plan denied: %s", decision.Reason())
	}
	return decision.Plan()
}

var ruleSeq int

func makeRule(permission string, effect core.Effect, template string, params map[string]core.Scalar, subject *core.RuleSubject) core.RuleFact {
	ruleSeq++
	if params == nil {
		params = map[string]core.Scalar{}
	}
	subj := core.RuleSubject{Kind: core.SubjectRole, Role: "custom.reviewer"}
	if subject != nil {
		subj = *subject
	}
	return core.RuleFact{
		ID:         fmt.Sprintf("r%d", ruleSeq),
		Permission: permission,
		Subject:    subj,
		Effect:     effect,
		Template:   core.RelationRef{Key: template, Version: 1},
		Parameters: params,
	}
}

func queryParams(params []compiler.Param) []any {
	args := make([]any, len(params))
	for i, p := range params {
		switch p.Kind() {
		case compiler.ParamText:
			v, _ := p.AsText()
			args[i] = v
		case compiler.ParamBool:
			v, _ := p.AsBool()
			args[i] = v
		case compiler.ParamInt:
			v, _ := p.AsInt()
			args[i] = v
		case compiler.ParamBytes:
			v, _ := p.AsBytes()
			args[i] = v
		}
	}
	return args
}

func compareBigIntStrings(a, b string) int {
	na, errA := strconv.ParseInt(a, 10, 64)
	nb, errB := strconv.ParseInt(b, 10, 64)
	if errA != nil || errB != nil {
		panic("non-int64 submission id")
	}
	if na < nb {
		return -1
	}
	if na > nb {
		return 1
	}
	return 0
}
