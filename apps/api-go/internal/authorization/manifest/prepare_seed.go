package manifest

import (
	"slices"

	"hrm/api-go/internal/authorization/core"
)

func prepareSeeds(source *Source, c *core.Core, d *core.ValidatedDeclarations) error {
	seeds := make([]RelationSeed, 0, len(source.Seeds))
	seen := map[string]bool{}
	for _, seed := range source.Seeds {
		id := seed.Owner + "/" + seed.Key
		relation, exists := d.Relation(seed.Relation)
		if !ownerKey.MatchString(seed.Owner) || !ownerKey.MatchString(seed.Key) || seen[id] || !exists || relation.Target.Kind != core.RelationTargetResource || relation.SourceType != seed.Source.Type || relation.Target.Type != seed.Target.Type {
			return reject("invalid_release")
		}
		seen[id] = true
		start, err := c.CanonicalTimestamp(seed.StartsAt)
		if err != nil {
			return reject("invalid_release")
		}
		seed.StartsAt = start
		if seed.ExpiresAt != "" {
			end, err := c.CanonicalTimestamp(seed.ExpiresAt)
			if err != nil {
				return reject("invalid_release")
			}
			comparison, err := c.CompareValues(core.FieldTimestamp, core.Text(end), core.Text(start))
			if err != nil || comparison != core.Greater {
				return reject("invalid_release")
			}
			seed.ExpiresAt = end
		}
		for _, endpoint := range []*Endpoint{&seed.Source, &seed.Target} {
			r, exists := d.Resource(endpoint.Type)
			if !exists {
				return reject("invalid_release")
			}
			key, err := c.ParseKey(r.KeyKind, endpoint.Key.Value)
			if err != nil || endpoint.Key.Kind != key.Kind {
				return reject("invalid_release")
			}
			endpoint.Key = key
		}
		seeds = append(seeds, seed)
	}
	removals := slices.Clone(source.RemoveSeeds)
	if removals == nil {
		removals = []SeedRemoval{}
	}
	for _, removal := range removals {
		if !ownerKey.MatchString(removal.Owner) || !ownerKey.MatchString(removal.Key) {
			return reject("invalid_release")
		}
	}
	source.Seeds, source.RemoveSeeds = seeds, removals
	return nil
}

func prepareBindings(source *Source, c *core.Core, d *core.ValidatedDeclarations) error {
	bindings := slices.Clone(source.BoundaryBindings)
	if bindings == nil {
		bindings = []BoundaryBinding{}
	}
	seen := map[string]bool{}
	for _, binding := range bindings {
		id := binding.Identity + "/" + binding.Permission
		boundary, exists := d.Boundary(binding.Boundary)
		if !ownerKey.MatchString(binding.Owner) || !c.IsCanonicalUUID(binding.Identity) || seen[id] || !exists || boundary.Lifecycle == core.LifecycleRetired {
			return reject("invalid_release")
		}
		seen[id] = true
		found := false
		for _, entry := range boundary.Entries {
			if entry.Permission == binding.Permission {
				found = true
				break
			}
		}
		if !found {
			return reject("invalid_release")
		}
	}
	removals := slices.Clone(source.RemoveBoundaryBindings)
	if removals == nil {
		removals = []BoundaryRemoval{}
	}
	for _, removal := range removals {
		if !ownerKey.MatchString(removal.Owner) || !c.IsCanonicalUUID(removal.Identity) || !identifier.MatchString(removal.Permission) {
			return reject("invalid_release")
		}
	}
	source.BoundaryBindings, source.RemoveBoundaryBindings = bindings, removals
	return nil
}
