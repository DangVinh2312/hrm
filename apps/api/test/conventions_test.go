package test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/scanner"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

const maxCodeLines = 300

var snakeCaseFile = regexp.MustCompile(`^[a-z0-9]+(_[a-z0-9]+)*\.go$`)

func moduleRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatal(err)
	}
	return root
}

// moduleFiles returns every .go file of the module, slash-separated and relative to its root.
func moduleFiles(t *testing.T) map[string][]byte {
	t.Helper()
	root := moduleRoot(t)
	files := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if path == filepath.Join(root, "dist") || path == filepath.Join(root, "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(relative)] = source
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func checkFileName(path string) error {
	if name := filepath.Base(path); !snakeCaseFile.MatchString(name) {
		return fmt.Errorf("%s: the file name is not snake_case", path)
	}
	return nil
}

// codeLines counts lines that hold a token, the way ESLint max-lines skips blank and comment lines:
// a line that only has whitespace inside a raw string does not count.
func codeLines(source []byte) (int, error) {
	fset := token.NewFileSet()
	file := fset.AddFile("", fset.Base(), len(source))
	var problems scanner.ErrorList
	var scan scanner.Scanner
	scan.Init(file, source, func(position token.Position, message string) {
		problems.Add(position, message)
	}, 0)
	lines := map[int]bool{}
	for {
		position, kind, literal := scan.Scan()
		if kind == token.EOF {
			break
		}
		if kind == token.SEMICOLON && literal == "\n" {
			continue
		}
		start := file.Line(position)
		for offset, text := range strings.Split(literal, "\n") {
			if offset == 0 || strings.TrimSpace(text) != "" {
				lines[start+offset] = true
			}
		}
		lines[start] = true
	}
	if err := problems.Err(); err != nil {
		return 0, err
	}
	return len(lines), nil
}

func checkFileSize(path string, source []byte) error {
	for _, exempt := range []string{"_declarations.go", "_schema.go", "_test.go"} {
		if strings.HasSuffix(path, exempt) {
			return nil
		}
	}
	if !strings.HasSuffix(path, ".go") {
		return nil
	}
	count, err := codeLines(source)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if count > maxCodeLines {
		return fmt.Errorf("%s: %d lines of code, the limit is %d", path, count, maxCodeLines)
	}
	return nil
}

// A helper stays synchronous and pure: what would need context or I/O belongs to a repository or a service.
// crypto/rand stays allowed: the TOTP and MFA encryption helpers draw secrets and nonces.
var helperForbiddenImports = []string{
	"bufio", "context", "database", "io", "log", "net", "os", "path/filepath", "syscall",
	"github.com/coreos/go-oidc", "github.com/gin-gonic/gin", "github.com/jackc/pgx",
	"github.com/xuri/excelize", "golang.org/x/oauth2", "hrm/api/internal/database",
}

func importPath(spec *ast.ImportSpec) string {
	path, err := strconv.Unquote(spec.Path.Value)
	if err != nil {
		return spec.Path.Value
	}
	return path
}

// hasImportPrefix matches on a path boundary, so "io" covers io/fs and not iota/x.
func hasImportPrefix(path string, prefixes []string) bool {
	return slices.ContainsFunc(prefixes, func(prefix string) bool {
		return path == prefix || strings.HasPrefix(path, prefix+"/")
	})
}

// localNames lists every name a file gives an import; a file may import a package twice.
func localNames(file *ast.File, path string) []string {
	var names []string
	for _, spec := range file.Imports {
		if importPath(spec) != path {
			continue
		}
		if spec.Name != nil {
			names = append(names, spec.Name.Name)
		} else {
			names = append(names, path[strings.LastIndex(path, "/")+1:])
		}
	}
	return names
}

func isSelector(expression ast.Expr, name, selected string) bool {
	selector, ok := expression.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	ident, ok := selector.X.(*ast.Ident)
	return ok && ident.Name == name && selector.Sel.Name == selected
}

func checkHelper(path string, source []byte) error {
	if !strings.HasSuffix(path, "_helper.go") {
		return nil
	}
	file, err := parser.ParseFile(token.NewFileSet(), path, source, parser.SkipObjectResolution)
	if err != nil {
		return err
	}
	contextNames := localNames(file, "context")
	var takesContext bool
	ast.Inspect(file, func(node ast.Node) bool {
		if function, ok := node.(*ast.FuncType); ok && function.Params != nil {
			for _, parameter := range function.Params.List {
				for _, name := range contextNames {
					takesContext = takesContext || isSelector(parameter.Type, name, "Context")
				}
			}
		}
		return true
	})
	if takesContext {
		return fmt.Errorf("%s: a helper takes context.Context", path)
	}
	for _, spec := range file.Imports {
		if imported := importPath(spec); hasImportPrefix(imported, helperForbiddenImports) {
			return fmt.Errorf("%s: a helper imports %s", path, imported)
		}
	}
	return nil
}

// checkTxInGoroutine holds the rule of the runner: a transaction lives on the goroutine of its callback.
// It reads a parameter of type *Tx in any function and a `go` statement that names it.
func checkTxInGoroutine(path string, source []byte) error {
	file, err := parser.ParseFile(token.NewFileSet(), path, source, parser.SkipObjectResolution)
	if err != nil {
		return err
	}
	var found error
	check := func(params *ast.FieldList, body *ast.BlockStmt) {
		if params == nil || body == nil {
			return
		}
		for _, parameter := range params.List {
			star, pointer := parameter.Type.(*ast.StarExpr)
			if !pointer || !isTxType(star.X) {
				continue
			}
			for _, name := range parameter.Names {
				if goroutineUses(body, name.Name) {
					found = fmt.Errorf("%s: a goroutine uses the transaction %s", path, name.Name)
				}
			}
		}
	}
	ast.Inspect(file, func(node ast.Node) bool {
		switch function := node.(type) {
		case *ast.FuncDecl:
			check(function.Type.Params, function.Body)
		case *ast.FuncLit:
			check(function.Type.Params, function.Body)
		}
		return true
	})
	return found
}

// checkRepositoryTx holds the repository rule: tx comes in as a parameter and is kept nowhere, because a
// stored Tx outlives the callback that owns it.
func checkRepositoryTx(path string, source []byte) error {
	if !strings.HasSuffix(path, "_repository.go") {
		return nil
	}
	file, err := parser.ParseFile(token.NewFileSet(), path, source, parser.SkipObjectResolution)
	if err != nil {
		return err
	}
	var found error
	ast.Inspect(file, func(node ast.Node) bool {
		if structure, ok := node.(*ast.StructType); ok {
			for _, field := range structure.Fields.List {
				if holdsTx(field.Type) {
					found = fmt.Errorf("%s: a struct field holds the transaction", path)
				}
			}
		}
		return true
	})
	for _, declaration := range file.Decls {
		general, ok := declaration.(*ast.GenDecl)
		if !ok || general.Tok != token.VAR {
			continue
		}
		for _, spec := range general.Specs {
			if value, isValue := spec.(*ast.ValueSpec); isValue && value.Type != nil && holdsTx(value.Type) {
				found = fmt.Errorf("%s: a package variable holds the transaction", path)
			}
		}
	}
	return found
}

func holdsTx(expression ast.Expr) bool {
	if star, ok := expression.(*ast.StarExpr); ok {
		expression = star.X
	}
	return isTxType(expression)
}

// SQL names its columns. This scans string literals, not SQL: SQL assembled from fragments is read
// fragment by fragment, and CTE names are collected over the whole file.
var (
	returningStar = regexp.MustCompile(`(?i)RETURNING\s+(?:\w+\.)?\*`)
	aliasStar     = regexp.MustCompile(`(?i)(?:SELECT|,)\s+(?:DISTINCT\s+)?\w+\.\*`)
	selectStar    = regexp.MustCompile(`(?i)SELECT\s+(?:DISTINCT\s+)?\*\s+FROM\s+(\(|[\w.]+)`)
	cteName       = regexp.MustCompile(`(?i)\b(\w+)\s+AS\s*\(`)
	wholeRowJSON  = regexp.MustCompile(`(?i)row_to_json\s*\(|to_jsonb\s*\(\s*\w+\s*\)`)
)

// The code-owned state hash is defined over whole rows; naming columns there would change the hash.
const wholeRowAllowed = "internal/authorization/manifest/protected_state_repository.go"

func stringLiterals(path string, source []byte) ([]string, error) {
	file, err := parser.ParseFile(token.NewFileSet(), path, source, parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}
	var literals []string
	var failure error
	ast.Inspect(file, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		value, err := strconv.Unquote(literal.Value)
		if err != nil {
			failure = err
		}
		literals = append(literals, value)
		return true
	})
	return literals, failure
}

func checkExplicitColumns(path string, source []byte) error {
	if strings.HasSuffix(path, "_test.go") {
		return nil
	}
	literals, err := stringLiterals(path, source)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	ctes := map[string]bool{}
	for _, literal := range literals {
		for _, match := range cteName.FindAllStringSubmatch(literal, -1) {
			ctes[strings.ToLower(match[1])] = true
		}
	}
	var found []string
	for _, literal := range literals {
		found = append(found, returningStar.FindAllString(literal, -1)...)
		found = append(found, aliasStar.FindAllString(literal, -1)...)
		for _, match := range selectStar.FindAllStringSubmatch(literal, -1) {
			if from := strings.ToLower(match[1]); from != "(" && !ctes[from] {
				found = append(found, match[0])
			}
		}
		if path != wholeRowAllowed {
			found = append(found, wholeRowJSON.FindAllString(literal, -1)...)
		}
	}
	if len(found) > 0 {
		return fmt.Errorf("%s: SQL does not name its columns: %s", path, strings.Join(found, "; "))
	}
	return nil
}

func isTxType(expression ast.Expr) bool {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name == "Tx"
	case *ast.SelectorExpr:
		return typed.Sel.Name == "Tx"
	default:
		return false
	}
}

