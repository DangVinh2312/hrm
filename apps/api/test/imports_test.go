package test

import (
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/build"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

const (
	modulePath  = "hrm/api"
	rootPackage = "."
)

// graph maps a package, relative to the module, to the internal packages it imports.
type graph map[string][]string

// goPackage is the part of `go list -json` the rules read; Imports and Deps hold full import paths.
type goPackage struct {
	ImportPath string
	Imports    []string
	Deps       []string
	Error      *struct{ Err string }
}

var (
	fencedText = regexp.MustCompile("(?s)```text\n(.*?)```")
	dagLine    = regexp.MustCompile(`^(\S+) ->(?: (\S.*))?$`)
)

func parseDAG(document string) (graph, error) {
	blocks := fencedText.FindAllStringSubmatch(document, -1)
	if len(blocks) != 1 {
		return nil, fmt.Errorf("package-dag.md has %d text blocks, want 1", len(blocks))
	}
	dag := graph{}
	for _, line := range strings.Split(strings.TrimSpace(blocks[0][1]), "\n") {
		match := dagLine.FindStringSubmatch(line)
		if match == nil {
			return nil, fmt.Errorf("malformed line %q", line)
		}
		if _, duplicate := dag[match[1]]; duplicate {
			return nil, fmt.Errorf("package %s is listed twice", match[1])
		}
		dag[match[1]] = []string{}
		if match[2] != "" {
			dag[match[1]] = strings.Split(match[2], ", ")
		}
	}
	for from, targets := range dag {
		for _, target := range targets {
			if _, known := dag[target]; !known {
				return nil, fmt.Errorf("%s imports %s, which is not a package of the block", from, target)
			}
		}
	}
	return dag, nil
}

func readDAG(t *testing.T) graph {
	t.Helper()
	document, err := os.ReadFile(filepath.Join(moduleRoot(t), "contract", "package-dag.md"))
	if err != nil {
		t.Fatal(err)
	}
	dag, err := parseDAG(string(document))
	if err != nil {
		t.Fatal(err)
	}
	return dag
}

func findCycle(dag graph) []string {
	const (
		visiting = 1
		done     = 2
	)
	state := map[string]int{}
	var path []string
	var visit func(node string) []string
	visit = func(node string) []string {
		switch state[node] {
		case done:
			return nil
		case visiting:
			return append(slices.Clone(path[slices.Index(path, node):]), node)
		}
		state[node] = visiting
		path = append(path, node)
		for _, target := range dag[node] {
			if cycle := visit(target); cycle != nil {
				return cycle
			}
		}
		path = path[:len(path)-1]
		state[node] = done
		return nil
	}
	nodes := make([]string, 0, len(dag))
	for node := range dag {
		nodes = append(nodes, node)
	}
	slices.Sort(nodes)
	for _, node := range nodes {
		if cycle := visit(node); cycle != nil {
			return cycle
		}
	}
	return nil
}

func listPackages(t *testing.T) []goPackage {
	t.Helper()
	command := exec.Command("go", "list", "-e", "-json=ImportPath,Imports,Deps,Error", "./...")
	command.Dir = moduleRoot(t)
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(output)))
	var packages []goPackage
	for {
		var listed goPackage
		if err := decoder.Decode(&listed); errors.Is(err, io.EOF) {
			return packages
		} else if err != nil {
			t.Fatal(err)
		}
		if listed.Error != nil {
			t.Fatalf("%s does not load", listed.ImportPath)
		}
		packages = append(packages, listed)
	}
}

// relative also recognizes the package at the module root, which the block does not list.
func relative(importPath string) (string, bool) {
	if importPath == modulePath {
		return rootPackage, true
	}
	return strings.CutPrefix(importPath, modulePath+"/")
}

func isTestPackage(path string) bool {
	return path == "test" || strings.HasPrefix(path, "test/")
}

func isStandardLibrary(importPath string) bool {
	first, _, _ := strings.Cut(importPath, "/")
	return !strings.Contains(first, ".") && first != "hrm"
}

// checkAgainstDAG fails an import that is not an edge of the block and a package the block does not list.
func checkAgainstDAG(packages []goPackage, dag graph) []string {
	var violations []string
	for _, listed := range packages {
		from, inside := relative(listed.ImportPath)
		if !inside || isTestPackage(from) {
			continue
		}
		allowed, known := dag[from]
		if !known {
			violations = append(violations, from+" is not a package of package-dag.md")
			continue
		}
		for _, imported := range listed.Imports {
			target, internal := relative(imported)
			if internal && !slices.Contains(allowed, target) {
				violations = append(violations, from+" -> "+target+" is not an edge of package-dag.md")
			}
		}
	}
	return violations
}

const modulesPrefix = "internal/modules/"

var (
	sharedModules = []string{
		"internal/modules/attendancecore", "internal/modules/hrbase", "internal/modules/leavecore",
		"internal/modules/permission", "internal/modules/schedulecore", "internal/modules/settingcore",
	}
	modulesWithoutHRCore = []string{
		"internal/modules/employee", "internal/modules/role", "internal/modules/setting", "internal/modules/team",
	}
	hrCore = []string{
		"internal/modules/attendancecore", "internal/modules/leavecore", "internal/modules/schedulecore",
	}
)

// checkEdgeRules holds the rules that read edges only, so they run on the block and on the real imports.
func checkEdgeRules(edges graph) []string {
	var violations []string
	for from, targets := range edges {
		for _, target := range targets {
			edge := from + " -> " + target
			if strings.HasPrefix(from, modulesPrefix) && strings.HasPrefix(target, modulesPrefix) &&
				!slices.Contains(sharedModules, target) {
				violations = append(violations, edge+": a module imports only the shared packages")
			}
			if slices.Contains(modulesWithoutHRCore, from) && slices.Contains(hrCore, target) {
				violations = append(violations, edge+": this module does not use the HR core")
			}
			if target == "internal/authentication" && from != "internal/app" {
				violations = append(violations, edge+": only internal/app imports internal/authentication")
			}
			if target == "internal/offline" && from != "cmd/hrmctl" {
				violations = append(violations, edge+": only cmd/hrmctl imports internal/offline")
			}
			if from == "internal/authorization/core" {
				violations = append(violations, edge+": core imports the standard library only")
			}
		}
	}
	return violations
}

func edgesOf(packages []goPackage) graph {
	edges := graph{}
	for _, listed := range packages {
		from, inside := relative(listed.ImportPath)
		if !inside || isTestPackage(from) {
			continue
		}
		edges[from] = []string{}
		for _, imported := range listed.Imports {
			if target, internal := relative(imported); internal {
				edges[from] = append(edges[from], target)
			}
		}
	}
	return edges
}

// checkExternalImports keeps the pure packages free of every module outside the standard library.
func checkExternalImports(packages []goPackage) []string {
	var violations []string
	for _, listed := range packages {
		from, _ := relative(listed.ImportPath)
		if from != "internal/authorization/core" {
			continue
		}
		for _, imported := range listed.Imports {
			if _, internal := relative(imported); !internal && !isStandardLibrary(imported) {
				violations = append(violations, from+" imports "+imported)
			}
		}
	}
	return violations
}

var (
	authorityForbiddenDeps = []string{
		modulePath + "/internal/authentication", modulePath + "/internal/httpapi",
		"github.com/gin-gonic/gin", "github.com/coreos/go-oidc",
	}
	moduleForbiddenDeps = []string{
		modulePath + "/internal/authentication", "github.com/coreos/go-oidc", "golang.org/x/oauth2", "github.com/go-jose/go-jose",
	}
	// internal/database reaches every binary, and cmd/api must not link goose through it.
	databaseForbiddenDeps = []string{"github.com/pressly/goose"}
	apiForbiddenDeps      = []string{modulePath + "/internal/offline", "github.com/pressly/goose", "github.com/testcontainers/testcontainers-go"}
)

// hasDep matches an external module with its subpackages. An internal package matches exactly, since
// internal/authentication/credential is allowed where internal/authentication is not.
func hasDep(deps []string, forbidden string) bool {
	_, internal := relative(forbidden)
	return slices.ContainsFunc(deps, func(dep string) bool {
		return dep == forbidden || (!internal && strings.HasPrefix(dep, forbidden+"/"))
	})
}

