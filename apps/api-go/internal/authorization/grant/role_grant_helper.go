package grant

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/keys"
)

const (
	MaxRuntimeRoles = 100
	MaxRoleKeyBytes = 96
)

var runtimeRoleKey = regexp.MustCompile(`^custom\.[a-z][a-z0-9_]{1,40}$`)

func IsRuntimeRoleKey(value string) bool { return runtimeRoleKey.MatchString(value) }

// IsRoleKeyReference is a key of any role, code or runtime, as the caller names it: 1..96 bytes, the role_key column.
func IsRoleKeyReference(value string) bool { return value != "" && len(value) <= MaxRoleKeyBytes }

// RoleGrantSpec is one grant of a runtime role; its parameters are always {} (see CheckRoleGrants).
type RoleGrantSpec struct {
	Permission string
	Template   core.RelationRef
}

type GrantCheck string

const (
	GrantsOK                GrantCheck = "ok"
	GrantsTooMany           GrantCheck = "too_many"
	GrantsUnknownPermission GrantCheck = "unknown_permission"
	GrantsUnknownTemplate   GrantCheck = "unknown_template"
	GrantsWrongResource     GrantCheck = "wrong_resource"
	GrantsDuplicate         GrantCheck = "duplicate"
)

// CheckRoleGrants takes only declared permissions with a registered template of the same resource: the foreign
// key proves only that the template exists, and a template of another resource would fail closed at request time.
// shortcut: templates that declare parameters are refused (the release has none); supporting them needs typed
// parameter values from the core, add it when the first such template ships.
func CheckRoleGrants(declarations *core.ValidatedDeclarations, grants []RoleGrantSpec) GrantCheck {
	if len(grants) > keys.MaxRoleGrants {
		return GrantsTooMany
	}
	seen := make(map[RoleGrantSpec]bool, len(grants))
	for _, grant := range grants {
		resource, action, found := strings.Cut(grant.Permission, ".")
		if declarations == nil || !found || resource == "" || strings.Contains(action, ".") {
			return GrantsUnknownPermission
		}
		declared, ok := declarations.Resource(resource)
		if _, known := declared.Actions[action]; !ok || !known {
			return GrantsUnknownPermission
		}
		template, ok := declarations.Template(grant.Template)
		if !ok {
			return GrantsUnknownTemplate
		}
		if template.Resource != resource || len(template.Parameters) > 0 {
			return GrantsWrongResource
		}
		if seen[grant] {
			return GrantsDuplicate
		}
		seen[grant] = true
	}
	return GrantsOK
}

func GrantsAsFacts(grants []RoleGrantSpec) []GrantRuleFact {
	facts := make([]GrantRuleFact, len(grants))
	for i, grant := range grants {
		facts[i] = GrantRuleFact{Source: SourceRole, Effect: core.EffectAllow, Permission: grant.Permission, Template: grant.Template, Parameters: "{}"}
	}
	return facts
}

// jsonText escapes like JSON.stringify: encoding/json/v2 leaves <, >, &, U+2028 and U+2029 as they are and
// refuses invalid UTF-8.
func jsonText(value string) (string, error) {
	b, err := json.Marshal(value)
	return string(b), err
}

// GrantsDigest is SHA-256 of [label, sorted canonical grants], the expectedDigest of a role update and its audit
// evidence; it equals the TypeScript digest byte for byte only for ASCII keys: rows sort by bytes, which is
// the UTF-16 order of JavaScript just for ASCII. CheckRoleGrants keeps keys to registered (ASCII) ones, so a
// caller must pass it before computing the digest.
func GrantsDigest(label string, grants []RoleGrantSpec) (string, error) {
	rows := make([]string, 0, len(grants))
	for _, grant := range grants {
		permission, err := jsonText(grant.Permission)
		if err != nil {
			return "", err
		}
		template, err := jsonText(grant.Template.Key)
		if err != nil {
			return "", err
		}
		rows = append(rows, "["+permission+","+template+","+strconv.Itoa(grant.Template.Version)+"]")
	}
	slices.Sort(rows)
	parts := make([]string, len(rows))
	for i, row := range rows {
		text, err := jsonText(row)
		if err != nil {
			return "", err
		}
		parts[i] = text
	}
	text, err := jsonText(label)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte("[" + text + ",[" + strings.Join(parts, ",") + "]]"))
	return hex.EncodeToString(sum[:]), nil
}
