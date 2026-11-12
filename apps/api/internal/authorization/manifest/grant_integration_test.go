//go:build integration

package manifest_test

import (
	"context"
	"errors"
	"testing"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/authorization/manifest"
	"hrm/api/internal/database"
	"hrm/api/test"
)

func archiveSource() (manifest.Source, manifest.DefaultGrant) {
	source := declarations.Source()
	for i := range source.Declarations.Resources {
		if source.Declarations.Resources[i].Key == "document" {
			source.Declarations.Resources[i].Actions["archive"] = core.ActionDeclaration{Policy: core.RelationRef{Key: "editable", Version: 1}, Boundary: core.BoundaryOptional}
		}
	}
	grant := manifest.DefaultGrant{Permission: "document.archive", Role: "reviewer", Template: core.RelationRef{Key: "ownedDocuments", Version: 1}, Parameters: map[string]core.Scalar{}}
	return source, grant
}

func TestDefaultGrantCollisionDoesNotAdoptOrOverwriteRuntimeRule(t *testing.T) {
	vector := test.NewDatabase(t)
	source, grant := archiveSource()
	source.Sequence, source.Predecessor = "7", "6"
	source.DefaultGrants = append(source.DefaultGrants, grant, grant)
	if _, err := reconcile(t.Context(), vector.Runner, productRelease(t, source)); err != nil {
		t.Fatal(test.Redact(err))
	}
	vectorConn, err := vector.Cluster.ConnectSuperuser(t.Context(), vector.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := vectorConn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	var id string
	if err := vectorConn.QueryRow(t.Context(), "SELECT rule_id::text FROM policy_rule WHERE permission_key=convert_to('document.archive','UTF8') AND managed_by='code'").Scan(&id); err != nil {
		t.Fatal(test.Redact(err))
	}
	s := test.NewDatabase(t)
	_, err = database.Run(t.Context(), s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		if _, err := tx.Exec("INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to('custom.collision','UTF8'),'runtime','Fixture')"); err != nil {
			return struct{}{}, err
		}
		_, err := tx.Exec(`INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES($1,convert_to('document.read','UTF8'),convert_to('custom.collision','UTF8'),'allow',convert_to('ownedDocuments','UTF8'),1,'{}','runtime')`, id)
		return struct{}{}, err
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	_, err = reconcile(t.Context(), s.Runner, productRelease(t, source))
	var rejected *manifest.Rejection
	if !errors.As(err, &rejected) || rejected.Reason != "collision" {
		t.Fatalf("runtime rule collision was not rejected: %s", test.Redact(err))
	}
	var unchanged bool
	conn, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := conn.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	if err := conn.QueryRow(t.Context(), `SELECT (SELECT release_sequence=6 FROM authz_state WHERE singleton) AND managed_by='runtime' AND permission_key=convert_to('document.read','UTF8') FROM policy_rule WHERE rule_id=$1`, id).Scan(&unchanged); err != nil {
		t.Fatal(test.Redact(err))
	}
	if !unchanged {
		t.Fatal("collision changed runtime row or published release")
	}
}

func TestUpgradeCreatesDefaultOnceAndOnlyExplicitRemovalDeletesIt(t *testing.T) {
	s := test.NewDatabase(t)
	_, err := database.Run(t.Context(), s.Runner, database.ModeAdmin, func(_ context.Context, tx *database.Tx) (struct{}, error) {
		if _, err := tx.Exec("INSERT INTO role_definition(role_key,managed_by,label) VALUES(convert_to('custom.keep','UTF8'),'runtime','Fixture')"); err != nil {
			return struct{}{}, err
		}
		_, err := tx.Exec(`INSERT INTO policy_rule(rule_id,permission_key,role_key,effect,template_key,template_version,parameters,managed_by) VALUES('00000000-0000-4000-8000-000000000777',convert_to('document.read','UTF8'),convert_to('custom.keep','UTF8'),'allow',convert_to('ownedDocuments','UTF8'),1,'{}','runtime')`)
		return struct{}{}, err
	}, database.RunOptions{})
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	source, grant := archiveSource()
	source.Sequence, source.Predecessor = "7", "6"
	source.DefaultGrants = append(source.DefaultGrants, grant)
	if _, err := reconcile(t.Context(), s.Runner, productRelease(t, source)); err != nil {
		t.Fatal(test.Redact(err))
	}
	connection, err := s.Cluster.ConnectSuperuser(t.Context(), s.Database)
	if err != nil {
		t.Fatal(test.Redact(err))
	}
	defer func() {
		if err := connection.Close(context.WithoutCancel(t.Context())); err != nil {
			t.Error(test.Redact(err))
		}
	}()
	var count int
	if err := connection.QueryRow(t.Context(), "SELECT count(*) FROM policy_rule WHERE permission_key=convert_to('document.archive','UTF8') AND managed_by='code'").Scan(&count); err != nil {
		t.Fatal(test.Redact(err))
	}
	if count != 1 {
		t.Fatal("new permission did not receive exactly one default grant")
	}
	omitted, _ := archiveSource()
	omitted.Sequence, omitted.Predecessor = "8", "7"
	if _, err := reconcile(t.Context(), s.Runner, productRelease(t, omitted)); err != nil {
		t.Fatal(test.Redact(err))
	}
	if err := connection.QueryRow(t.Context(), "SELECT count(*) FROM policy_rule WHERE permission_key=convert_to('document.archive','UTF8') AND managed_by='code'").Scan(&count); err != nil {
		t.Fatal(test.Redact(err))
	}
	if count != 1 {
		t.Fatal("omission revoked a code grant")
	}
	removal, _ := archiveSource()
	removal.Sequence, removal.Predecessor = "9", "8"
	removal.RemoveDefaultGrants = []manifest.DefaultGrant{grant}
	if _, err := reconcile(t.Context(), s.Runner, productRelease(t, removal)); err != nil {
		t.Fatal(test.Redact(err))
	}
	if err := connection.QueryRow(t.Context(), "SELECT count(*) FROM policy_rule WHERE permission_key=convert_to('document.archive','UTF8') AND managed_by='code'").Scan(&count); err != nil {
		t.Fatal(test.Redact(err))
	}
	if count != 0 {
		t.Fatal("explicit removal did not remove the code grant")
	}
	var kept bool
	if err := connection.QueryRow(t.Context(), "SELECT EXISTS(SELECT 1 FROM policy_rule WHERE rule_id='00000000-0000-4000-8000-000000000777' AND managed_by='runtime')").Scan(&kept); err != nil {
		t.Fatal(test.Redact(err))
	}
	if !kept {
		t.Fatal("upgrade changed runtime rule")
	}
}