// checkClosures is the `go list -deps` rule: a binary or a package must not link what it never needs.
func checkClosures(packages []goPackage) []string {
	var violations []string
	for _, listed := range packages {
		from, inside := relative(listed.ImportPath)
		if !inside {
			continue
		}
		var forbidden []string
		switch {
		case from == "internal/authorization/authority", from == "cmd/hrmctl":
			forbidden = authorityForbiddenDeps
		case strings.HasPrefix(from, modulesPrefix), from == "internal/administration":
			forbidden = moduleForbiddenDeps
		case from == "cmd/api":
			forbidden = apiForbiddenDeps
		case from == "internal/database":
			forbidden = databaseForbiddenDeps
		}
		for _, dep := range forbidden {
			if hasDep(listed.Deps, dep) {
				violations = append(violations, from+" links "+dep)
			}
		}
	}
	return violations
}

// closuresOfDAG gives each node of the block its transitive imports, so the closure rule holds before
// the packages exist.
func closuresOfDAG(dag graph) []goPackage {
	packages := make([]goPackage, 0, len(dag))
	for node := range dag {
		seen := map[string]bool{}
		var walk func(string)
		walk = func(from string) {
			for _, target := range dag[from] {
				if !seen[target] {
					seen[target] = true
					walk(target)
				}
			}
		}
		walk(node)
		deps := make([]string, 0, len(seen))
		for dep := range seen {
			deps = append(deps, modulePath+"/"+dep)
		}
		packages = append(packages, goPackage{ImportPath: modulePath + "/" + node, Deps: deps})
	}
	return packages
}

// handlerForbiddenImports is the boundary of apps/api/eslint.config.js in the packages of the DAG:
// its services, helpers and repositories of authorization are authority, manifest and grant, and
// authentication/services is authentication. Go has no type-only import, so TS allowTypeImports has
// no equivalent: a handler that needs such a type uses a type with its own fields, declared in a
// file of its package that is not a handler. An alias such as `type Row = gateway.Row` or a type
// defined from one with fields such as `type Row gateway.Row` is not a way out: checkHandlerTypes
// refuses both.
var handlerForbiddenImports = []string{
	"database/sql",
	"github.com/jackc/pgx",
	modulePath + "/internal/app",
	modulePath + "/internal/audit",
	modulePath + "/internal/authentication",
	modulePath + "/internal/authorization/authority",
	modulePath + "/internal/authorization/compiler",
	modulePath + "/internal/authorization/gateway",
	modulePath + "/internal/authorization/grant",
	modulePath + "/internal/authorization/manifest",
	modulePath + "/internal/database",
	modulePath + "/internal/offline",
}

// isHandlerFile matches the role as a word of the name, so controller.go and a_controller_linux.go
// count; a file of another role that has the word in its name gets the stricter check.
func isHandlerFile(path string) bool {
	name, _ := strings.CutSuffix(filepath.Base(path), ".go")
	if strings.HasSuffix(name, "_test") {
		return false
	}
	words := "_" + name + "_"
	return strings.Contains(words, "_controller_") || strings.Contains(words, "_http_port_")
}

// checkHandlerFile is per file, not per package: a handler shares its package with repositories.
// It reads the import path, so a renamed, dot or blank import and a second name of the same package
// are all refused.
func checkHandlerFile(path string, source []byte) error {
	if !isHandlerFile(path) {
		return nil
	}
	file, err := parser.ParseFile(token.NewFileSet(), path, source, parser.SkipObjectResolution)
	if err != nil {
		return err
	}
	for _, spec := range file.Imports {
		if imported := importPath(spec); hasImportPrefix(imported, handlerForbiddenImports) {
			return fmt.Errorf("%s: a handler imports %s", path, imported)
		}
	}
	return nil
}

// forbiddenFrom says whether a handler of package own may not reach path. The DAG places the handlers of
// auth/* in internal/authentication, so its own services are what they call; what those services hold keeps
// its own package and stays refused.
func forbiddenFrom(own, path string) bool {
	if own == modulePath+"/internal/authentication" && path == own {
		return false
	}
	return hasImportPrefix(path, handlerForbiddenImports)
}

// serviceTypes hold keys, client secrets, new session secrets and the steps under the fence in members a
// handler of their package could otherwise read: forbiddenFrom lets that package through.
var serviceTypes = []string{"Service", "MfaService", "OidcService", "OidcProvider", "SessionCredential"}

// keptMembers lists the unexported fields and methods of serviceTypes. It goes by the object, so a type
// defined from one of them or a struct embedding one reaches the same members and is refused too.
// A name that went away fails, since a rename would otherwise drop the protection with the test still green.
func keptMembers(importPath string, checked *types.Package) (map[types.Object]bool, error) {
	kept := map[types.Object]bool{}
	if importPath != modulePath+"/internal/authentication" {
		return kept, nil
	}
	for _, name := range serviceTypes {
		var named *types.Named
		if object := checked.Scope().Lookup(name); object != nil {
			named, _ = object.Type().(*types.Named)
		}
		if named == nil {
			return nil, fmt.Errorf("internal/authentication does not declare the type %s: update serviceTypes", name)
		}
		structure, ok := named.Underlying().(*types.Struct)
		if !ok {
			return nil, fmt.Errorf("internal/authentication does not declare %s as a struct: update serviceTypes", name)
		}
		for field := range structure.Fields() {
			kept[field] = !field.Exported()
		}
		for method := range named.Methods() {
			kept[method] = !method.Exported()
		}
	}
	return kept, nil
}

// forbiddenPackage finds a package of handlerForbiddenImports in a type. It stops at a defined type of
// another package, so a type a repository file declares with its own fields stays usable by a handler.
// It does not stop at one that embeds a forbidden type, or that takes a field or method from a forbidden
// package (type D database.Runner): those stay callable after a conversion to an interface, a generic
// call or a conversion to a struct, where no selector shows them.
func forbiddenPackage(own string, typ types.Type, seen map[types.Type]bool) string {
	if typ == nil || seen[typ] {
		return ""
	}
	seen[typ] = true
	var parts []types.Type
	switch typ := typ.(type) {
	case *types.Alias:
		parts = append(parts, types.Unalias(typ))
	case *types.Named:
		if pkg := typ.Obj().Pkg(); pkg != nil && forbiddenFrom(own, pkg.Path()) {
			return pkg.Path()
		}
		for argument := range typ.TypeArgs().Types() {
			parts = append(parts, argument)
		}
		switch underlying := typ.Underlying().(type) {
		case *types.Struct:
			for field := range underlying.Fields() {
				if found := declaredForbidden(own, field); found != "" {
					return found
				}
				if field.Embedded() {
					parts = append(parts, field.Type())
				}
			}
		case *types.Interface:
			for method := range underlying.Methods() {
				if found := declaredForbidden(own, method); found != "" {
					return found
				}
			}
			for embedded := range underlying.EmbeddedTypes() {
				parts = append(parts, embedded)
			}
		}
	case *types.Pointer:
		parts = append(parts, typ.Elem())
	case *types.Slice:
		parts = append(parts, typ.Elem())
	case *types.Array:
		parts = append(parts, typ.Elem())
	case *types.Chan:
		parts = append(parts, typ.Elem())
	case *types.Map:
		parts = append(parts, typ.Key(), typ.Elem())
	case *types.Signature:
		parts = append(parts, typ.Params(), typ.Results())
	case *types.Tuple:
		for variable := range typ.Variables() {
			parts = append(parts, variable.Type())
		}
	case *types.Struct:
		for field := range typ.Fields() {
			parts = append(parts, field.Type())
		}
	case *types.Interface:
		for method := range typ.ExplicitMethods() {
			parts = append(parts, method.Type())
		}
		for embedded := range typ.EmbeddedTypes() {
			parts = append(parts, embedded)
		}
	}
	for _, part := range parts {
		if found := forbiddenPackage(own, part, seen); found != "" {
			return found
		}
	}
	return ""
}

