package authority_test

import (
	"reflect"
	"testing"

	"hrm/api/internal/authorization/authority"
	"hrm/api/internal/authorization/compiler"
)

func TestScopeArgsAppendValuesAfterThePlanParameters(t *testing.T) {
	scope := authority.Scope{
		SQL:        "r.a = $1 AND r.b = $2 AND r.c = $3 AND r.d = $4",
		Parameters: []compiler.Param{compiler.TextParam("x"), compiler.BoolParam(true), compiler.IntParam(7), compiler.BytesParam([]byte{1, 2})},
	}
	args, at, err := scope.Args("name", int64(3))
	if err != nil {
		t.Fatal(err)
	}
	if want := []any{"x", true, int64(7), []byte{1, 2}, "name", int64(3)}; !reflect.DeepEqual(args, want) {
		t.Fatalf("args %#v", args)
	}
	if at(1) != "$5" || at(2) != "$6" {
		t.Fatalf("placeholders %s %s", at(1), at(2))
	}
	if at(0) != "" || at(-1) != "" {
		t.Fatalf("an index below 1 must not name a parameter: %q %q", at(0), at(-1))
	}
}

func TestScopeArgsWithoutPlanParametersStartAtOne(t *testing.T) {
	args, at, err := authority.Scope{SQL: "true"}.Args("a")
	if err != nil || !reflect.DeepEqual(args, []any{"a"}) || at(1) != "$1" {
		t.Fatalf("%#v %q %v", args, at(1), err)
	}
}

func TestScopeArgsDoNotAliasThePlanParameters(t *testing.T) {
	scope := authority.Scope{SQL: "true", Parameters: []compiler.Param{compiler.BytesParam([]byte{1})}}
	args, _, err := scope.Args()
	if err != nil {
		t.Fatal(err)
	}
	args[0].([]byte)[0] = 9
	again, _, err := scope.Args()
	if err != nil || again[0].([]byte)[0] != 1 {
		t.Fatalf("a caller changed the plan: %v %v", again, err)
	}
}

func TestScopeArgsRefuseAParameterWithoutAKind(t *testing.T) {
	scope := authority.Scope{SQL: "true", Parameters: []compiler.Param{{}}}
	args, at, err := scope.Args("a")
	if err == nil || args != nil || at != nil {
		t.Fatalf("accepted an invalid parameter: %v %v", args, err)
	}
}
