package grant_test

import (
	"math/rand/v2"
	"slices"
	"testing"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/grant"
)

func grantUniverse() []grant.GrantRuleFact {
	var universe []grant.GrantRuleFact
	for _, permission := range []string{"a.read", "a.write", "b.read", "b.write", "c.read"} {
		for _, template := range []string{"all", "own"} {
			for _, version := range []int{1, 2} {
				for _, parameters := range []string{`{}`, `{"p":"x"}`, `{"p":"y","q":true}`} {
					item := fact(permission, template, version)
					item.Parameters = parameters
					universe = append(universe, item)
				}
			}
		}
	}
	return universe
}

// The oracle compares whole facts, so it shares nothing with the key the comparison builds. The seed is
// fixed: a failure names its round and reproduces.
func TestWithinIsExactlySetInclusionOverTheWholeTuple(t *testing.T) {
	universe := grantUniverse()
	random := rand.New(rand.NewPCG(20261025, 122))
	pick := func(from []grant.GrantRuleFact, chance float64) []grant.GrantRuleFact {
		picked := []grant.GrantRuleFact{}
		for _, item := range from {
			if random.Float64() < chance {
				picked = append(picked, item)
			}
		}
		return picked
	}
	denied := fact("a.read", "all", 1)
	denied.Effect = core.EffectDeny
	seen := map[grant.Verdict]int{}

	for round := range 600 {
		actor := pick(universe, []float64{0.1, 0.35, 0.7}[round%3])
		target := pick(universe, 0.2)
		if round%2 == 0 {
			target = pick(actor, 0.5)
		}

		held := map[grant.GrantRuleFact]bool{}
		permissions := map[string]bool{}
		for _, item := range actor {
			held[item] = true
			permissions[item.Permission] = true
		}
		want := grant.Within
		for _, item := range target {
			if held[item] {
				continue
			}
			if !permissions[item.Permission] {
				want = grant.Larger
				break
			}
			want = grant.Incomparable
		}
		included := want == grant.Within
		seen[want]++

		if got := grant.CompareGrantSets(target, actor); got != want {
			t.Fatalf("round %d: %s, want %s for target %v in actor %v", round, got, want, target, actor)
		}
		if grant.ProvenWithin(target, actor, false) != included || grant.ProvenWithin(target, actor, true) {
			t.Fatalf("round %d: ProvenWithin disagrees with inclusion %t or trusts a truncated read", round, included)
		}
		if got := grant.CompareGrantSets(target, target); got != grant.Within {
			t.Fatalf("round %d: a set is %s of itself", round, got)
		}
		bigger := append(slices.Clone(actor), pick(universe, 0.35)...)
		if got := grant.CompareGrantSets(target, bigger); included && got != grant.Within {
			t.Fatalf("round %d: a larger actor made the target %s", round, got)
		}
		shuffled := append(slices.Clone(target), target...)
		random.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
		if got := grant.CompareGrantSets(shuffled, actor); got != want {
			t.Fatalf("round %d: order or a repeated grant changed %s to %s", round, want, got)
		}
		if got := grant.CompareGrantSets(append(slices.Clone(target), denied), actor); got != grant.Unprovable {
			t.Fatalf("round %d: a deny on the target is %s", round, got)
		}
		if got := grant.CompareGrantSets(target, append(slices.Clone(actor), denied)); got != grant.Unprovable {
			t.Fatalf("round %d: a deny on the actor is %s", round, got)
		}
	}

	for _, verdict := range []grant.Verdict{grant.Within, grant.Larger, grant.Incomparable} {
		if seen[verdict] < 50 {
			t.Errorf("only %d rounds were %s: the property did not cover it", seen[verdict], verdict)
		}
	}
}