func goroutineUses(body *ast.BlockStmt, name string) bool {
	uses := false
	ast.Inspect(body, func(node ast.Node) bool {
		statement, isGo := node.(*ast.GoStmt)
		if !isGo {
			return true
		}
		ast.Inspect(statement, func(inner ast.Node) bool {
			if identifier, ok := inner.(*ast.Ident); ok && identifier.Name == name {
				uses = true
			}
			return true
		})
		return false
	})
	return uses
}

func TestCheckTxInGoroutine(t *testing.T) {
	const header = "package p\nimport (\"context\"; \"hrm/api/internal/database\")\n"
	cases := map[string]struct {
		source string
		bad    bool
	}{
		"closure in a callback": {`func f(r *database.Runner) { database.Run(nil, r, database.ModeRead, func(ctx context.Context, tx *database.Tx) (int, error) {
			go func() { tx.Exec("SELECT 1") }()
			return 0, nil
		}, database.RunOptions{}) }`, true},
		"direct call": {`func g(ctx context.Context, tx *database.Tx) { go tx.Exec("SELECT 1") }`, true},
		"passed on":   {`func g(ctx context.Context, tx *database.Tx) { go h(tx) }`, true},
		"inside the package": {`type Tx struct{}
			func g(tx *Tx) { go h(tx) }`, true},
		"a goroutine that does not name it": {`func g(ctx context.Context, tx *database.Tx, cancel func()) { go cancel() }`, false},
		"no goroutine":                      {`func g(ctx context.Context, tx *database.Tx) { tx.Exec("SELECT 1") }`, false},
		"another name":                      {`func g(ctx context.Context, tx *database.Tx, other *int) { go h(other) }`, false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := checkTxInGoroutine("x.go", []byte(header+c.source+"\n"))
			if (err != nil) != c.bad {
				t.Errorf("got %v, want a violation: %v", err, c.bad)
			}
		})
	}
}

