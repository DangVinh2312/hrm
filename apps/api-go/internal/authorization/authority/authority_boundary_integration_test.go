//go:build integration

package authority_test

import (
	"errors"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/authority"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
)

func TestRecordExceptionsStayInsidePolicyAndBoundary(t *testing.T) {
	f := newAuthorityFixture(t)
	f.exec(t, `INSERT INTO record_exception(exception_id,object_id,type_key,permission_key,user_id,effect,purpose,starts_at,reason,issued_by) VALUES(gen_random_uuid(),$1,convert_to('document','UTF8'),convert_to('document.read','UTF8'),$2,'allow','manual',statement_timestamp()-interval '1 minute','synthetic fixture',$2)`, objectOther, f.owner.ID)
	count, err := f.a.Count(t.Context(), f.secret, "document", "read")
	requireDB(t, err)
	if count != "2" {
		t.Fatal("record allow not resolved")
	}
	source := declarations.Source().Declarations
	source.Boundaries = append(source.Boundaries, core.PermissionBoundary{Key: "documentTestBoundary", Version: 1, Entries: []core.BoundaryEntry{{Permission: "document.read", ContextRequirements: []core.ContextRequirement{}, RequiredScope: core.CompareExpr{Op: core.OpEq, Field: "ownerId", Value: core.ValueRef{From: core.SourcePrincipal, Name: "id"}}}}})
	f.exec(t, `INSERT INTO permission_boundary(boundary_key,boundary_version,definition_hash,definition,lifecycle) VALUES(convert_to('documentTestBoundary','UTF8'),1,decode(repeat('00',32),'hex'),'{}','active')`)
	f.exec(t, `INSERT INTO permission_boundary_entry(boundary_key,boundary_version,permission_key,definition) VALUES(convert_to('documentTestBoundary','UTF8'),1,convert_to('document.read','UTF8'),'{}')`)
	f.exec(t, `INSERT INTO user_boundary(user_id,permission_key,boundary_key,boundary_version) VALUES($1,convert_to('document.read','UTF8'),convert_to('documentTestBoundary','UTF8'),1)`, f.owner.ID)
	a := f.authoritySource(t, authority.DefaultCapabilities(), source, declarations.Bindings())
	source.Boundaries[len(source.Boundaries)-1].Entries[0].RequiredScope = core.ConstantExpr{Value: true}
	count, err = a.Count(t.Context(), f.secret, "document", "read")
	requireDB(t, err)
	if count != "1" {
		t.Fatal("record allow or mutated declarations bypassed boundary")
	}
	f.exec(t, `INSERT INTO record_exception(exception_id,object_id,type_key,permission_key,user_id,effect,purpose,starts_at,reason,issued_by) VALUES(gen_random_uuid(),$1,convert_to('document','UTF8'),convert_to('document.read','UTF8'),$2,'deny','manual',statement_timestamp()-interval '1 minute','synthetic fixture',$2)`, objectOwn, f.owner.ID)
	count, err = a.Count(t.Context(), f.secret, "document", "read")
	requireDB(t, err)
	if count != "0" {
		t.Fatal("record deny did not beat allow")
	}
	f.exec(t, `UPDATE permission_boundary SET lifecycle='retired' WHERE boundary_key=convert_to('documentTestBoundary','UTF8')`)
	_, err = a.Count(t.Context(), f.secret, "document", "read")
	if !errors.Is(err, apperror.ErrAccessDenied) {
		t.Fatal("retired boundary failed open")
	}
}
