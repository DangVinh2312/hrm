package authority

import (
	"encoding/json"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
)

const factsColumns = `
  (SELECT json_build_object('id',id,'state',state) FROM app_user WHERE id=s.user_id),
  ARRAY(SELECT convert_from(role_key,'UTF8') FROM user_role WHERE user_id=s.user_id ORDER BY role_key),
  (SELECT COALESCE(json_agg(json_build_object('key',convert_from(permission_key,'UTF8'),'resource',convert_from(type_key,'UTF8'),'action',convert_from(action_key,'UTF8'),'policy_key',convert_from(policy_key,'UTF8'),'policy_version',policy_version,'lifecycle',lifecycle,'boundary',boundary_requirement)),'[]')
    FROM permission_catalog WHERE permission_key=ANY(k.keys)),
  (SELECT COALESCE(json_agg(json_build_object('id',rule_id,'permission',convert_from(permission_key,'UTF8'),'user_id',user_id,'role',convert_from(role_key,'UTF8'),'effect',effect,'template',convert_from(template_key,'UTF8'),'version',template_version,'parameters',parameters) ORDER BY rule_id),'[]')
    FROM policy_rule WHERE permission_key=ANY(k.keys) AND (user_id=s.user_id OR role_key IN(SELECT role_key FROM user_role WHERE user_id=s.user_id))),
  (SELECT COALESCE(json_agg(json_build_object('permission',convert_from(b.permission_key,'UTF8'),'key',convert_from(b.boundary_key,'UTF8'),'version',b.boundary_version,'lifecycle',d.lifecycle)),'[]')
    FROM user_boundary b JOIN permission_boundary d USING(boundary_key,boundary_version) WHERE b.user_id=s.user_id AND b.permission_key=ANY(k.keys))`

const factKeys = `(SELECT ARRAY(SELECT convert_to(p,'UTF8') FROM unnest(CAST($2 AS text[])) p) keys) k`

