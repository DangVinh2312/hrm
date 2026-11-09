package test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/modules/setting"
)

var intervalLiteral = regexp.MustCompile(`interval '[^']*'`)

// stringConstant is the value of a package-level string constant of file, read from the source because
// the constants the statements of authentication use are not exported.
func stringConstant(t *testing.T, file, name string) string {
	t.Helper()
	parsed, err := parser.ParseFile(token.NewFileSet(), filepath.Join(moduleRoot(t), file), nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	for _, decl := range parsed.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			value, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, ident := range value.Names {
				if ident.Name != name || i >= len(value.Values) {
					continue
				}
				literal, ok := value.Values[i].(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					t.Fatalf("%s.%s is not one string literal", file, name)
				}
				text, err := strconv.Unquote(literal.Value)
				if err != nil {
					t.Fatal(err)
				}
				return text
			}
		}
	}
	t.Fatalf("no constant %s in %s", name, file)
	return ""
}

// resolveSession is the body of the one definition of resolve_session across the migrations.
func resolveSession(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(moduleRoot(t), "internal", "database", "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var bodies []string
	for _, entry := range entries {
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for rest := string(raw); ; {
			_, after, found := strings.Cut(rest, "FUNCTION public.resolve_session(p_digest bytea)")
			if !found {
				break
			}
			body, tail, closed := strings.Cut(after, "$fn$;")
			if !closed {
				t.Fatalf("%s: resolve_session has no end", entry.Name())
			}
			bodies, rest = append(bodies, body), tail
		}
	}
	if len(bodies) != 1 {
		t.Fatalf("resolve_session is defined %d times; this test reads one", len(bodies))
	}
	return bodies[0]
}

// The security page shows the timings the code enforces: each value of the view is the one interval of
// the statement that enforces it, so changing either side alone fails here.
func TestTheSecurityPageShowsTheTimingsTheStatementsEnforce(t *testing.T) {
	policy := setting.SecurityPolicy()
	for _, c := range []struct {
		where, statement, want string
	}{
		{"credential.FreshAuthSQL", credential.FreshAuthSQL, fmt.Sprintf("interval '%d seconds'", policy.FreshAuthenticationSeconds)},
		{"insertSession", stringConstant(t, "internal/authentication/session_service.go", "insertSession"), fmt.Sprintf("interval '%d hours'", policy.SessionHours)},
		{"deleteExpired", stringConstant(t, "internal/authentication/rate_limit_service.go", "deleteExpired"), fmt.Sprintf("interval '%d minutes'", policy.RateLimitWindowMinutes)},
		{"insertAttempt", stringConstant(t, "internal/authentication/oidc_service.go", "insertAttempt"), fmt.Sprintf("interval '%d minutes'", policy.OidcAttemptMinutes)},
		{"resolve_session", resolveSession(t), fmt.Sprintf("interval '%d minutes'", policy.IdleMinutes)},
	} {
		if got := intervalLiteral.FindAllString(c.statement, -1); len(got) != 1 || got[0] != c.want {
			t.Errorf("%s enforces %q, the page shows %q", c.where, got, c.want)
		}
	}
	if !strings.Contains(resolveSession(t), fmt.Sprintf("s.last_seen_at>statement_timestamp()-interval '%d minutes'", policy.IdleMinutes)) {
		t.Error("the idle timeout of resolve_session is not the one the page shows")
	}
}
