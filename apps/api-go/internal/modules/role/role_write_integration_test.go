//go:build integration

package role

import (
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/grant"
	"hrm/api-go/test"
)

const (
	writeRules = `SELECT rule_id::text, convert_from(permission_key,'UTF8') FROM policy_rule
       WHERE role_key=convert_to($1,'UTF8') ORDER BY 2`
	writeLabel    = `SELECT coalesce((SELECT label FROM role_definition WHERE role_key=convert_to($1,'UTF8')),'')`
	writeRevision = `SELECT revision FROM authz_state WHERE singleton`
	writeEvents   = `SELECT actor_id::text, coalesce(convert_from(permission_key,'UTF8'),''), policy_revision,
              coalesce(safe_metadata->>'grantCount',''), coalesce(safe_metadata->>'grantsDigest','')
         FROM audit_outbox WHERE event_kind=convert_to($1,'UTF8') AND safe_metadata->>'roleKey'=$2
        ORDER BY policy_revision`
)

type writtenRule struct{ ID, Permission string }

type roleEvent struct {
	Actor, Permission string
	// Revision is policy_revision: the revision the command was decided under, one below the one it commits.
	Revision      int64
	Count, Digest string
}

func (f *commandFixture) stored(t *testing.T, key string) []writtenRule {
	t.Helper()
	rows, err := f.conn.Query(t.Context(), writeRules, key)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[writtenRule])
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return found
}

func (f *commandFixture) events(t *testing.T, kind, key string) []roleEvent {
	t.Helper()
	rows, err := f.conn.Query(t.Context(), writeEvents, kind, key)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	found, err := pgx.CollectRows(rows, pgx.RowToStructByPos[roleEvent])
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	return found
}

func (f *commandFixture) label(t *testing.T, key string) string {
	t.Helper()
	var label string
	if err := f.conn.QueryRow(t.Context(), writeLabel, key).Scan(&label); err != nil {
		t.Fatal(test.Redact(err))
	}
	return label
}

func (f *commandFixture) revision(t *testing.T) int64 {
	t.Helper()
	var revision int64
	if err := f.conn.QueryRow(t.Context(), writeRevision).Scan(&revision); err != nil {
		t.Fatal(test.Redact(err))
	}
	return revision
}

func ruleOf(rules []writtenRule, permission string) string {
	for _, rule := range rules {
		if rule.Permission == permission {
			return rule.ID
		}
	}
	return ""
}

func ruleIDs(rules []writtenRule) []string {
	ids := make([]string, len(rules))
	for i, rule := range rules {
		ids[i] = rule.ID
	}
	return ids
}

func digestOf(t *testing.T, label string, grants ...GrantPair) string {
	t.Helper()
	digest, err := grant.GrantsDigest(label, specs(grants))
	if err != nil {
		t.Fatal(err)
	}
	return digest
}

func (f *commandFixture) update(t *testing.T, key, label, expected string, grants ...GrantPair) (WriteResult, error) {
	t.Helper()
	return f.service.Update(t.Context(), f.root, UpdateInput{CreateInput: CreateInput{Key: key, Label: label, Grants: grants}, ExpectedDigest: expected})
}

