package manifest

import (
	"encoding/json/jsontext"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/keys"
)

var identifier = regexp.MustCompile(`^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)*$`)
var ownerKey = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)

func Prepare(source Source, c *core.Core) (Release, error) {
	if c == nil {
		return Release{}, reject("invalid_release")
	}
	sequence, err := c.CanonicalInt64(source.Sequence)
	if err != nil {
		return Release{}, reject("invalid_release")
	}
	predecessor, err := c.CanonicalInt64(source.Predecessor)
	if err != nil {
		return Release{}, reject("invalid_release")
	}
	s, err := strconv.ParseInt(sequence, 10, 64)
	if err != nil {
		return Release{}, reject("invalid_release")
	}
	p, err := strconv.ParseInt(predecessor, 10, 64)
	if err != nil || s < 1 || p < 0 || p >= s {
		return Release{}, reject("invalid_release")
	}
	if len(source.Roles) > 200 || len(source.DefaultGrants) > 1000 || len(source.RemoveDefaultGrants) > 1000 || len(source.Seeds) > 1000 || len(source.RemoveSeeds) > 1000 || len(source.BoundaryBindings) > 1000 || len(source.RemoveBoundaryBindings) > 1000 {
		return Release{}, reject("invalid_release")
	}
	d, err := c.Validate(source.Declarations)
	if err != nil {
		return Release{}, reject("invalid_release")
	}
	roles := make(map[string]bool, len(source.Roles))
	for _, role := range source.Roles {
		if !identifier.MatchString(role.Key) || roles[role.Key] || strings.HasPrefix(role.Key, "system.") || strings.HasPrefix(role.Key, keys.RuntimeRolePrefix) || strings.TrimSpace(role.Label) == "" || utf8.RuneCountInString(role.Label) > 120 || !utf8.ValidString(role.Label) || strings.ContainsRune(role.Label, 0) {
			return Release{}, reject("invalid_release")
		}
		roles[role.Key] = true
	}
	source.Sequence, source.Predecessor = sequence, predecessor
	source.Roles = slices.Clone(source.Roles)
	if source.Roles == nil {
		source.Roles = []Role{}
	}
	source.DefaultGrants, err = prepareGrants(source.DefaultGrants, c, d, roles)
	if err != nil {
		return Release{}, err
	}
	source.RemoveDefaultGrants, err = prepareGrants(source.RemoveDefaultGrants, c, d, roles)
	if err != nil {
		return Release{}, err
	}
	removed := map[string]bool{}
	for _, grant := range source.RemoveDefaultGrants {
		id, err := grantID(grant)
		if err != nil || removed[id] {
			return Release{}, reject("invalid_release")
		}
		removed[id] = true
	}
	for _, grant := range source.DefaultGrants {
		id, err := grantID(grant)
		if err != nil || removed[id] {
			return Release{}, reject("invalid_release")
		}
	}
	if err := prepareSeeds(&source, c, d); err != nil {
		return Release{}, err
	}
	if err := prepareBindings(&source, c, d); err != nil {
		return Release{}, err
	}
	source.Declarations = core.SystemDeclarations{}
	content := map[string]jsontext.Value{"declarations": jsontext.Value(d.Canonical())}
	for name, result := range map[string]struct {
		values []jsontext.Value
		err    error
	}{
		"roles": forms(source.Roles), "defaultGrants": forms(source.DefaultGrants),
		"seeds": forms(source.Seeds), "removeSeeds": forms(source.RemoveSeeds),
		"boundaryBindings": forms(source.BoundaryBindings), "removeBoundaryBindings": forms(source.RemoveBoundaryBindings),
	} {
		if result.err != nil {
			return Release{}, reject("invalid_release")
		}
		form, err := canonical(result.values)
		if err != nil {
			return Release{}, reject("invalid_release")
		}
		content[name] = jsontext.Value(form)
	}
	base, err := canonical(content)
	if err != nil {
		return Release{}, reject("invalid_release")
	}
	envelope := struct {
		Base    string   `json:"base"`
		Removed []string `json:"removeDefaultGrants,omitempty"`
	}{Base: digest(base)}
	if len(removed) > 0 {
		envelope.Removed = slices.Sorted(maps.Keys(removed))
	}
	form, err := canonical(envelope)
	if err != nil {
		return Release{}, reject("invalid_release")
	}
	return Release{source: source, declarations: d, owner: c, hash: digest(form)}, nil
}

func forms[T any](values []T) struct {
	values []jsontext.Value
	err    error
} {
	valuesJSON, err := sortedForms(values)
	return struct {
		values []jsontext.Value
		err    error
	}{valuesJSON, err}
}

func prepareGrants(grants []DefaultGrant, c *core.Core, d *core.ValidatedDeclarations, roles map[string]bool) ([]DefaultGrant, error) {
	out := make([]DefaultGrant, 0, len(grants))
	for _, grant := range grants {
		resource, action, ok := strings.Cut(grant.Permission, ".")
		r, exists := d.Resource(resource)
		t, found := d.Template(grant.Template)
		if !ok || !exists || !roles[grant.Role] || !found || t.Resource != resource || len(t.Parameters) != len(grant.Parameters) {
			return nil, reject("invalid_release")
		}
		if _, exists := r.Actions[action]; !exists {
			return nil, reject("invalid_release")
		}
		parameters := make(map[string]core.Scalar, len(grant.Parameters))
		for name, kind := range t.Parameters {
			value, exists := grant.Parameters[name]
			if !exists {
				return nil, reject("invalid_release")
			}
			normalized, err := c.NormalizeValue(kind, core.Value(value))
			if err != nil {
				return nil, reject("invalid_release")
			}
			parameters[name] = normalized
		}
		grant.Parameters = parameters
		out = append(out, grant)
	}
	return out, nil
}