// declaredForbidden finds a package of handlerForbiddenImports in where a field or method is declared.
// Only this sees type D database.Runner: D is a defined type of an allowed package, yet d.Limit is a
// field of the runner.
func declaredForbidden(own string, object types.Object) string {
	if pkg := object.Pkg(); pkg != nil && forbiddenFrom(own, pkg.Path()) {
		return pkg.Path()
	}
	return ""
}

// forbiddenSelection finds a package of handlerForbiddenImports in what a selector reaches: the field
// or method itself, or an embedded field it is promoted through.
func forbiddenSelection(own string, selection *types.Selection) string {
	if found := declaredForbidden(own, selection.Obj()); found != "" {
		return found
	}
	current := selection.Recv()
	path := selection.Index()
	for _, index := range path[:len(path)-1] {
		if pointer, ok := current.Underlying().(*types.Pointer); ok {
			current = pointer.Elem()
		}
		structure, ok := current.Underlying().(*types.Struct)
		if !ok {
			return ""
		}
		field := structure.Field(index)
		if found := declaredForbidden(own, field); found != "" {
			return found
		}
		if found := forbiddenPackage(own, field.Type(), map[types.Type]bool{}); found != "" {
			return found
		}
		current = field.Type()
	}
	return ""
}

// checkHandlerTypes type-checks a package and refuses, in its handler files, every expression whose
// type reaches a package of handlerForbiddenImports: an alias declared in another file of the
// package, a field like h.repo.Runner, a variable or function of a repository file. A package that
// does not type-check is refused too.
func checkHandlerTypes(fset *token.FileSet, importPath string, files map[string][]byte, imports types.Importer) error {
	names := slices.Sorted(maps.Keys(files))
	parsed := make([]*ast.File, 0, len(names))
	for _, name := range names {
		file, err := parser.ParseFile(fset, name, files[name], parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		parsed = append(parsed, file)
	}
	info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}, Selections: map[*ast.SelectorExpr]*types.Selection{}}
	checked, err := (&types.Config{Importer: imports}).Check(importPath, fset, parsed, info)
	if err != nil {
		return err
	}
	kept, err := keptMembers(importPath, checked)
	if err != nil {
		return err
	}
	var violations []string
	for expression, value := range info.Types {
		position := fset.Position(expression.Pos())
		if !isHandlerFile(position.Filename) {
			continue
		}
		if found := forbiddenPackage(importPath, value.Type, map[types.Type]bool{}); found != "" {
			violations = append(violations, fmt.Sprintf("%s: a handler reaches %s through %s", position, found, types.ExprString(expression)))
		}
	}
	for selector, selection := range info.Selections {
		position := fset.Position(selector.Pos())
		if !isHandlerFile(position.Filename) {
			continue
		}
		if found := forbiddenSelection(importPath, selection); found != "" {
			violations = append(violations, fmt.Sprintf("%s: a handler reaches %s through %s", position, found, types.ExprString(selector)))
		}
		if kept[selection.Obj()] {
			violations = append(violations, fmt.Sprintf("%s: a handler reads what a service keeps through %s", position, types.ExprString(selector)))
		}
	}
	if len(violations) == 0 {
		return nil
	}
	slices.Sort(violations)
	return errors.New(strings.Join(violations, "\n"))
}

// exportImporter reads the export data the go command builds for dirs and their dependencies.
func exportImporter(t *testing.T, fset *token.FileSet, dirs []string) types.Importer {
	t.Helper()
	arguments := []string{"list", "-export", "-deps", "-json=ImportPath,Export"}
	for _, dir := range dirs {
		arguments = append(arguments, "./"+dir)
	}
	command := exec.Command("go", arguments...)
	command.Dir = moduleRoot(t)
	output, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	exports := map[string]string{}
	decoder := json.NewDecoder(strings.NewReader(string(output)))
	for {
		var listed struct{ ImportPath, Export string }
		if err := decoder.Decode(&listed); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		exports[listed.ImportPath] = listed.Export
	}
	return importer.ForCompiler(fset, "gc", func(path string) (io.ReadCloser, error) {
		if exports[path] == "" {
			return nil, fmt.Errorf("no export data for %s", path)
		}
		return os.Open(exports[path])
	})
}

// packageFiles reads the non-test files of dir that the default build selects.
func packageFiles(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	found, err := build.ImportDir(filepath.Join(moduleRoot(t), dir), 0)
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, name := range found.GoFiles {
		source, err := os.ReadFile(filepath.Join(found.Dir, name))
		if err != nil {
			t.Fatal(err)
		}
		files[name] = source
	}
	return files
}

func dagCounts(dag graph) (int, int) {
	edges := 0
	for _, targets := range dag {
		edges += len(targets)
	}
	return len(dag), edges
}

var recordedCounts = regexp.MustCompile(`nodes=(\d+) edges=(\d+)`)

// checkRecordedCounts keeps the measurement printed in the document in step with its block.
func checkRecordedCounts(document string, dag graph) error {
	match := recordedCounts.FindStringSubmatch(document)
	if match == nil {
		return errors.New("package-dag.md records no nodes= edges= line")
	}
	nodes, edges := dagCounts(dag)
	if want := fmt.Sprintf("nodes=%d edges=%d", nodes, edges); match[0] != want {
		return fmt.Errorf("package-dag.md records %s, the block has %s", match[0], want)
	}
	return nil
}

func TestDAGIsWellFormedAndAcyclic(t *testing.T) {
	document, err := os.ReadFile(filepath.Join(moduleRoot(t), "contract", "package-dag.md"))
	if err != nil {
		t.Fatal(err)
	}
	dag := readDAG(t)
	if err := checkRecordedCounts(string(document), dag); err != nil {
		t.Error(err)
	}
	for _, target := range []string{"internal/apperror", "internal/authentication/credential"} {
		if !slices.Contains(dag["internal/app"], target) {
			t.Errorf("internal/app -> %s is missing: app.module.ts and runtime.module.ts use it", target)
		}
	}
	if cycle := findCycle(dag); cycle != nil {
		t.Errorf("cycle: %s", strings.Join(cycle, " -> "))
	}
}

func TestCheckRecordedCounts(t *testing.T) {
	dag := graph{"a": {"b"}, "b": {}}
	cases := map[string]struct {
		document string
		accepted bool
	}{
		"same":        {"nodes=2 edges=1 undeclared_targets=[]", true},
		"edge behind": {"nodes=2 edges=0", false},
		"node behind": {"nodes=3 edges=1", false},
		"no record":   {"nothing", false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if err := checkRecordedCounts(c.document, dag); (err == nil) != c.accepted {
				t.Errorf("accepted %v, got %v", c.accepted, err)
			}
		})
	}
}

func TestRulesHoldOnTheBlock(t *testing.T) {
	dag := readDAG(t)
	for _, violation := range checkEdgeRules(dag) {
		t.Error(violation)
	}
	for _, violation := range checkClosures(closuresOfDAG(dag)) {
		t.Error(violation)
	}
}

func TestRealImportsFollowTheDAG(t *testing.T) {
	packages := listPackages(t)
	names := make([]string, 0, len(packages))
	for _, listed := range packages {
		names = append(names, listed.ImportPath)
	}
	for _, expected := range []string{
		modulePath + "/cmd/api", modulePath + "/cmd/hrmctl", modulePath + "/internal/config",
		modulePath + "/internal/database", modulePath + "/internal/offline",
	} {
		if !slices.Contains(names, expected) {
			t.Fatalf("go list did not report %s: %q", expected, names)
		}
	}
	violations := checkAgainstDAG(packages, readDAG(t))
	violations = append(violations, checkEdgeRules(edgesOf(packages))...)
	violations = append(violations, checkExternalImports(packages)...)
	violations = append(violations, checkClosures(packages)...)
	for _, violation := range violations {
		t.Error(violation)
	}
}

