//go:build integration

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"hrm/api/internal/audit"
	"hrm/api/internal/authorization/manifest"
	"hrm/api/internal/database"
	"hrm/api/test"
)

const (
	rootAddress  = "root@example.test"
	rootOp       = "9d6f4a3b-5e7a-4b1c-8d4e-5f6a7b8c9d0e"
	otherOp      = "ae7a5b4c-6f8b-4c2d-9e5f-6a7b8c9d0e1f"
	markerOf     = `SELECT coalesce(operation_id::text,'none')||' '||coalesce(target_user_id::text,'none') FROM security_bootstrap_state WHERE singleton`
	rootRows     = `SELECT count(*)::int FROM app_user WHERE kind='root'`
	liveProof    = `SELECT count(*)::int FROM one_time_token WHERE user_id=$1 AND purpose='oidc-activation' AND consumed_at IS NULL AND token_hash=$2`
	liveProofs   = `SELECT count(*)::int FROM one_time_token WHERE user_id=$1 AND purpose='oidc-activation' AND consumed_at IS NULL`
	holdsText    = `SELECT count(*)::int FROM audit_outbox o WHERE position($1 in o::text)>0`
	accountState = `SELECT kind||' '||state||' '||coalesce(email_canonical,'none')||' '||email_verified::text FROM app_user WHERE id=$1`
)

var rootCommittedLine = regexp.MustCompile(`^Root enrollment committed \(id ([0-9a-f-]{36})\); activation still required\.\n$`)

func reason(err error) string {
	var rejection *manifest.Rejection
	if errors.As(err, &rejection) {
		return rejection.Reason
	}
	return ""
}

func absent(t *testing.T, name string) {
	t.Helper()
	if _, err := os.Stat(name); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an activation file was written: %v", err)
	}
}

// proof reads an activation file the command wrote: mode 0600, one secret line.
func proof(t *testing.T, name string) string {
	t.Helper()
	info, err := os.Stat(name)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("activation file: %v", err)
	}
	content, err := os.ReadFile(name)
	if err != nil || !strings.HasSuffix(string(content), "\n") || len(content) != 44 {
		t.Fatalf("activation file holds %d bytes: %v", len(content), err)
	}
	return strings.TrimSuffix(string(content), "\n")
}

func (w *commandWorld) bootstrap(file, op, email, issuer string) (string, error) {
	return w.command("bootstrap", "bootstrap", "--operation", op, "--issuer", issuer, "--email", email, "--activation-file", file)
}

// activate writes what a completed Google activation leaves, with the identity login.
func (w *commandWorld) activate(root string) {
	w.t.Helper()
	_, err := database.Run(w.t.Context(), w.s.Runner, database.ModeIdentity, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		for _, step := range []struct {
			sql  string
			args []any
		}{
			{`DELETE FROM oidc_email_enrollment WHERE user_id=$1`, []any{root}},
			{`INSERT INTO external_identity(issuer,subject,user_id) VALUES($1,$2,$3)`, []any{test.FixtureIssuer, "root-subject", root}},
			{`UPDATE one_time_token SET consumed_at=statement_timestamp() WHERE user_id=$1 AND consumed_at IS NULL`, []any{root}},
			{`UPDATE app_user SET state='active',email_verified=true,auth_epoch=auth_epoch+1 WHERE id=$1 AND state='pending'`, []any{root}},
		} {
			if _, err := tx.Exec(step.sql, step.args...); err != nil {
				return struct{}{}, err
			}
		}
		return struct{}{}, nil
	}, database.RunOptions{})
	if err != nil {
		w.t.Fatal(test.Redact(err))
	}
}

func TestBootstrapRefusesADriftedManifest(t *testing.T) {
	w := newCommandWorld(t)
	dir := t.TempDir()
	original := w.text(`SELECT encode(manifest_hash,'hex')||' '||encode(materialized_hash,'hex') FROM authz_state WHERE singleton`)
	hashes := strings.Fields(original)
	for _, drift := range []string{
		`UPDATE authz_state SET manifest_hash=sha256('drift'::bytea) WHERE singleton`,
		`UPDATE authz_state SET manifest_hash=decode($1,'hex'),materialized_hash=sha256('drift'::bytea) WHERE singleton`,
	} {
		w.exec(`SET session_replication_role=replica`)
		if strings.Contains(drift, "$1") {
			w.exec(drift, hashes[0])
		} else {
			w.exec(drift)
		}
		w.exec(`RESET session_replication_role`)
		file := filepath.Join(dir, "activation")
		if _, err := w.bootstrap(file, rootOp, rootAddress, test.FixtureIssuer); reason(err) != "not_ready" {
			t.Fatalf("drift: got %q", failureLine(err))
		}
		absent(t, file)
		if w.count(rootRows) != 0 || w.text(markerOf) != "none none" {
			t.Fatal("a refused bootstrap wrote")
		}
	}
}