const sessionColumns = `s.user_id::text,s.kind,s.assurance,` + credential.FreshAuthSQL + `,
to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
to_char(LEAST(s.expires_at,statement_timestamp()+interval '2 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

type session struct {
	userID    core.IdentityID
	kind      string
	assurance string
	fresh     bool
	now       string
	deadline  string
}

type permissionRow struct {
	Key           string
	Resource      string
	Action        string
	PolicyKey     string `json:"policy_key"`
	PolicyVersion int    `json:"policy_version"`
	Lifecycle     core.Lifecycle
	Boundary      core.BoundaryRequirement
}
type ruleRow struct {
	ID         string
	Permission string
	UserID     *core.IdentityID `json:"user_id"`
	Role       *string
	Effect     core.Effect
	Template   string
	Version    int
	Parameters map[string]json.RawMessage
}
type boundaryRow struct {
	Permission string
	Key        string
	Version    int
	Lifecycle  core.Lifecycle
}
type facts struct {
	user        *core.AuthorityUser
	roles       []string
	permissions []permissionRow
	rules       []ruleRow
	boundaries  []boundaryRow
}

func scanFacts(row pgx.CollectableRow, s *session) (facts, error) {
	var f facts
	var user, permissions, rules, boundaries []byte
	dest := []any{&user, &f.roles, &permissions, &rules, &boundaries}
	if s != nil {
		dest = append([]any{&s.userID, &s.kind, &s.assurance, &s.fresh, &s.now, &s.deadline}, dest...)
	}
	if err := row.Scan(dest...); err != nil {
		return f, err
	}
	if err := json.Unmarshal(user, &f.user); err != nil {
		return f, err
	}
	if err := json.Unmarshal(permissions, &f.permissions); err != nil {
		return f, err
	}
	if err := json.Unmarshal(rules, &f.rules); err != nil {
		return f, err
	}
	if err := json.Unmarshal(boundaries, &f.boundaries); err != nil {
		return f, err
	}
	return f, nil
}

func (a *Authorization) readSession(tx *database.Tx, secret string, pairs []Probe) (session, facts, error) {
	var s session
	digest, err := credential.SessionDigest(secret)
	if err != nil {
		return s, facts{}, err
	}
	permissions := make([]string, len(pairs))
	for i, pair := range pairs {
		permissions[i] = pair.Resource + "." + pair.Action
	}
	slices.Sort(permissions)
	permissions = slices.Compact(permissions)
	rows, err := tx.Query(`SELECT `+sessionColumns+`,`+factsColumns+` FROM (SELECT user_id,kind,state,auth_epoch,method,assurance,authenticated_at,reauthenticated_at,expires_at FROM public.resolve_session($1) LIMIT 1) s, `+factKeys, digest, permissions)
	if err != nil {
		return s, facts{}, err
	}
	found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (facts, error) { return scanFacts(row, &s) })
	if err != nil {
		return s, facts{}, err
	}
	if len(found) != 1 || !a.bindings.Core().IsCanonicalUUID(string(s.userID)) || (s.kind != "iam" && s.kind != "root") {
		return s, facts{}, apperror.ErrAuthenticationFailed
	}
	return s, found[0], nil
}

func (a *Authorization) readFacts(tx *database.Tx, s session, permission string) (facts, error) {
	rows, err := tx.Query(`SELECT `+factsColumns+` FROM (SELECT CAST($1 AS uuid) user_id) s, `+factKeys, string(s.userID), []string{permission})
	if err != nil {
		return facts{}, err
	}
	found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (facts, error) { return scanFacts(row, nil) })
	if err != nil {
		return facts{}, err
	}
	if len(found) != 1 {
		return facts{}, errors.New("authority statement returned no row")
	}
	return found[0], nil
}

func (a *Authorization) snapshot(tx *database.Tx, s session, f facts, permission string) (core.AuthoritySnapshot, error) {
	snapshot := core.AuthoritySnapshot{Revision: tx.Revision, Declarations: a.bindings.Declarations(), Registry: a.registry, User: f.user, Roles: f.roles}
	for _, p := range f.permissions {
		if p.Key == permission {
			snapshot.Permissions = append(snapshot.Permissions, core.PermissionFact{Key: p.Key, Resource: p.Resource, Action: p.Action, Policy: core.RelationRef{Key: p.PolicyKey, Version: p.PolicyVersion}, Lifecycle: p.Lifecycle, Boundary: p.Boundary})
		}
	}
	for _, r := range f.rules {
		if r.Permission != permission {
			continue
		}
		parameters := make(map[string]core.Scalar, len(r.Parameters))
		for key, raw := range r.Parameters {
			var text string
			var flag bool
			if err := json.Unmarshal(raw, &text); err == nil && string(raw) != "null" {
				parameters[key] = core.Text(text)
			} else if err := json.Unmarshal(raw, &flag); err == nil && string(raw) != "null" {
				parameters[key] = core.Bool(flag)
			} else {
				return snapshot, errors.New("invalid authority scalar")
			}
		}
		subject := core.RuleSubject{}
		if r.UserID != nil && r.Role == nil {
			subject = core.RuleSubject{Kind: core.SubjectIdentity, Identity: *r.UserID}
		} else if r.Role != nil && r.UserID == nil {
			subject = core.RuleSubject{Kind: core.SubjectRole, Role: *r.Role}
		}
		snapshot.Rules = append(snapshot.Rules, core.RuleFact{ID: r.ID, Permission: r.Permission, Subject: subject, Effect: r.Effect, Template: core.RelationRef{Key: r.Template, Version: r.Version}, Parameters: parameters})
	}
	for _, b := range f.boundaries {
		if b.Permission == permission {
			snapshot.Boundaries = append(snapshot.Boundaries, core.BoundaryBindingFact{Identity: s.userID, Permission: b.Permission, Boundary: core.RelationRef{Key: b.Key, Version: b.Version}, Lifecycle: b.Lifecycle})
		}
	}
	return snapshot, nil
}