func TestFileRulesHoldOnTheModule(t *testing.T) {
	var handlerDirs []string
	for path, source := range moduleFiles(t) {
		for _, err := range []error{checkHandlerFile(path, source)} {
			if err != nil {
				t.Error(err)
			}
		}
		if dir := filepath.ToSlash(filepath.Dir(path)); isHandlerFile(path) && !slices.Contains(handlerDirs, dir) {
			handlerDirs = append(handlerDirs, dir)
		}
	}
	if len(handlerDirs) == 0 {
		return
	}
	fset := token.NewFileSet()
	imports := exportImporter(t, fset, handlerDirs)
	for _, dir := range handlerDirs {
		if err := checkHandlerTypes(fset, modulePath+"/"+dir, packageFiles(t, dir), imports); err != nil {
			t.Error(err)
		}
	}
}

func TestParseDAG(t *testing.T) {
	block := func(body string) string { return "intro\n```text\n" + body + "```\nend\n" }
	cases := map[string]struct {
		document string
		accepted bool
	}{
		"edges and a leaf":     {block("a -> b, c\nb -> c\nc ->\n"), true},
		"no block":             {"nothing\n", false},
		"two blocks":           {block("a ->\n") + block("b ->\n"), false},
		"line without arrow":   {block("a b\n"), false},
		"package listed twice": {block("a ->\na ->\n"), false},
		"unknown target":       {block("a -> b\n"), false},
		"trailing comma":       {block("a -> b,\nb ->\n"), false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseDAG(c.document); (err == nil) != c.accepted {
				t.Errorf("accepted %v, got %v", c.accepted, err)
			}
		})
	}
}

func TestFindCycle(t *testing.T) {
	cases := map[string]struct {
		dag  graph
		want bool
	}{
		"chain":     {graph{"a": {"b"}, "b": {"c"}, "c": {}}, false},
		"diamond":   {graph{"a": {"b", "c"}, "b": {"d"}, "c": {"d"}, "d": {}}, false},
		"two nodes": {graph{"a": {"b"}, "b": {"a"}}, true},
		"self":      {graph{"a": {"a"}}, true},
		"far back":  {graph{"a": {"b"}, "b": {"c"}, "c": {"d"}, "d": {"b"}}, true},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := findCycle(c.dag); (got != nil) != c.want {
				t.Errorf("cycle %q, want one: %v", got, c.want)
			}
		})
	}
	withBackEdge := readDAG(t)
	withBackEdge["internal/apperror"] = []string{"internal/httpapi"}
	if findCycle(withBackEdge) == nil {
		t.Error("a back edge in the real block is not a cycle")
	}
}

func fakePackage(path string, imports ...string) goPackage {
	return goPackage{ImportPath: modulePath + "/" + path, Imports: imports}
}

func TestCheckAgainstDAG(t *testing.T) {
	dag := graph{"cmd/api": {"internal/app"}, "internal/app": {}}
	cases := map[string]struct {
		listed goPackage
		bad    bool
	}{
		"declared edge":         {fakePackage("cmd/api", modulePath+"/internal/app", "fmt"), false},
		"external import":       {fakePackage("internal/app", "github.com/gin-gonic/gin"), false},
		"undeclared edge":       {fakePackage("internal/app", modulePath+"/cmd/api"), true},
		"package not in block":  {fakePackage("internal/extra"), true},
		"imports the test tree": {fakePackage("internal/app", modulePath+"/test/fixture"), true},
		"test tree is no node":  {fakePackage("test/fixture", modulePath+"/internal/extra"), false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := checkAgainstDAG([]goPackage{c.listed}, dag); (len(got) > 0) != c.bad {
				t.Errorf("violations %q, want some: %v", got, c.bad)
			}
		})
	}
}

func TestThePackageAtTheModuleRootIsChecked(t *testing.T) {
	root := goPackage{ImportPath: modulePath, Imports: []string{modulePath + "/internal/offline"}}
	if got := checkAgainstDAG([]goPackage{root}, graph{"internal/offline": {}}); len(got) == 0 {
		t.Error("a package at the module root is not reported as missing from the block")
	}
	if got := checkEdgeRules(edgesOf([]goPackage{root})); len(got) == 0 {
		t.Error("hrm/api -> internal/offline is not reported")
	}
	for path, inside := range map[string]bool{
		modulePath:                 true,
		modulePath + "/cmd/api":    true,
		modulePath + "-other/x":    false,
		"github.com/gin-gonic/gin": false,
	} {
		if _, got := relative(path); got != inside {
			t.Errorf("relative(%s) inside = %v", path, got)
		}
	}
}

func TestCheckEdgeRules(t *testing.T) {
	cases := map[string]struct {
		from, target string
		bad          bool
	}{
		"module to shared":                 {"internal/modules/leave", "internal/modules/leavecore", false},
		"module to module":                 {"internal/modules/leave", "internal/modules/attendance", true},
		"report to employee":               {"internal/modules/report", "internal/modules/employee", true},
		"shared to shared":                 {"internal/modules/attendancecore", "internal/modules/hrbase", false},
		"shared to a module":               {"internal/modules/attendancecore", "internal/modules/employee", true},
		"team to hrbase":                   {"internal/modules/team", "internal/modules/hrbase", false},
		"team to attendancecore":           {"internal/modules/team", "internal/modules/attendancecore", true},
		"employee to schedulecore":         {"internal/modules/employee", "internal/modules/schedulecore", true},
		"setting to leavecore":             {"internal/modules/setting", "internal/modules/leavecore", true},
		"role to attendancecore":           {"internal/modules/role", "internal/modules/attendancecore", true},
		"app to authentication":            {"internal/app", "internal/authentication", false},
		"authority to credential":          {"internal/authorization/authority", "internal/authentication/credential", false},
		"authority to authentication":      {"internal/authorization/authority", "internal/authentication", true},
		"module to authentication":         {"internal/modules/team", "internal/authentication", true},
		"administration to authentication": {"internal/administration", "internal/authentication", true},
		"hrmctl to authentication":         {"cmd/hrmctl", "internal/authentication", true},
		"hrmctl to offline":                {"cmd/hrmctl", "internal/offline", false},
		"api to offline":                   {"cmd/api", "internal/offline", true},
		"app to offline":                   {"internal/app", "internal/offline", true},
		"core to database":                 {"internal/authorization/core", "internal/database", true},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := checkEdgeRules(graph{c.from: {c.target}}); (len(got) > 0) != c.bad {
				t.Errorf("violations %q, want some: %v", got, c.bad)
			}
		})
	}
}

func TestCheckExternalImports(t *testing.T) {
	cases := map[string]struct {
		listed goPackage
		bad    bool
	}{
		"core with the standard library": {fakePackage("internal/authorization/core", "strings", "unicode/utf8"), false},
		"core with gin":                  {fakePackage("internal/authorization/core", "github.com/gin-gonic/gin"), true},
		"core with pgx":                  {fakePackage("internal/authorization/core", "github.com/jackc/pgx/v5"), true},
		"another package with gin":       {fakePackage("internal/httpapi", "github.com/gin-gonic/gin"), false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := checkExternalImports([]goPackage{c.listed}); (len(got) > 0) != c.bad {
				t.Errorf("violations %q, want some: %v", got, c.bad)
			}
		})
	}
}

