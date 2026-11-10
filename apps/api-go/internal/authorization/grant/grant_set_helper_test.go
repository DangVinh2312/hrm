package grant_test

import (
	"strings"
	"testing"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
	"hrm/api-go/internal/authorization/grant"
)

func fact(permission, template string, version int) grant.GrantRuleFact {
	return grant.GrantRuleFact{Source: grant.SourceRole, Effect: core.EffectAllow, Permission: permission, Template: core.RelationRef{Key: template, Version: version}, Parameters: "{}"}
}

func TestCompareGrantSets(t *testing.T) {
	read := fact("employee.read", "allEmployees", 1)
	suspend := fact("account.suspend", "allAccounts", 1)
	denied := read
	denied.Effect = core.EffectDeny
	attached := read
	attached.Source = grant.SourceUser
	unknown := read
	unknown.Source = "group"
	otherVersion := fact("employee.read", "allEmployees", 2)
	otherTemplate := fact("employee.read", "selfEmployee", 1)
	otherParameters := read
	otherParameters.Parameters = `{"a":"b"}`
	cases := map[string]struct {
		target, actor []grant.GrantRuleFact
		want          grant.Verdict
	}{
		"empty target":                      {nil, nil, grant.Within},
		"subset":                            {[]grant.GrantRuleFact{read}, []grant.GrantRuleFact{suspend, read}, grant.Within},
		"equal in another order":            {[]grant.GrantRuleFact{suspend, read}, []grant.GrantRuleFact{read, suspend}, grant.Within},
		"target holds a missing permission": {[]grant.GrantRuleFact{read, suspend}, []grant.GrantRuleFact{read}, grant.Larger},
		"larger beats incomparable":         {[]grant.GrantRuleFact{otherVersion, suspend}, []grant.GrantRuleFact{read}, grant.Larger},
		"other template version":            {[]grant.GrantRuleFact{otherVersion}, []grant.GrantRuleFact{read}, grant.Incomparable},
		"other template":                    {[]grant.GrantRuleFact{otherTemplate}, []grant.GrantRuleFact{read}, grant.Incomparable},
		"other parameters":                  {[]grant.GrantRuleFact{otherParameters}, []grant.GrantRuleFact{read}, grant.Incomparable},
		"deny on the target":                {[]grant.GrantRuleFact{denied}, []grant.GrantRuleFact{read}, grant.Unprovable},
		"deny on the actor":                 {nil, []grant.GrantRuleFact{read, denied}, grant.Unprovable},
		"user rule on the target":           {[]grant.GrantRuleFact{attached}, []grant.GrantRuleFact{read}, grant.Unprovable},
		"user rule on the actor":            {[]grant.GrantRuleFact{read}, []grant.GrantRuleFact{read, attached}, grant.Unprovable},
		"unknown source":                    {[]grant.GrantRuleFact{unknown}, []grant.GrantRuleFact{read}, grant.Unprovable},
		"unknown effect":                    {[]grant.GrantRuleFact{{Source: grant.SourceRole, Effect: "maybe", Permission: "employee.read", Template: read.Template, Parameters: "{}"}}, []grant.GrantRuleFact{read}, grant.Unprovable},
	}
	for name, c := range cases {
		if got := grant.CompareGrantSets(c.target, c.actor); got != c.want {
			t.Errorf("%s: got %s want %s", name, got, c.want)
		}
	}
}

func TestATruncatedReadProvesNothing(t *testing.T) {
	read := []grant.GrantRuleFact{fact("employee.read", "allEmployees", 1)}
	if !grant.ProvenWithin(read, read, false) {
		t.Fatal("a complete equal set was not within")
	}
	if grant.ProvenWithin(read, read, true) || grant.ProvenWithin(nil, read, true) {
		t.Fatal("a truncated read proved inclusion")
	}
}

func newCore(t *testing.T) *core.Core {
	t.Helper()
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRootSkipsTheComparisonAndAnUnknownKindIsRefused(t *testing.T) {
	within, actor, err := grant.WithinActor(nil, nil, grant.Actor{ID: "x", Kind: "root"}, "y")
	if err != nil || !within || len(actor) != 0 {
		t.Fatal("root did not bypass the grant comparison")
	}
	within, _, err = grant.WithinActor(nil, nil, grant.Actor{ID: "x", Kind: "service"}, "y")
	if err == nil || within {
		t.Fatal("unknown principal kind was not refused")
	}
}

// A nil tx would panic on a query, so these pass only when the id is refused before any SQL.
func TestReadRefusesANonCanonicalIDBeforeQuerying(t *testing.T) {
	c := newCore(t)
	id := "0b6f3c1e-4d2a-4f8b-9c3d-2e1f0a9b8c7d"
	if !c.IsCanonicalUUID(id) {
		t.Fatal("the control id is not canonical")
	}
	for _, bad := range []string{strings.ToUpper(id), "{" + id + "}", strings.ReplaceAll(id, "-", ""), "", "x"} {
		if _, _, err := grant.Read(nil, c, []string{id, bad}, grant.MaxFactRows); err == nil {
			t.Errorf("Read accepted %q", bad)
		}
		if within, _, err := grant.WithinActor(nil, c, grant.Actor{ID: id, Kind: "iam"}, bad); err == nil || within {
			t.Errorf("WithinActor accepted %q", bad)
		}
	}
	if _, _, err := grant.Read(nil, nil, []string{id}, grant.MaxFactRows); err == nil {
		t.Error("Read without a core accepted an id")
	}
}