// A rule that stays is the same row before and after: an update that deleted every rule and inserted the new
// set would answer the same digest with new rule ids.
func TestUpdateWritesOnlyTheDifferenceAndAuditsTheNewSet(t *testing.T) {
	f := newCommandFixture(t)
	key := f.key()
	read, setting, employee := pair("role.read", "role", 1), pair("setting.read", "setting", 1), pair("employee.read", "allEmployees", 1)
	first, err := f.service.Create(t.Context(), f.root, CreateInput{Key: key, Label: "Old", Grants: []GrantPair{read, setting}})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	before, revision := f.stored(t, key), f.revision(t)
	kept, dropped := ruleOf(before, "role.read"), ruleOf(before, "setting.read")
	if len(before) != 2 || kept == "" || dropped == "" {
		t.Fatalf("the created role holds %+v", before)
	}

	next, err := f.update(t, key, "New", first.Digest, read, employee)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if want := (WriteResult{Key: key, Digest: digestOf(t, "New", read, employee)}); next != want {
		t.Errorf("the update answered %+v, want %+v", next, want)
	}
	if label := f.label(t, key); label != "New" {
		t.Errorf("the label after the update: %q", label)
	}
	after := f.stored(t, key)
	added := ruleOf(after, "employee.read")
	if len(after) != 2 || ruleOf(after, "role.read") != kept || added == "" || slices.Contains(ruleIDs(before), added) || slices.Contains(ruleIDs(after), dropped) {
		t.Errorf("the rules went from %+v to %+v", before, after)
	}
	if got := f.revision(t); got != revision+1 {
		t.Errorf("the revision went from %d to %d", revision, got)
	}
	wantEvent := roleEvent{Actor: f.rootID, Permission: "role.update", Revision: revision, Count: "2", Digest: next.Digest}
	if events := f.events(t, "permission.role-update", key); len(events) != 1 || events[0] != wantEvent {
		t.Errorf("the audit of the update: %+v, want %+v", events, wantEvent)
	}

	renamed, err := f.update(t, key, "Another label", next.Digest, read, employee)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	if renamed.Digest != digestOf(t, "Another label", read, employee) || renamed.Digest == next.Digest {
		t.Errorf("the digest after a change of label only: %s, before %s", renamed.Digest, next.Digest)
	}
	if got := ruleIDs(f.stored(t, key)); !slices.Equal(got, ruleIDs(after)) {
		t.Errorf("a change of label only rewrote the rules: %v -> %v", ruleIDs(after), got)
	}
	wantEvent = roleEvent{Actor: f.rootID, Permission: "role.update", Revision: revision + 1, Count: "2", Digest: renamed.Digest}
	if events := f.events(t, "permission.role-update", key); len(events) != 2 || events[1] != wantEvent {
		t.Errorf("the audit of the change of label: %+v, want %+v", events, wantEvent)
	}
}

func TestAStaleDigestChangesNothingAndTheLabelCountsInTheDigest(t *testing.T) {
	f := newCommandFixture(t)
	key := f.key()
	read, setting := pair("role.read", "role", 1), pair("setting.read", "setting", 1)
	created, err := f.service.Create(t.Context(), f.root, CreateInput{Key: key, Label: "A", Grants: []GrantPair{read}})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	f.refused(t, "a digest of zeros", apperror.ErrCommandRejected, func() error {
		_, err := f.update(t, key, "B", strings.Repeat("0", 64), setting)
		return err
	})
	f.refused(t, "the digest of the stored grants under the new label", apperror.ErrCommandRejected, func() error {
		_, err := f.update(t, key, "B", digestOf(t, "B", read), read)
		return err
	})
	if label := f.label(t, key); label != "A" {
		t.Errorf("the label after two refused updates: %q", label)
	}
	if _, err := f.update(t, key, "B", created.Digest, setting); err != nil {
		t.Errorf("the update with the digest of the create: %v", test.Redact(err))
	}
}

func TestDeleteRemovesTheRoleWithEveryRuleAndAuditsWhatItRemoved(t *testing.T) {
	f := newCommandFixture(t)
	key := f.key()
	created, err := f.service.Create(t.Context(), f.root, CreateInput{Key: key, Label: "Label", Grants: []GrantPair{pair("role.read", "role", 1), pair("setting.read", "setting", 1)}})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	revision := f.revision(t)

	removed, err := f.service.Remove(t.Context(), f.root, key)
	if err != nil || removed != (Removed{Status: "deleted"}) {
		t.Fatalf("the delete answered %+v: %v", removed, test.Redact(err))
	}
	if label, rules := f.label(t, key), f.stored(t, key); label != "" || len(rules) != 0 {
		t.Errorf("the delete left the label %q and the rules %+v", label, rules)
	}
	wantEvent := roleEvent{Actor: f.rootID, Permission: "role.delete", Revision: revision, Count: "2", Digest: created.Digest}
	if events := f.events(t, "permission.role-delete", key); len(events) != 1 || events[0] != wantEvent {
		t.Errorf("the audit of the delete: %+v, want %+v", events, wantEvent)
	}
	if events := f.events(t, "permission.role-create", key); len(events) != 1 || events[0].Count != "2" || events[0].Digest != created.Digest {
		t.Errorf("the audit of the create: %+v", events)
	}
}