func TestCheckClosures(t *testing.T) {
	const gin, oidc = "github.com/gin-gonic/gin", "github.com/coreos/go-oidc/v3/oidc"
	authentication := modulePath + "/internal/authentication"
	credential := authentication + "/credential"
	cases := map[string]struct {
		from string
		deps []string
		bad  bool
	}{
		"authority with credential":   {"internal/authorization/authority", []string{credential}, false},
		"authority with httpapi":      {"internal/authorization/authority", []string{modulePath + "/internal/httpapi"}, true},
		"authority with gin":          {"internal/authorization/authority", []string{gin}, true},
		"authority with go-oidc":      {"internal/authorization/authority", []string{oidc}, true},
		"hrmctl with authentication":  {"cmd/hrmctl", []string{authentication}, true},
		"hrmctl with gin":             {"cmd/hrmctl", []string{gin}, true},
		"module with gin":             {"internal/modules/team", []string{gin}, false},
		"module with go-oidc":         {"internal/modules/team", []string{oidc}, true},
		"module with oauth2":          {"internal/modules/team", []string{"golang.org/x/oauth2"}, true},
		"module with go-jose":         {"internal/modules/team", []string{"github.com/go-jose/go-jose/v4"}, true},
		"administration with oauth2":  {"internal/administration", []string{"golang.org/x/oauth2"}, true},
		"module with authentication":  {"internal/modules/report", []string{authentication}, true},
		"administration with go-oidc": {"internal/administration", []string{oidc}, true},
		"api with offline":            {"cmd/api", []string{modulePath + "/internal/offline"}, true},
		"api with go-oidc":            {"cmd/api", []string{oidc}, false},
		"api with goose":              {"cmd/api", []string{"github.com/pressly/goose/v3"}, true},
		"api with a goose subpackage": {"cmd/api", []string{"github.com/pressly/goose/v3/lock"}, true},
		"api with testcontainers":     {"cmd/api", []string{"github.com/testcontainers/testcontainers-go"}, true},
		"database with goose":         {"internal/database", []string{"github.com/pressly/goose/v3"}, true},
		"database with pgx":           {"internal/database", []string{"github.com/jackc/pgx/v5"}, false},
		"hrmctl with goose":           {"cmd/hrmctl", []string{"github.com/pressly/goose/v3"}, false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			listed := goPackage{ImportPath: modulePath + "/" + c.from, Deps: c.deps}
			if got := checkClosures([]goPackage{listed}); (len(got) > 0) != c.bad {
				t.Errorf("violations %q, want some: %v", got, c.bad)
			}
		})
	}
	reachesGin := graph{"internal/authorization/authority": {"internal/httpapi"}, "internal/httpapi": {}}
	if len(checkClosures(closuresOfDAG(reachesGin))) == 0 {
		t.Error("the closure of the block does not follow edges")
	}
}

func TestCheckHandlerFile(t *testing.T) {
	importing := func(path, use string) string {
		return "package x\nimport \"" + path + "\"\n" + use + "\n"
	}
	database := modulePath + "/internal/database"
	cases := map[string]struct {
		path     string
		source   string
		accepted bool
	}{
		"facade only":              {"a_controller.go", "package x\ntype H struct{ Service Reader }\n", true},
		"allowed packages":         {"a_http_port.go", "package x\nimport (\n\"" + modulePath + "/internal/httpapi\"\n\"" + modulePath + "/internal/authorization/keys\"\n)\nvar _ httpapi.A\nvar _ keys.B\n", true},
		"other package Runner":     {"a_controller.go", importing(modulePath+"/internal/other", "var R other.Runner"), true},
		"similar package name":     {"a_controller.go", importing(modulePath+"/internal/databaseutil", "var R databaseutil.R"), true},
		"repository may":           {"a_repository.go", importing(database, "var R database.Runner"), true},
		"test of a handler":        {"a_controller_test.go", importing(database, "var R database.Runner"), true},
		"pgx.Connect":              {"a_controller.go", importing("github.com/jackc/pgx/v5", "var F = pgx.Connect"), false},
		"pgxpool":                  {"a_http_port.go", importing("github.com/jackc/pgx/v5/pgxpool", "var P *pgxpool.Pool"), false},
		"renamed pgxpool":          {"a_controller.go", "package x\nimport p \"github.com/jackc/pgx/v5/pgxpool\"\nvar P *p.Pool\n", false},
		"sql.Open":                 {"a_controller.go", importing("database/sql", "var F = sql.Open"), false},
		"database.Runner":          {"a_controller.go", importing(database, "type H struct{ R *database.Runner }"), false},
		"database.Runner in port":  {"a_http_port.go", importing(database, "func F(r *database.Runner) {}"), false},
		"database.Run":             {"a_controller.go", importing(database, "var F = database.Run"), false},
		"database.RunRead":         {"a_controller.go", importing(database, "var F = database.RunRead"), false},
		"database.Open":            {"a_controller.go", importing(database, "var F = database.Open"), false},
		"database error type":      {"a_http_port.go", importing(database, "var E database.ConflictError"), false},
		"database subpackage":      {"a_controller.go", importing(database+"/migrations", "var F migrations.FS"), false},
		"renamed database":         {"a_controller.go", "package x\nimport db \"" + database + "\"\nvar R db.Runner\n", false},
		"dot database":             {"a_controller.go", "package x\nimport . \"" + database + "\"\nvar R Runner\n", false},
		"blank database":           {"a_controller.go", "package x\nimport _ \"" + database + "\"\n", false},
		"two names of database":    {"a_controller.go", "package x\nimport a \"" + database + "\"\nimport b \"" + database + "\"\nvar _ a.Tx\nvar R b.Runner\n", false},
		"audit":                    {"a_controller.go", importing(modulePath+"/internal/audit", "var F = audit.Append"), false},
		"gateway":                  {"a_http_port.go", importing(modulePath+"/internal/authorization/gateway", "var R gateway.Row"), false},
		"compiler":                 {"a_controller.go", importing(modulePath+"/internal/authorization/compiler", "var F = compiler.CompilePlan"), false},
		"authority":                {"a_controller.go", importing(modulePath+"/internal/authorization/authority", "var A authority.Authorization"), false},
		"manifest":                 {"a_controller.go", importing(modulePath+"/internal/authorization/manifest", "var F = manifest.Sync"), false},
		"grant":                    {"a_controller.go", importing(modulePath+"/internal/authorization/grant", "var F = grant.Compare"), false},
		"authentication":           {"a_controller.go", importing(modulePath+"/internal/authentication", "var S authentication.Service"), false},
		"credential":               {"a_controller.go", importing(modulePath+"/internal/authentication/credential", "var F = credential.SessionDigest"), false},
		"offline":                  {"a_controller.go", importing(modulePath+"/internal/offline", "var F = offline.Provision"), false},
		"app":                      {"a_controller.go", importing(modulePath+"/internal/app", "var F = app.Run"), false},
		"unparsable handler":       {"a_controller.go", "package x\nfunc (", false},
		"file named controller.go": {"controller.go", importing(database, "var R database.Runner"), false},
		"file named http_port.go":  {"internal/x/http_port.go", importing(database, "var R database.Runner"), false},
		"GOOS suffix":              {"a_controller_linux.go", importing(database, "var R database.Runner"), false},
		"GOOS and GOARCH suffix":   {"a_http_port_linux_amd64.go", importing(database, "var R database.Runner"), false},
		"GOARCH suffix":            {"a_controller_arm64.go", importing(database, "var R database.Runner"), false},
		"test named controller":    {"controller_test.go", importing(database, "var R database.Runner"), true},
		"test with a GOOS suffix":  {"a_controller_linux_test.go", importing(database, "var R database.Runner"), true},
		"controller in a word":     {"a_controllers.go", importing(database, "var R database.Runner"), true},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if err := checkHandlerFile(c.path, []byte(c.source)); (err == nil) != c.accepted {
				t.Errorf("accepted %v, got %v", c.accepted, err)
			}
		})
	}
}

// fakeImporter type-checks stand-in packages from source, so a case can name a package of
// handlerForbiddenImports that does not exist yet.
type fakeImporter struct {
	fset     *token.FileSet
	sources  map[string]string
	packages map[string]*types.Package
}

func (f *fakeImporter) Import(path string) (*types.Package, error) {
	if done, ok := f.packages[path]; ok {
		return done, nil
	}
	source, ok := f.sources[path]
	if !ok {
		return nil, fmt.Errorf("no stand-in for %s", path)
	}
	file, err := parser.ParseFile(f.fset, path+"/p.go", source, parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}
	checked, err := (&types.Config{Importer: f}).Check(path, f.fset, []*ast.File{file}, nil)
	if err != nil {
		return nil, err
	}
	f.packages[path] = checked
	return checked, nil
}

func standIn(prefix string) string {
	if prefix == "github.com/jackc/pgx" {
		return prefix + "/v5"
	}
	return prefix
}

func checkFakePackage(files map[string]string) error {
	return checkFakePackageAt(modulePath+"/internal/x", files)
}

