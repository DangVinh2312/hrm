package grant_test

import (
	"strings"
	"testing"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/authorization/grant"
	"hrm/api/internal/authorization/keys"
)

func spec(permission, template string, version int) grant.RoleGrantSpec {
	return grant.RoleGrantSpec{Permission: permission, Template: core.RelationRef{Key: template, Version: version}}
}

func r(code rune) string { return string(code) }

// Vectors from grantsDigest of apps/api/dist/authorization/helpers/role-grant.helper.js (node, 2026-11-10).
func TestGrantsDigestMatchesTheTypeScriptVectors(t *testing.T) {
	marked := "HR <t" + r(0x1ed5) + `ng> & "q" ` + r(0x2028) + " x"
	cases := []struct {
		name, label string
		grants      []grant.RoleGrantSpec
		want        string
	}{
		{"empty", "Admin", nil, "369a5dc193f0c19edaa0e4b0b279ecf4236c62fd7d327f28b038274f2bd101c4"},
		{"one", "Admin", []grant.RoleGrantSpec{spec("role.read", "roleAnchor", 1)}, "229bc9634e4aa6230eabfc46387e96dcd465a15008cca74fcf25b535f151f0cd"},
		{"escaped label", marked, []grant.RoleGrantSpec{spec("employee.read", "allEmployees", 1), spec("account.suspend", "allAccounts", 1), spec("employee.read", "allEmployees", 2)}, "6db48187d9eb601dd7ae1c7f1a54dbde864fdb57e9b059343a866cc5e8de1cd4"},
		{"order does not matter", marked, []grant.RoleGrantSpec{spec("employee.read", "allEmployees", 2), spec("account.suspend", "allAccounts", 1), spec("employee.read", "allEmployees", 1)}, "6db48187d9eb601dd7ae1c7f1a54dbde864fdb57e9b059343a866cc5e8de1cd4"},
		{"astral and backslash", "Nh" + r(0xe2) + "n s" + r(0x1ef1) + " " + r(0x1f600) + ` \ /`, []grant.RoleGrantSpec{spec("team.read", "allTeams", 12)}, "d6aafe2e9dbb90f182081c6e55be71093a6753c7af15d2aea6933d7c21e60e00"},
	}
	for _, c := range cases {
		got, err := grant.GrantsDigest(c.label, c.grants)
		if err != nil || got != c.want {
			t.Errorf("%s: got %s err %v", c.name, got, err)
		}
	}
	if _, err := grant.GrantsDigest("bad\xff", nil); err == nil {
		t.Fatal("invalid UTF-8 label hashed")
	}
}

func TestCheckRoleGrantsTakesOnlyRegisteredPairs(t *testing.T) {
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	validated, err := c.Validate(declarations.Source().Declarations)
	if err != nil {
		t.Fatal(err)
	}
	ok := spec("account.suspend", "allAccounts", 1)
	many := make([]grant.RoleGrantSpec, keys.MaxRoleGrants+1)
	cases := map[string]struct {
		grants []grant.RoleGrantSpec
		want   grant.GrantCheck
	}{
		"registered":                   {[]grant.RoleGrantSpec{ok, spec("employee.read", "allEmployees", 1)}, grant.GrantsOK},
		"none":                         {nil, grant.GrantsOK},
		"too many":                     {many, grant.GrantsTooMany},
		"undeclared resource":          {[]grant.RoleGrantSpec{spec("payroll.read", "allAccounts", 1)}, grant.GrantsUnknownPermission},
		"undeclared action":            {[]grant.RoleGrantSpec{spec("account.delete", "allAccounts", 1)}, grant.GrantsUnknownPermission},
		"no resource":                  {[]grant.RoleGrantSpec{spec(".suspend", "allAccounts", 1)}, grant.GrantsUnknownPermission},
		"no dot":                       {[]grant.RoleGrantSpec{spec("account", "allAccounts", 1)}, grant.GrantsUnknownPermission},
		"nested action":                {[]grant.RoleGrantSpec{spec("account.suspend.x", "allAccounts", 1)}, grant.GrantsUnknownPermission},
		"inherited name":               {[]grant.RoleGrantSpec{spec("constructor.read", "allAccounts", 1)}, grant.GrantsUnknownPermission},
		"unregistered template":        {[]grant.RoleGrantSpec{spec("account.suspend", "everyone", 1)}, grant.GrantsUnknownTemplate},
		"unregistered version":         {[]grant.RoleGrantSpec{spec("account.suspend", "allAccounts", 2)}, grant.GrantsUnknownTemplate},
		"template of another resource": {[]grant.RoleGrantSpec{spec("account.suspend", "allEmployees", 1)}, grant.GrantsWrongResource},
		"duplicate":                    {[]grant.RoleGrantSpec{ok, ok}, grant.GrantsDuplicate},
	}
	for name, c := range cases {
		if got := grant.CheckRoleGrants(validated, c.grants); got != c.want {
			t.Errorf("%s: got %s want %s", name, got, c.want)
		}
	}
	if got := grant.CheckRoleGrants(nil, []grant.RoleGrantSpec{ok}); got == grant.GrantsOK {
		t.Fatal("missing declarations accepted a grant")
	}
}

func TestRoleKeys(t *testing.T) {
	for value, want := range map[string]bool{"custom.hr_lead": true, "custom.ab": true, "custom.a": false, "custom." + strings.Repeat("a", 41): true, "custom." + strings.Repeat("a", 42): false, "custom.Hr": false, "custom.1a": false, "admin": false, "custom.hr\n": false} {
		if grant.IsRuntimeRoleKey(value) != want {
			t.Errorf("runtime key %q: want %v", value, want)
		}
	}
	for value, want := range map[string]bool{"admin": true, "": false, strings.Repeat("a", 96): true, strings.Repeat("a", 97): false, strings.Repeat(r(0xe2), 48): true, strings.Repeat(r(0xe2), 49): false} {
		if grant.IsRoleKeyReference(value) != want {
			t.Errorf("reference %q: want %v", value, want)
		}
	}
}

func TestGrantsAsFactsAreProvableRoleAllows(t *testing.T) {
	facts := grant.GrantsAsFacts([]grant.RoleGrantSpec{spec("account.suspend", "allAccounts", 1)})
	if grant.CompareGrantSets(facts, []grant.GrantRuleFact{fact("account.suspend", "allAccounts", 1)}) != grant.Within {
		t.Fatal("grants as facts differ from the role facts the database gives")
	}
}
