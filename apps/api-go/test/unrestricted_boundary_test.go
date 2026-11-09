package test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

func checkUnrestrictedBoundary(filePath string, source []byte) error {
	name := filepath.ToSlash(filePath)
	if strings.HasSuffix(name, "_test.go") || strings.HasPrefix(name, "internal/authorization/core/") || strings.HasPrefix(name, "internal/authorization/authority/") {
		return nil
	}
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, name, source, parser.SkipObjectResolution)
	if err != nil {
		return err
	}
	var found error
	ast.Inspect(parsed, func(node ast.Node) bool {
		selector, ok := node.(*ast.SelectorExpr)
		if ok && selector.Sel.Name == "PlanUnrestricted" {
			found = fmt.Errorf("%s: unrestricted planning is confined to core and authority", fset.Position(selector.Pos()))
			return false
		}
		return true
	})
	return found
}

func TestUnrestrictedPlanningStaysInAuthority(t *testing.T) {
	files := moduleFiles(t)
	if _, ok := files["cmd/hrmctl/main.go"]; !ok {
		t.Fatal("scan does not reach cmd/hrmctl")
	}
	for path, source := range files {
		if err := checkUnrestrictedBoundary(path, source); err != nil {
			t.Error(err)
		}
	}
}

func TestUnrestrictedBoundaryNegativeProbes(t *testing.T) {
	for _, source := range []string{
		`package x; func run(){ c.PlanUnrestricted(input,snapshot) }`,
		`package x; import alias "hrm/api-go/internal/authorization/core"; var bypass = (*alias.Core).PlanUnrestricted`,
		`package x; func run(){ bypass:=c.PlanUnrestricted; bypass(input,snapshot) }`,
		`package x; func run(){ wrapper.PlanUnrestricted(input,snapshot) }`,
	} {
		for _, path := range []string{"internal/modules/team/team_service.go", "cmd/hrmctl/main.go"} {
			if checkUnrestrictedBoundary(path, []byte(source)) == nil {
				t.Fatalf("bypass accepted in %s: %s", path, source)
			}
		}
		if err := checkUnrestrictedBoundary("internal/authorization/authority/engine.go", []byte(source)); err != nil {
			t.Fatal(err)
		}
	}
	if err := checkUnrestrictedBoundary("internal/modules/team/team_service.go", []byte(`package x; var text="PlanUnrestricted" // c.PlanUnrestricted()
`)); err != nil {
		t.Fatal(err)
	}
}
