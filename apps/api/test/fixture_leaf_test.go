package test

import (
	"slices"
	"strings"
	"testing"
)

// fixtureImports is everything of this module test/fixture may import: internal tests of a module can import
// the fixture only while the fixture imports no module. Its subpackages (attendanceoracle) are not bound.
var fixtureImports = []string{modulePath + "/internal/database", modulePath + "/test"}

func checkFixtureLeaf(packages []goPackage) []string {
	var violations []string
	found := false
	for _, listed := range packages {
		if listed.ImportPath != modulePath+"/test/fixture" {
			continue
		}
		found = true
		for _, imported := range listed.Imports {
			if _, internal := relative(imported); internal && !slices.Contains(fixtureImports, imported) {
				violations = append(violations, "test/fixture imports "+strings.TrimPrefix(imported, modulePath+"/"))
			}
		}
	}
	if !found {
		violations = append(violations, "test/fixture is not listed")
	}
	return violations
}

func TestTheFixtureImportsNoModule(t *testing.T) {
	if violations := checkFixtureLeaf(listPackages(t)); len(violations) > 0 {
		t.Errorf("violations:\n%s", strings.Join(violations, "\n"))
	}
}

func TestCheckFixtureLeaf(t *testing.T) {
	cases := map[string]struct {
		listed []goPackage
		bad    bool
	}{
		"database and test":      {[]goPackage{fakePackage("test/fixture", modulePath+"/internal/database", modulePath+"/test", "github.com/jackc/pgx/v5", "context")}, false},
		"a module":               {[]goPackage{fakePackage("test/fixture", modulePath+"/internal/modules/attendancecore")}, true},
		"permission":             {[]goPackage{fakePackage("test/fixture", modulePath+"/internal/database", modulePath+"/internal/modules/permission")}, true},
		"a subpackage":           {[]goPackage{fakePackage("test/fixture", modulePath+"/test/fixture/attendanceoracle")}, true},
		"the subpackage is free": {[]goPackage{fakePackage("test/fixture"), fakePackage("test/fixture/attendanceoracle", modulePath+"/internal/modules/attendancecore")}, false},
		"no fixture listed":      {[]goPackage{fakePackage("test")}, true},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := checkFixtureLeaf(c.listed); (len(got) > 0) != c.bad {
				t.Errorf("violations %q, want some: %v", got, c.bad)
			}
		})
	}
}