func checkFakePackageAt(importPath string, files map[string]string) error {
	fset := token.NewFileSet()
	sources := map[string]string{}
	for _, prefix := range handlerForbiddenImports {
		sources[standIn(prefix)] = "package p\ntype T struct{ Runner *T }\nfunc Run() *T { return nil }\n"
	}
	sources[modulePath+"/internal/authentication/credential"] = "package credential\ntype Sealed struct{ Key string }\nfunc Seal() Sealed { return Sealed{} }\n"
	sources[modulePath+"/internal/database"] = "package database\nimport \"" + modulePath + "/internal/other\"\n" +
		"type Runner struct{ other.Lock; Limit int }\nfunc (*Runner) Revoke(string) error { return nil }\n" +
		"type Store interface{ Revoke(string) error }\n"
	sources[modulePath+"/internal/authorization/gateway"] = "package gateway\ntype Row struct{}\n"
	sources[modulePath+"/internal/other"] = "package other\ntype Runner struct{}\ntype Lock struct{}\nfunc (Lock) Hold() {}\n"
	parsed := map[string][]byte{}
	for name, source := range files {
		parsed[name] = []byte(source)
	}
	return checkHandlerTypes(fset, importPath, parsed, &fakeImporter{fset, sources, map[string]*types.Package{}})
}

// The services of internal/authentication sit beside its handlers, as the DAG places them; only they are
// let through, and what they hold is not.
func TestAHandlerOfAuthenticationReachesOnlyItsOwnServices(t *testing.T) {
	database := "import \"" + modulePath + "/internal/database\"\n"
	credential := "import \"" + modulePath + "/internal/authentication/credential\"\n"
	const (
		reaches = "a handler reaches"
		keeps   = "what a service keeps"
	)
	services := "package authentication\n" + database + "type Service struct{ runner *database.Runner }\n" +
		"type Session struct{ Secret string }\nfunc (*Service) Logout(string) (Session, error) { return Session{}, nil }\n" +
		"func Authenticate(tx *database.Runner) error { return nil }\n" +
		"type ring struct{}\nfunc (ring) Key(string) []byte { return nil }\n" +
		"type settings struct{ ClientSecret string }\n" +
		"type OidcProvider struct{ settings settings; Issuer string }\n" +
		"type MfaService struct{ keys ring }\nfunc (*MfaService) prepare() {}\nfunc (*MfaService) Setup() {}\n" +
		"type OidcService struct{ providers []*OidcProvider }\nfunc (*OidcService) complete() {}\n" +
		"type SessionCredential struct{ secret string }\n" +
		"type Routes struct{ Mfa *MfaService; Oidc *OidcService; next SessionCredential; origin string }\n"
	for name, c := range map[string]struct {
		extra, body, refusal string
	}{
		"a service and its result":                 {"", "func F(s *Service) string { session, _ := s.Logout(\"\"); return session.Secret }", ""},
		"the runner a service holds":               {"", "func F(s *Service) { _ = s.runner }", reaches},
		"a function that takes a transaction":      {"", "func F() { _ = Authenticate }", reaches},
		"an alias of credential":                   {"package authentication\n" + credential + "type Sealed = credential.Sealed\n", "var _ Sealed", reaches},
		"a function that gives a credential value": {"package authentication\n" + credential + "var Seal = credential.Seal\n", "func F() { _ = Seal() }", reaches},
		"the key ring of the second factor":        {"", "func F(r Routes) { _ = r.Mfa.keys.Key(\"\") }", keeps},
		"a prepared step of a service":             {"", "func F(r Routes) { r.Mfa.prepare() }", keeps},
		"the providers":                            {"", "func F(r Routes) { _ = r.Oidc.providers }", keeps},
		"the settings of a provider":               {"", "func F(p *OidcProvider) { _ = p.settings.ClientSecret }", keeps},
		"the completion of a callback":             {"", "func F(r Routes) { r.Oidc.complete() }", keeps},
		"the secret of a session to write":         {"", "func F(r Routes) { _ = r.next.secret }", keeps},
		"a type defined from a service":            {"", "type M MfaService\nfunc F(m M) { _ = m.keys }", keeps},
		"a struct that embeds a service":           {"", "type E struct{ *MfaService }\nfunc F(e E) { _ = e.keys }", keeps},
		"an exported method of a service":          {"", "func F(r Routes) { r.Mfa.Setup() }", ""},
		"an exported field of a provider":          {"", "func F(p *OidcProvider) { _ = p.Issuer }", ""},
		"its own unexported field":                 {"", "func F(r Routes) { _ = r.origin }", ""},
	} {
		t.Run(name, func(t *testing.T) {
			files := map[string]string{"a_service.go": services, "a_controller.go": "package authentication\n" + c.body + "\n"}
			if c.extra != "" {
				files["b_service.go"] = c.extra
			}
			err := checkFakePackageAt(modulePath+"/internal/authentication", files)
			switch {
			case c.refusal == "" && err != nil:
				t.Errorf("refused: %v", err)
			case c.refusal != "" && (err == nil || !strings.Contains(err.Error(), c.refusal)):
				t.Errorf("want a refusal with %q, got %v", c.refusal, err)
			}
		})
	}
	for _, name := range serviceTypes {
		t.Run("a package without "+name, func(t *testing.T) {
			err := checkFakePackageAt(modulePath+"/internal/authentication", map[string]string{
				"a_service.go":    strings.ReplaceAll(services, name, name+"Renamed"),
				"a_controller.go": "package authentication\nvar _ int\n",
			})
			if err == nil || !strings.Contains(err.Error(), "does not declare") {
				t.Errorf("%v", err)
			}
		})
	}
	t.Run("another package keeps out of authentication", func(t *testing.T) {
		err := checkFakePackageAt(modulePath+"/internal/modules/team", map[string]string{
			"a_service.go":    "package team\nimport p \"" + modulePath + "/internal/authentication\"\nvar Run = p.Run\n",
			"a_controller.go": "package team\nfunc F() { Run() }\n",
		})
		if err == nil || !strings.Contains(err.Error(), reaches) {
			t.Errorf("%v", err)
		}
	})
}