func TestCheckRepositoryTx(t *testing.T) {
	const header = "package p\nimport \"hrm/api/internal/database\"\n"
	cases := map[string]struct {
		path, source string
		bad          bool
	}{
		"field":                 {"a_repository.go", "type R struct{ tx *database.Tx }", true},
		"value field":           {"a_repository.go", "type R struct{ tx database.Tx }", true},
		"anonymous struct":      {"a_repository.go", "func f() { _ = struct{ tx *database.Tx }{} }", true},
		"package variable":      {"a_repository.go", "var current *database.Tx", true},
		"grouped variable":      {"a_repository.go", "var (\n n int\n current *database.Tx\n)", true},
		"inside the package":    {"a_repository.go", "type Tx struct{}\ntype R struct{ tx *Tx }", true},
		"parameter":             {"a_repository.go", "func Read(tx *database.Tx, id string) error { return nil }", false},
		"runner field":          {"a_repository.go", "type R struct{ runner *database.Runner }", false},
		"not a repository":      {"a_types.go", "type C struct{ Tx *database.Tx }", false},
		"unparsable repository": {"a_repository.go", "func (", true},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := checkRepositoryTx(c.path, []byte(header+c.source+"\n"))
			if (err != nil) != c.bad {
				t.Errorf("got %v, want a violation: %v", err, c.bad)
			}
		})
	}
}