func TestTheRootCommandsCreateReissueRenameAndRevokeTheOneRoot(t *testing.T) {
	w := newCommandWorld(t)
	dir := t.TempDir()
	file := func(name string) string { return filepath.Join(dir, name) }
	before := w.text(revisionNow)

	if err := os.WriteFile(file("taken"), []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := w.bootstrap(file("taken"), rootOp, rootAddress, test.FixtureIssuer); err == nil {
		t.Fatal("an existing activation file was accepted")
	}
	if content, err := os.ReadFile(file("taken")); err != nil || string(content) != "old\n" {
		t.Fatal("the existing activation file changed")
	}
	if _, err := w.bootstrap(file("issuer"), rootOp, rootAddress, "https://unknown.example.test"); reason(err) != "missing_reference" {
		t.Fatalf("unknown issuer: %q", failureLine(err))
	}
	absent(t, file("issuer"))
	// The bootstrap login alone promotes: any other login is refused and nothing is written.
	identityEnv := map[string]string{"NODE_ENV": "test", "PGSSLMODE": "disable", bootstrapURL: w.s.LoginURL("identity")}
	if err := run(t.Context(), []string{"bootstrap", "--operation", rootOp, "--issuer", test.FixtureIssuer, "--email", rootAddress, "--activation-file", file("runtime")},
		func(name string) string { return identityEnv[name] }, io.Discard); err == nil {
		t.Fatal("a runtime login bootstrapped the Root")
	}
	absent(t, file("runtime"))
	if w.count(rootRows) != 0 || w.text(markerOf) != "none none" || w.text(revisionNow) != before {
		t.Fatal("a refused bootstrap wrote")
	}

	out, err := w.bootstrap(file("first"), rootOp, "Root@Example.test", test.FixtureIssuer)
	if err != nil {
		t.Fatal(failureLine(err))
	}
	match := rootCommittedLine.FindStringSubmatch(out)
	if match == nil {
		t.Fatalf("stdout %q", out)
	}
	root := match[1]
	first := proof(t, file("first"))
	if strings.Contains(out, first) || w.count(liveProof, root, digestOf(first)) != 1 {
		t.Fatal("the proof is printed or not the stored one")
	}
	if w.text(accountState, root) != "root pending "+rootAddress+" false" || w.text(markerOf) != rootOp+" "+root ||
		w.count(`SELECT count(*)::int FROM oidc_email_enrollment WHERE user_id=$1 AND issuer=$2 AND created_by=$3`, root, test.FixtureIssuer, audit.OfflineActor) != 1 {
		t.Fatal("not one pending Root with its marker and pinned enrollment")
	}
	if w.count(offlineKinds+` AND safe_metadata->>'targetUserId'=$3 AND safe_metadata->>'operationId'=$4 AND safe_metadata->>'method'='oidc'`,
		audit.OfflineActor, string(audit.KindRootBootstrap), root, rootOp) != 1 {
		t.Fatal("no offline root.bootstrap event")
	}

	if out, err := w.bootstrap(file("again"), rootOp, rootAddress, test.FixtureIssuer); err != nil ||
		out != "Operation already committed (id "+root+"); marker and Root unchanged.\n" {
		t.Fatalf("retry: %q, %v", out, err)
	}
	absent(t, file("again"))
	for _, tc := range []struct{ op, email string }{
		{rootOp, "other@example.test"},
		{otherOp, rootAddress},
		{otherOp, "second@example.test"},
	} {
		if _, err := w.bootstrap(file("second"), tc.op, tc.email, test.FixtureIssuer); reason(err) != "collision" {
			t.Fatalf("another bootstrap: %q", failureLine(err))
		}
		absent(t, file("second"))
	}
	if w.count(rootRows) != 1 || w.count(`SELECT count(*)::int FROM app_user`) != 1 ||
		w.count(offlineKinds, audit.OfflineActor, string(audit.KindRootBootstrap)) != 1 {
		t.Fatal("a retry or a second bootstrap wrote")
	}

	if _, err := w.command("bootstrap", "reissue-root", "--issuer", "https://unknown.example.test", "--activation-file", file("lost")); reason(err) != "missing_reference" {
		t.Fatalf("reissue on an unknown issuer: %q", failureLine(err))
	}
	absent(t, file("lost"))
	if out, err := w.command("bootstrap", "reissue-root", "--issuer", test.FixtureIssuer, "--activation-file", file("reissued")); err != nil ||
		out != "Root activation proof reissued; earlier proofs are void.\n" {
		t.Fatalf("reissue: %q, %v", out, err)
	}
	reissued := proof(t, file("reissued"))
	if reissued == first || w.count(liveProof, root, digestOf(reissued)) != 1 || w.count(liveProofs, root) != 1 ||
		w.count(offlineKinds, audit.OfflineActor, string(audit.KindRootReissue)) != 1 {
		t.Fatal("the reissue did not replace the proof with one audited proof")
	}

	enrolled, err := w.command("authority", "enroll", "--user", enrolledUser, "--email", "member@example.test", "--issuer", test.FixtureIssuer, "--role", "hr.employee")
	if err != nil {
		t.Fatalf("enroll: %q %s", enrolled, failureLine(err))
	}
	for _, user := range []string{root, enrolledUser, otherUser} {
		if _, err := w.command("bootstrap", "set-root-email", "--user", user, "--operation", otherOp, "--email", "renamed@example.test"); reason(err) != "collision" {
			t.Fatalf("set-root-email on a pending Root, an IAM or an absent account: %q", failureLine(err))
		}
	}

	w.activate(root)
	if _, err := w.command("bootstrap", "reissue-root", "--issuer", test.FixtureIssuer, "--activation-file", file("late")); reason(err) != "collision" {
		t.Fatalf("reissue after activation: %q", failureLine(err))
	}
	absent(t, file("late"))
	if _, err := w.command("bootstrap", "set-root-email", "--user", root, "--operation", otherOp, "--email", "member@example.test"); reason(err) != "collision" {
		t.Fatalf("a taken email: %q", failureLine(err))
	}
	epoch := w.text(epochOf, root)
	if out, err := w.command("bootstrap", "set-root-email", "--user", root, "--operation", otherOp, "--email", "Renamed@Example.test"); err != nil ||
		out != "Root email set, unverified until the next verified Google sign-in; its sessions ended.\n" {
		t.Fatalf("set-root-email: %q, %v", out, err)
	}
	if w.text(accountState, root) != "root active renamed@example.test false" || w.text(epochOf, root) == epoch ||
		w.count(offlineKinds+` AND safe_metadata->>'targetUserId'=$3 AND safe_metadata->>'operationId'=$4`, audit.OfflineActor, string(audit.KindRootSetEmail), root, otherOp) != 1 {
		t.Fatal("the Root email, epoch or audit is wrong")
	}
	if out, err := w.command("bootstrap", "set-root-email", "--user", root, "--operation", otherOp, "--email", "renamed@example.test"); err != nil ||
		out != "Root already has this email; nothing changed.\n" {
		t.Fatalf("same email: %q, %v", out, err)
	}

	if _, err := w.command("bootstrap", "revoke-root", "--user", root, "--operation", otherOp, "--reason", "left the company"); err == nil {
		t.Fatal("a revocation without approval ran")
	}
	if w.text(accountState, root) != "root active renamed@example.test false" {
		t.Fatal("a refused revocation wrote")
	}
	epoch = w.text(epochOf, root)
	env := map[string]string{"NODE_ENV": "test", "PGSSLMODE": "disable", bootstrapURL: w.s.LoginURL("bootstrap")}
	if err := run(t.Context(), []string{"revoke-root", "--user", root, "--operation", otherOp, "--approval", "ticket-9", "--reason", "left the company"},
		func(name string) string { return env[name] }, failingWriter{}); err != nil {
		t.Fatalf("a committed revocation failed on stdout: %s", failureLine(err))
	}
	if w.text(accountState, root) != "root suspended renamed@example.test false" || w.text(epochOf, root) == epoch ||
		w.count(`SELECT count(*)::int FROM audit_outbox WHERE event_kind=convert_to('root.revoke','UTF8') AND actor_id=$1 AND reason='left the company'
        AND safe_metadata->>'approval'='ticket-9' AND safe_metadata->>'targetUserId'=$2`, audit.OfflineActor, root) != 1 {
		t.Fatal("the revocation did not suspend with one audited event")
	}
	if out, err := w.command("bootstrap", "revoke-root", "--user", root, "--operation", otherOp, "--approval", "ticket-9", "--reason", "left the company"); err != nil ||
		out != "No unsuspended Root for this user; nothing changed.\n" {
		t.Fatalf("revoke again: %q, %v", out, err)
	}
	member := w.text(accountState, enrolledUser)
	if out, err := w.command("bootstrap", "revoke-root", "--user", enrolledUser, "--operation", rootOp, "--approval", "ticket-9", "--reason", "left the company"); err != nil ||
		out != "No unsuspended Root for this user; nothing changed.\n" || w.text(accountState, enrolledUser) != member {
		t.Fatalf("revoke-root suspended an IAM account: %q, %v", out, err)
	}
	if w.text(markerOf) != rootOp+" "+root {
		t.Fatal("the marker changed")
	}
	if w.count(anyAddress) != 0 || w.count(holdsText, first) != 0 || w.count(holdsText, reissued) != 0 {
		t.Fatal("an audit row holds an address or a proof")
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("stdout closed") }