func TestCheckHandlerTypes(t *testing.T) {
	database := "import \"" + modulePath + "/internal/database\"\n"
	gateway := "import \"" + modulePath + "/internal/authorization/gateway\"\n"
	other := "import \"" + modulePath + "/internal/other\"\n"
	cases := map[string]struct {
		files    map[string]string
		accepted bool
	}{
		"alias from another file of the package": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Runner = database.Runner\n",
			"a_controller.go": "package x\ntype H struct{ R *Runner }\n",
		}, false},
		"alias of a gateway row": {map[string]string{
			"a_repository.go": "package x\n" + gateway + "type Row = gateway.Row\n",
			"a_http_port.go":  "package x\nfunc F(rows []Row) int { return len(rows) }\n",
		}, false},
		"field of a repository": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ Runner *database.Runner }\n",
			"a_controller.go": "package x\ntype H struct{ repo Repo }\nfunc (h H) F() { _ = h.repo.Runner }\n",
		}, false},
		"result of a repository method": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ runner *database.Runner }\nfunc (r Repo) Runner() *database.Runner { return r.runner }\n",
			"a_controller.go": "package x\nfunc F(r Repo) { _ = r.Runner }\n",
		}, false},
		"variable of another file": {map[string]string{
			"a_repository.go": "package x\n" + database + "var shared *database.Runner\n",
			"a_controller.go": "package x\nfunc F() bool { return shared == nil }\n",
		}, false},
		"type argument": {map[string]string{
			"a_repository.go": "package x\n" + gateway + "type Box[T any] struct{ v T }\ntype Rows = Box[gateway.Row]\n",
			"a_controller.go": "package x\nvar _ Rows\n",
		}, false},
		"map declared in another file": {map[string]string{
			"a_repository.go": "package x\n" + gateway + "var rows map[string]chan gateway.Row\n",
			"a_controller.go": "package x\nfunc F() int { return len(rows) }\n",
		}, false},
		"defined type of a repository file": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Reader struct{ runner *database.Runner }\nfunc (r Reader) Count() int { return 0 }\n",
			"a_controller.go": "package x\ntype H struct{ R Reader }\nfunc (h H) F() int { return h.R.Count() }\n",
		}, true},
		"embedded pointer of a repository": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\n",
			"a_controller.go": "package x\nfunc F(r Repo) error { return r.Revoke(\"1\") }\n",
		}, false},
		"embedded interface of a repository": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ database.Store }\n",
			"a_controller.go": "package x\nfunc F(r Repo) error { return r.Revoke(\"1\") }\n",
		}, false},
		"promoted field": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\n",
			"a_controller.go": "package x\nfunc F(r Repo) int { return r.Limit }\n",
		}, false},
		"method value of an embedded runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\n",
			"a_controller.go": "package x\nfunc F(r Repo) { revoke := r.Revoke; _ = revoke }\n",
		}, false},
		"allowed method promoted through a runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\n",
			"a_controller.go": "package x\nfunc F(r Repo) { r.Hold() }\n",
		}, false},
		"allowed method promoted through a pointer": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Mid struct{ *database.Runner }\ntype Repo struct{ *Mid }\n",
			"a_controller.go": "package x\nfunc F(r *Repo) { r.Hold() }\n",
		}, false},
		"method expression through a runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\n",
			"a_controller.go": "package x\nvar _ = Repo.Hold\n",
		}, false},
		"allowed embedding": {map[string]string{
			"a_repository.go": "package x\nimport \"" + modulePath + "/internal/other\"\ntype Repo struct{ other.Lock }\n",
			"a_controller.go": "package x\nfunc F(r Repo) { r.Hold() }\n",
		}, true},
		"embedded defined type of a repository file": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Reader struct{ runner *database.Runner }\nfunc (Reader) Count() int { return 0 }\ntype Repo struct{ Reader }\n",
			"a_controller.go": "package x\nfunc F(r Repo) int { return r.Count() }\n",
		}, true},
		"defined interface embedding a store": {map[string]string{
			"a_repository.go": "package x\n" + database + "type S interface{ database.Store }\nvar St S\n",
			"a_controller.go": "package x\nfunc F() error { return St.Revoke(\"1\") }\n",
		}, false},
		"field of a type defined from a runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type D database.Runner\n",
			"a_controller.go": "package x\nfunc F(d D) int { return d.Limit }\n",
		}, false},
		"method promoted out of a type defined from a runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type D database.Runner\n",
			"a_controller.go": "package x\nfunc F(d D) { d.Hold() }\n",
		}, false},
		"method of a type defined from a store": {map[string]string{
			"a_repository.go": "package x\n" + database + "type S database.Store\n",
			"a_controller.go": "package x\nfunc F(s S) error { return s.Revoke(\"1\") }\n",
		}, false},
		"holding a type defined from a runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type D database.Runner\n",
			"a_controller.go": "package x\nfunc F(d D) D { return d }\n",
		}, false},
		"type defined from a runner converted to a struct": {map[string]string{
			"a_repository.go": "package x\n" + database + "type D database.Runner\n",
			"a_controller.go": "package x\n" + other + "func F(d D) int { return struct{ other.Lock; Limit int }(d).Limit }\n",
		}, false},
		"type defined from a runner converted through a pointer": {map[string]string{
			"a_repository.go": "package x\n" + database + "type D database.Runner\n",
			"a_controller.go": "package x\n" + other + "func F(d *D) int { return (*struct{ other.Lock; Limit int })(d).Limit }\n",
		}, false},
		"literal of a type defined from a runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type D database.Runner\n",
			"a_controller.go": "package x\nfunc F() D { return D{Limit: 1} }\n",
		}, false},
		"type defined from a runner erased by an interface": {map[string]string{
			"a_repository.go": "package x\n" + database + "type D database.Runner\nvar V D\n",
			"a_controller.go": "package x\nfunc F() { var h interface{ Hold() } = V; h.Hold() }\n",
		}, false},
		"pointer to a type defined from a runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type D database.Runner\n",
			"a_controller.go": "package x\nfunc F(d *D) int { return (*d).Limit }\n",
		}, false},
		"type defined from a store erased by an interface": {map[string]string{
			"a_repository.go": "package x\n" + database + "type S database.Store\nvar St S\n",
			"a_controller.go": "package x\ntype revoker interface{ Revoke(string) error }\nfunc F() error { var r revoker = St; return r.Revoke(\"1\") }\n",
		}, false},
		"type defined from a store erased by a generic": {map[string]string{
			"a_repository.go": "package x\n" + database + "type S database.Store\nvar St S\n",
			"a_controller.go": "package x\nfunc G[T interface{ Revoke(string) error }](t T) error { return t.Revoke(\"1\") }\nfunc F() error { return G(St) }\n",
		}, false},
		"type defined from a store erased by an assertion": {map[string]string{
			"a_repository.go": "package x\n" + database + "type S database.Store\nvar St S\n",
			"a_controller.go": "package x\nfunc F() error { return any(St).(interface{ Revoke(string) error }).Revoke(\"1\") }\n",
		}, false},
		"struct embedding a type defined from a store": {map[string]string{
			"a_repository.go": "package x\n" + database + "type S database.Store\ntype Repo struct{ S }\nvar R Repo\n",
			"a_controller.go": "package x\ntype revoker interface{ Revoke(string) error }\nfunc F() error { var r revoker = R; return r.Revoke(\"1\") }\n",
		}, false},
		"two steps defined from a store": {map[string]string{
			"a_repository.go": "package x\n" + database + "type S database.Store\ntype S2 S\nvar St S2\n",
			"a_controller.go": "package x\ntype revoker interface{ Revoke(string) error }\nfunc F() error { var r revoker = St; return r.Revoke(\"1\") }\n",
		}, false},
		"own fields hiding a runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Row struct{ Name string; runner *database.Runner }\nfunc (r Row) Label() string { return r.Name }\n",
			"a_controller.go": "package x\nfunc F(r Row) string { return r.Name + r.Label() }\n",
		}, true},
		"embedding a type with a hidden runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Base struct{ Name string; runner *database.Runner }\ntype Repo struct{ Base }\n",
			"a_controller.go": "package x\nfunc F(r Repo) string { return r.Name }\n",
		}, true},
		"embedding an interface with an unexported runner method": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Source interface{ Count() int; runner() *database.Runner }\ntype Repo struct{ Source }\n",
			"a_controller.go": "package x\nfunc F(r Repo) int { return r.Count() }\n",
		}, true},
		"handler embedding a type of an allowed package": {map[string]string{
			"a_controller.go": "package x\n" + other + "type H struct{ other.Lock }\nfunc (h H) F() { h.Hold() }\n",
		}, true},
		"local interface returned by a repository": {map[string]string{
			"a_repository.go": "package x\n" + database + "type revoker interface{ Revoke(string) error }\nvar R *database.Runner\nfunc Get() revoker { return R }\n",
			"a_controller.go": "package x\nfunc F() error { return Get().Revoke(\"1\") }\n",
		}, true},
		"embedded runner erased by a local interface": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\nvar R Repo\n",
			"a_controller.go": "package x\ntype revoker interface{ Revoke(string) error }\nfunc F() error { var s revoker = R; return s.Revoke(\"1\") }\n",
		}, false},
		"embedded runner erased by a generic function": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\nvar R Repo\n",
			"a_controller.go": "package x\nfunc G[T interface{ Revoke(string) error }](t T) error { return t.Revoke(\"1\") }\nfunc F() error { return G(R) }\n",
		}, false},
		"embedded runner erased by a type assertion": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\nvar R Repo\n",
			"a_controller.go": "package x\nfunc F() error { return any(R).(interface{ Revoke(string) error }).Revoke(\"1\") }\n",
		}, false},
		"embedded runner erased by a closure": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\nvar R Repo\n",
			"a_controller.go": "package x\nfunc F() error { f := func(s interface{ Revoke(string) error }) error { return s.Revoke(\"1\") }; return f(R) }\n",
		}, false},
		"embedded two levels down": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Mid struct{ *database.Runner }\ntype Repo struct{ Mid }\nvar R Repo\n",
			"a_controller.go": "package x\nfunc F() any { return R }\n",
		}, false},
		"embedded runner behind an alias": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Run = database.Runner\ntype Repo struct{ *Run }\nvar R Repo\n",
			"a_controller.go": "package x\nfunc F() any { return R }\n",
		}, false},
		"embedded generic of a runner": {map[string]string{
			"a_repository.go": "package x\n" + database + "type B[T any] struct{ V T }\nfunc (B[T]) Hold() {}\ntype Repo struct{ B[*database.Runner] }\nvar R Repo\n",
			"a_controller.go": "package x\nfunc F() any { return R }\n",
		}, false},
		"interface embedded in a defined interface": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Inner interface{ database.Store }\ntype S interface{ Inner }\nvar St S\n",
			"a_controller.go": "package x\nfunc F() any { return St }\n",
		}, false},
		"handler struct embedding a repository": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\n",
			"a_controller.go": "package x\ntype H struct{ Repo }\nfunc (h H) F() error { return h.Revoke(\"1\") }\n",
		}, false},
		"constraint on a repository": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\n",
			"a_controller.go": "package x\nfunc G[T interface{ Repo }](t T) { t.Hold() }\n",
		}, false},
		"method value in a variable of a repository file": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\nvar R Repo\nvar Revoke = R.Revoke\n",
			"a_controller.go": "package x\nfunc F() error { return Revoke(\"1\") }\n",
		}, true},
		"function field of a repository file": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Repo struct{ *database.Runner }\nvar R Repo\ntype Ops struct{ Revoke func(string) error }\nvar O = Ops{R.Revoke}\n",
			"a_controller.go": "package x\nfunc F() error { return O.Revoke(\"1\") }\n",
		}, true},
		"unnamed struct": {map[string]string{
			"a_repository.go": "package x\n" + database + "var settings struct{ runner *database.Runner }\n",
			"a_controller.go": "package x\nfunc F() { _ = settings }\n",
		}, false},
		"unnamed interface": {map[string]string{
			"a_repository.go": "package x\n" + database + "var source interface{ Runner() *database.Runner }\n",
			"a_controller.go": "package x\nfunc F() { _ = source }\n",
		}, false},
		"interface embedding a store": {map[string]string{
			"a_repository.go": "package x\n" + database + "var store interface{ database.Store }\n",
			"a_controller.go": "package x\nfunc F() { _ = store }\n",
		}, false},
		"slice": {map[string]string{
			"a_repository.go": "package x\n" + gateway + "var rows []gateway.Row\n",
			"a_controller.go": "package x\nfunc F() int { return len(rows) }\n",
		}, false},
		"array": {map[string]string{
			"a_repository.go": "package x\n" + gateway + "var rows [2]gateway.Row\n",
			"a_controller.go": "package x\nfunc F() int { return len(rows) }\n",
		}, false},
		"second result": {map[string]string{
			"a_repository.go": "package x\n" + database + "func pair() (int, *database.Runner) { return 0, nil }\n",
			"a_controller.go": "package x\nfunc F() { _, _ = pair() }\n",
		}, false},
		"handler named controller.go": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Runner = database.Runner\n",
			"controller.go":   "package x\nvar _ *Runner\n",
		}, false},
		"handler with a GOOS suffix": {map[string]string{
			"a_repository.go":       "package x\n" + database + "type Runner = database.Runner\n",
			"a_controller_linux.go": "package x\nvar _ *Runner\n",
		}, false},
		"defined from a gateway row": {map[string]string{
			"a_repository.go": "package x\n" + gateway + "type Row gateway.Row\n",
			"a_controller.go": "package x\nvar _ Row\n",
		}, true},
		"unexported field of a defined type": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Reader struct{ runner *database.Runner }\n",
			"a_controller.go": "package x\nfunc F(r Reader) bool { return r.runner == nil }\n",
		}, false},
		"other package Runner through an alias": {map[string]string{
			"a_repository.go": "package x\nimport \"" + modulePath + "/internal/other\"\ntype Runner = other.Runner\n",
			"a_controller.go": "package x\nvar _ Runner\n",
		}, true},
		"repository may use the alias": {map[string]string{
			"a_repository.go": "package x\n" + database + "type Runner = database.Runner\nvar _ *Runner\n",
			"a_controller.go": "package x\nvar _ int\n",
		}, true},
		"package that does not type-check": {map[string]string{
			"a_controller.go": "package x\nvar _ Missing\n",
		}, false},
	}
	for _, prefix := range handlerForbiddenImports {
		imported := "import p \"" + standIn(prefix) + "\"\n"
		cases["alias to "+prefix] = struct {
			files    map[string]string
			accepted bool
		}{map[string]string{
			"a_repository.go": "package x\n" + imported + "type T = p.T\n",
			"a_controller.go": "package x\nvar _ *T\n",
		}, false}
		cases["field of "+prefix] = struct {
			files    map[string]string
			accepted bool
		}{map[string]string{
			"a_repository.go": "package x\n" + imported + "type Repo struct{ Inner p.T }\nvar Run = p.Run\n",
			"a_controller.go": "package x\nfunc F(r Repo) { _ = r.Inner.Runner }\n",
		}, false}
		cases["function of "+prefix] = struct {
			files    map[string]string
			accepted bool
		}{map[string]string{
			"a_repository.go": "package x\n" + imported + "var Run = p.Run\n",
			"a_controller.go": "package x\nfunc F() { Run() }\n",
		}, false}
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if err := checkFakePackage(c.files); (err == nil) != c.accepted {
				t.Errorf("accepted %v, got %v", c.accepted, err)
			}
		})
	}
}