func TestCheckExplicitColumns(t *testing.T) {
	cases := map[string]struct {
		path, source string
		bad          bool
	}{
		"select star":                          {"a.go", "const q = `SELECT * FROM employee`", true},
		"alias star":                           {"a.go", "const q = `SELECT s.id, x.* FROM t x`", true},
		"alias star first":                     {"a.go", "const q = `SELECT s.* FROM public.resolve_session($1) s`", true},
		"returning star":                       {"a.go", "const q = `UPDATE t SET a = 1 RETURNING *`", true},
		"interpreted string":                   {"a.go", "const q = \"SELECT * FROM employee\"", true},
		"whole-row to_jsonb":                   {"a.go", "const q = `SELECT to_jsonb(t) FROM t`", true},
		"whole-row row_to_json":                {"a.go", "const q = `SELECT row_to_json(t) FROM t`", true},
		"cte forwarding":                       {"a.go", "const q = `WITH u AS (UPDATE t SET a = 1 RETURNING a) SELECT * FROM u`", false},
		"cte in another literal":               {"a.go", "const w = `WITH u AS (DELETE FROM t RETURNING a) `\nconst q = w + `SELECT * FROM u`", false},
		"subquery wrapper":                     {"a.go", "const q = `SELECT * FROM (SELECT a, b FROM t) p`", false},
		"count star":                           {"a.go", "const q = `SELECT a, count(*) OVER () FROM t`", false},
		"comment":                              {"a.go", "// SELECT * FROM t\nconst q = `SELECT a FROM t`", false},
		"explicit columns":                     {"a.go", "const q = `SELECT a, b FROM t RETURNING a`", false},
		"test file":                            {"a_test.go", "const q = `SELECT * FROM t`", false},
		"state hash":                           {wholeRowAllowed, "const q = `SELECT to_jsonb(t)::text FROM x t`", false},
		"state hash still names other columns": {wholeRowAllowed, "const q = `SELECT * FROM x`", true},
		"unparsable":                           {"a.go", "const q = `open", true},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := checkExplicitColumns(c.path, []byte("package p\n"+c.source+"\n"))
			if (err != nil) != c.bad {
				t.Errorf("got %v, want a violation: %v", err, c.bad)
			}
		})
	}
}

func TestConventionsHoldOnTheModule(t *testing.T) {
	files := moduleFiles(t)
	for _, expected := range []string{
		"cmd/api/main.go", "internal/config/config.go", "test/conventions_test.go",
	} {
		if _, found := files[expected]; !found {
			t.Fatalf("the walk missed %s", expected)
		}
	}
	for path, source := range files {
		for _, err := range []error{
			checkFileName(path), checkFileSize(path, source), checkHelper(path, source), checkTxInGoroutine(path, source),
			checkRepositoryTx(path, source), checkExplicitColumns(path, source),
		} {
			if err != nil {
				t.Error(err)
			}
		}
	}
}

func TestCheckFileName(t *testing.T) {
	for path, accepted := range map[string]bool{
		"internal/x/session_repository.go":    true,
		"internal/x/a1_b2.go":                 true,
		"cmd/api/main.go":                     true,
		"internal/x/read_test.go":             true,
		"internal/x/read_integration_test.go": true,
		"internal/x/sessionRepository.go":     false,
		"internal/x/session-repository.go":    false,
		"internal/x/Session_repository.go":    false,
		"internal/x/session__repository.go":   false,
		"internal/x/_session.go":              false,
		"internal/x/session_.go":              false,
		"internal/x/session.repository.go":    false,
	} {
		t.Run(path, func(t *testing.T) {
			if err := checkFileName(path); (err == nil) != accepted {
				t.Errorf("accepted %v, got %v", accepted, err)
			}
		})
	}
}

func codeOfLines(count int) string {
	return "package x\n" + strings.Repeat("var _ = 1\n", count-1)
}

func TestCodeLinesSkipBlankAndComments(t *testing.T) {
	cases := map[string]struct {
		source string
		want   int
	}{
		"blank lines":            {"package x\n\n\nvar a = 1\n", 2},
		"line comments":          {"// head\npackage x\n// body\nvar a = 1 // tail\n", 2},
		"block comment":          {"package x\n/* one\ntwo\nthree */\nvar a = 1\n", 2},
		"raw string":             {"package x\nvar a = `one\n\n  \ntwo\nthree`\n", 4},
		"no newline at the end":  {"package x\nvar a = 1", 2},
		"code after a comment":   {"package x\n/* c */ var a = 1\n", 2},
		"several tokens a line":  {"package x\nvar a, b = 1, 2\n", 2},
		"comment marks in a raw": {"package x\nvar a = `// not a comment\n/* nor this */`\n", 3},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := codeLines([]byte(c.source))
			if err != nil || got != c.want {
				t.Errorf("%d, %v; want %d", got, err, c.want)
			}
		})
	}
}

func TestCheckFileSize(t *testing.T) {
	padded := codeOfLines(maxCodeLines) + strings.Repeat("// comment\n\n", 50)
	cases := map[string]struct {
		path     string
		source   string
		accepted bool
	}{
		"at the limit":            {"a_service.go", codeOfLines(maxCodeLines), true},
		"above the limit":         {"a_service.go", codeOfLines(maxCodeLines + 1), false},
		"comments do not count":   {"a_service.go", padded, true},
		"declarations are exempt": {"a_declarations.go", codeOfLines(maxCodeLines + 1), true},
		"schema is exempt":        {"a_schema.go", codeOfLines(maxCodeLines + 1), true},
		"tests are exempt":        {"a_test.go", codeOfLines(maxCodeLines + 1), true},
		"SQL is exempt":           {"1_a.sql", strings.Repeat("SELECT 1;\n", maxCodeLines+1), true},
		"helper is not exempt":    {"a_helper.go", codeOfLines(maxCodeLines + 1), false},
		"unreadable source":       {"a_service.go", "package x\nvar a = `open", false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if err := checkFileSize(c.path, []byte(c.source)); (err == nil) != c.accepted {
				t.Errorf("accepted %v, got %v", c.accepted, err)
			}
		})
	}
}

func TestCheckHelper(t *testing.T) {
	cases := map[string]struct {
		path     string
		source   string
		accepted bool
	}{
		"pure":                   {"a_helper.go", "package x\nimport \"strings\"\nfunc F(s string) string { return strings.ToLower(s) }\n", true},
		"takes a context":        {"a_helper.go", "package x\nimport \"context\"\nfunc F(ctx context.Context) {}\n", false},
		"renamed context":        {"a_helper.go", "package x\nimport c \"context\"\nfunc F(ctx c.Context) {}\n", false},
		"method":                 {"a_helper.go", "package x\nimport \"context\"\ntype T struct{}\nfunc (T) F(_ int, ctx context.Context) {}\n", false},
		"function literal":       {"a_helper.go", "package x\nimport \"context\"\nvar F = func(ctx context.Context) {}\n", false},
		"imports context":        {"a_helper.go", "package x\nimport \"context\"\nvar B = context.Background\n", false},
		"imports net/http":       {"a_helper.go", "package x\nimport \"net/http\"\nvar G = http.Get\n", false},
		"imports os":             {"a_helper.go", "package x\nimport \"os\"\nvar R = os.ReadFile\n", false},
		"imports io":             {"a_helper.go", "package x\nimport \"io\"\nvar E = io.EOF\n", false},
		"imports pgx":            {"a_helper.go", "package x\nimport \"github.com/jackc/pgx/v5\"\nvar C = pgx.Connect\n", false},
		"imports database":       {"a_helper.go", "package x\nimport \"hrm/api/internal/database\"\nvar R database.Runner\n", false},
		"imports filepath":       {"a_helper.go", "package x\nimport \"path/filepath\"\nvar W = filepath.WalkDir\n", false},
		"imports oauth2":         {"a_helper.go", "package x\nimport \"golang.org/x/oauth2\"\nvar C oauth2.Config\n", false},
		"imports go-oidc":        {"a_helper.go", "package x\nimport \"github.com/coreos/go-oidc/v3/oidc\"\nvar P oidc.Provider\n", false},
		"imports excelize":       {"a_helper.go", "package x\nimport \"github.com/xuri/excelize/v2\"\nvar N = excelize.NewFile\n", false},
		"imports crypto/rand":    {"a_helper.go", "package x\nimport \"crypto/rand\"\nvar T = rand.Text\n", true},
		"plain path package":     {"a_helper.go", "package x\nimport \"path\"\nvar B = path.Base\n", true},
		"second name of context": {"a_helper.go", "package x\nimport a \"context\"\nimport b \"context\"\nvar _ = a.Background\nfunc F(ctx b.Context) {}\n", false},
		"not a helper":           {"a_repository.go", "package x\nimport \"context\"\nfunc F(ctx context.Context) {}\n", true},
		"test of a helper":       {"a_helper_test.go", "package x\nimport \"context\"\nfunc F(ctx context.Context) {}\n", true},
		"similar import":         {"a_helper.go", "package x\nimport \"iota/x\"\nvar A = x.A\n", true},
		"unparsable helper":      {"a_helper.go", "package x\nfunc (", false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if err := checkHelper(c.path, []byte(c.source)); (err == nil) != c.accepted {
				t.Errorf("accepted %v, got %v", c.accepted, err)
			}
		})
	}
}