func TestCheckHandlerTypesLoadsRealPackages(t *testing.T) {
	fset := token.NewFileSet()
	dirs := []string{"internal/httpapi", "internal/database"}
	imports := exportImporter(t, fset, dirs)
	for _, dir := range dirs {
		files := packageFiles(t, dir)
		if len(files) == 0 {
			t.Fatalf("%s has no files", dir)
		}
		if err := checkHandlerTypes(fset, modulePath+"/"+dir, files, imports); err != nil {
			t.Errorf("%s: %v", dir, err)
		}
	}
	renamed := packageFiles(t, "internal/database")
	for name, source := range renamed {
		renamed[strings.TrimSuffix(name, ".go")+"_controller.go"] = source
		delete(renamed, name)
	}
	if err := checkHandlerTypes(fset, modulePath+"/internal/database", renamed, imports); err != nil {
		t.Logf("database as a handler: %v", err)
	} else {
		t.Error("the database package read as handlers is accepted, so the check proves nothing on real packages")
	}
}

// The real services are what the exception has to hold against: a controller added to the real package cannot
// read what they keep unexported.
func TestAControllerCannotReadWhatTheRealServicesKeep(t *testing.T) {
	fset := token.NewFileSet()
	const dir = "internal/authentication"
	imports := exportImporter(t, fset, []string{dir})
	for _, body := range []string{
		"func(r Routes) { _ = r.Mfa.keys.IDs() }",
		"func(r Routes) { _ = r.Oidc.providers }",
		"func(p *OidcProvider) { _ = p.settings.ClientSecret }",
		"func(p *OidcProvider) { _ = p.oauth.ClientSecret }",
		"func(n SessionCredential) { _ = n.secret }",
		"func(r Routes) { _ = r.Oidc.complete }",
		"func(r Routes) { _ = r.Mfa.prepare }",
	} {
		files := packageFiles(t, dir)
		files["zz_probe_controller.go"] = []byte("package authentication\nvar _ = " + body + "\n")
		if err := checkHandlerTypes(fset, modulePath+"/"+dir, files, imports); err == nil || !strings.Contains(err.Error(), "what a service keeps") {
			t.Errorf("%s: %v", body, err)
		}
	}
}

func TestGooseIsOnlyInTheOfflineCommand(t *testing.T) {
	const goose = "github.com/pressly/goose"
	offlineLinks := false
	for _, listed := range listPackages(t) {
		from, inside := relative(listed.ImportPath)
		if !inside {
			continue
		}
		linked := hasDep(listed.Deps, goose) || slices.ContainsFunc(listed.Imports, func(imported string) bool {
			return strings.HasPrefix(imported, goose+"/")
		})
		if from == "cmd/hrmctl" {
			offlineLinks = linked
		}
		if linked && from != "cmd/hrmctl" && from != "internal/offline" {
			t.Errorf("%s links goose", from)
		}
	}
	if !offlineLinks {
		t.Error("this check no longer sees goose in cmd/hrmctl, so it proves nothing")
	}
}
