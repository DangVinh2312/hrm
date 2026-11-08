package core_test

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/values"
)

// userSnapshot has declarations validated by c and one decimal `lte` allow rule.
func userSnapshot(c *core.Core) core.AuthoritySnapshot {
	return snapshotWith(func(s *core.AuthoritySnapshot) {
		s.Declarations = validatedBy(c, declarations())
		s.Rules = []core.RuleFact{read(reviewer, core.EffectAllow, "amountAtMost@1", text("limit", "50"))}
	})
}

func userFacts(amount string) core.CompleteFacts {
	record := submission("record", "1", map[string]core.FieldValue{"amount": core.TextValue(amount)})
	return core.CompleteFacts{Now: "2026-10-13T10:00:01.000000Z", Record: record, Objects: []core.FactObject{record}}
}

func coreWith(t *testing.T, mutate func(*core.ValueCodecs)) *core.Core {
	t.Helper()
	codecs := values.Codecs()
	mutate(&codecs)
	c, err := core.New(codecs)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

type stubCodec struct {
	normalize func(core.FieldValue) (core.Scalar, bool)
	compare   func(core.Scalar, core.Scalar) (core.Comparison, error)
}

func (s stubCodec) Normalize(input core.FieldValue) (core.Scalar, bool) { return s.normalize(input) }

func (s stubCodec) Compare(left, right core.Scalar) (core.Comparison, error) {
	return s.compare(left, right)
}

func refuseEverything() stubCodec {
	return stubCodec{
		normalize: func(core.FieldValue) (core.Scalar, bool) { return core.Scalar{}, false },
		compare:   func(core.Scalar, core.Scalar) (core.Comparison, error) { return core.Equal, nil },
	}
}

func panicking() stubCodec {
	return stubCodec{
		normalize: func(core.FieldValue) (core.Scalar, bool) { panic("codec failure") },
		compare:   func(core.Scalar, core.Scalar) (core.Comparison, error) { panic("codec failure") },
	}
}

func TestInstancesAreIndependent(t *testing.T) {
	a, b := newCore(), newCore()
	fromA := userSnapshot(a)
	if !a.IsValidated(fromA.Declarations) {
		t.Error("A does not recognize its declarations")
	}
	if b.IsValidated(fromA.Declarations) {
		t.Error("B recognizes the declarations of A")
	}
	plan := planned(t, a.Plan(input(), fromA))
	if !a.Issued(plan) {
		t.Error("A does not recognize its plan")
	}
	if b.Issued(plan) {
		t.Error("B recognizes the plan of A")
	}
	wantReason(t, b.Plan(input(), fromA), "unvalidated_declarations")
	if !a.Evaluate(plan, userFacts("10.00")).Allowed() {
		t.Error("A refused its plan")
	}
	wantReason(t, b.Evaluate(plan, userFacts("10.00")), "foreign_plan")
}

func TestAStructuralCopyOfAPlanWasNeverIssued(t *testing.T) {
	plan := planned(t, fixtureCore.Plan(input(), userSnapshot(fixtureCore)))
	duplicate := *plan
	if fixtureCore.Issued(&duplicate) || fixtureCore.Issued(nil) || fixtureCore.Issued(&core.AuthorizedPlan{}) {
		t.Error("an unissued plan was accepted by Issued")
	}
	wantReason(t, fixtureCore.Evaluate(&duplicate, userFacts("10.00")), "foreign_plan")
	wantReason(t, fixtureCore.Evaluate(nil, userFacts("10.00")), "foreign_plan")
	wantReason(t, fixtureCore.Evaluate(&core.AuthorizedPlan{}, userFacts("10.00")), "foreign_plan")
}

func TestEachInstanceKeepsItsOwnValueSemantics(t *testing.T) {
	refusesTimes := coreWith(t, func(c *core.ValueCodecs) { c.Timestamp = refuseEverything() })
	planned(t, fixtureCore.Plan(input(), userSnapshot(fixtureCore)))
	wantReason(t, refusesTimes.Plan(input(), userSnapshot(refusesTimes)), "invalid_now")
}

func TestAMissingCodecFailsAtConstruction(t *testing.T) {
	cases := map[string]func(*core.ValueCodecs){
		"timestamp": func(c *core.ValueCodecs) { c.Timestamp = nil },
		"integer":   func(c *core.ValueCodecs) { c.Integer = nil },
		"decimal":   func(c *core.ValueCodecs) { c.Decimal = nil },
		"uuid":      func(c *core.ValueCodecs) { c.UUID = nil },
		"string":    func(c *core.ValueCodecs) { c.String = nil },
		"boolean":   func(c *core.ValueCodecs) { c.Boolean = nil },
	}
	for kind, mutate := range cases {
		t.Run(kind, func(t *testing.T) {
			codecs := values.Codecs()
			mutate(&codecs)
			c, err := core.New(codecs)
			if err == nil || c != nil {
				t.Fatalf("core %v, error %v", c, err)
			}
			if !strings.Contains(err.Error(), kind) {
				t.Fatalf("error %q does not name %s", err, kind)
			}
		})
	}
	if _, err := core.New(core.ValueCodecs{}); err == nil {
		t.Fatal("an empty codec table was accepted")
	}
}

func TestTheCodecTableIsCapturedAtConstruction(t *testing.T) {
	codecs := values.Codecs()
	c, err := core.New(codecs)
	if err != nil {
		t.Fatal(err)
	}
	s := userSnapshot(c)
	codecs.Timestamp = refuseEverything()
	planned(t, c.Plan(input(), s))
}

func TestAPanickingCodecNeverAllows(t *testing.T) {
	onTime := coreWith(t, func(c *core.ValueCodecs) { c.Timestamp = panicking() })
	wantReason(t, onTime.Plan(input(), userSnapshot(onTime)), "internal_error")
	wantReason(t, onTime.PlanUnrestricted(input(), userSnapshot(onTime)), "internal_error")

	strict := values.Codecs().Decimal
	onCompare := coreWith(t, func(c *core.ValueCodecs) {
		c.Decimal = stubCodec{normalize: strict.Normalize, compare: panicking().compare}
	})
	plan := planned(t, onCompare.Plan(input(), userSnapshot(onCompare)))
	wantReason(t, onCompare.Evaluate(plan, userFacts("10.00")), "internal_error")

	onString := coreWith(t, func(c *core.ValueCodecs) { c.String = panicking() })
	result, err := onString.Validate(declarations())
	if result != nil || err == nil {
		t.Fatalf("validated %v, error %v", result, err)
	}
	if strings.Contains(err.Error(), "pending") {
		t.Fatalf("the error echoes a declared value: %v", err)
	}
	if onString.IsValidated(result) {
		t.Fatal("a failed validation counts as validated")
	}
}

func TestACodecOutsideItsContractNeverAllows(t *testing.T) {
	boolean := stubCodec{
		normalize: func(core.FieldValue) (core.Scalar, bool) { return core.Bool(true), true },
		compare:   func(core.Scalar, core.Scalar) (core.Comparison, error) { return core.Equal, nil },
	}
	onTime := coreWith(t, func(c *core.ValueCodecs) { c.Timestamp = boolean })
	wantReason(t, onTime.Plan(input(), userSnapshot(onTime)), "internal_error")

	onString := coreWith(t, func(c *core.ValueCodecs) { c.String = boolean })
	if _, err := onString.Validate(declarations()); err == nil {
		t.Fatal("a string codec returning booleans passed validation")
	}

	strict := values.Codecs().Decimal
	for name, compare := range map[string]func(core.Scalar, core.Scalar) (core.Comparison, error){
		"no answer":    func(core.Scalar, core.Scalar) (core.Comparison, error) { return 0, nil },
		"out of range": func(core.Scalar, core.Scalar) (core.Comparison, error) { return 9, nil },
		"error":        func(core.Scalar, core.Scalar) (core.Comparison, error) { return core.Equal, errors.New("boom") },
	} {
		t.Run(name, func(t *testing.T) {
			bad := coreWith(t, func(c *core.ValueCodecs) { c.Decimal = stubCodec{normalize: strict.Normalize, compare: compare} })
			plan := planned(t, bad.Plan(input(), userSnapshot(bad)))
			wantReason(t, bad.Evaluate(plan, userFacts("10.00")), "internal_error")
			if _, err := bad.CompareValues(core.FieldDecimal, core.Text("1"), core.Text("2")); err == nil {
				t.Fatal("CompareValues accepted the answer")
			}
		})
	}
}

func TestCanonicalIdentityChecksStayLowercaseEvenIfTheCodecKeepsCase(t *testing.T) {
	strict := values.Codecs().UUID
	passThrough := coreWith(t, func(c *core.ValueCodecs) {
		c.UUID = stubCodec{
			normalize: func(input core.FieldValue) (core.Scalar, bool) {
				value, ok := input.AsText()
				if !ok {
					return core.Scalar{}, false
				}
				if _, valid := strict.Normalize(input); !valid {
					return core.Scalar{}, false
				}
				return core.Text(value), true
			},
			compare: strict.Compare,
		}
	})
	upper := strings.ToUpper(string(alice))
	value, err := passThrough.NormalizeValue(core.FieldUUID, core.TextValue(upper))
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := value.AsText(); got != upper {
		t.Fatalf("the codec's own normalization returned %q", got)
	}
	if passThrough.IsCanonicalUUID(upper) {
		t.Error("an uppercase id is canonical")
	}
	if !passThrough.IsCanonicalUUID(string(alice)) {
		t.Error("a lowercase id is not canonical")
	}
	i := input()
	i.Principal.ID = core.IdentityID(upper)
	wantReason(t, passThrough.Plan(i, userSnapshot(passThrough)), "invalid_principal")
}

type countingCodec struct {
	inner                core.ScalarCodec
	normalized, compared *int
}

func (c countingCodec) Normalize(input core.FieldValue) (core.Scalar, bool) {
	*c.normalized++
	return c.inner.Normalize(input)
}

func (c countingCodec) Compare(left, right core.Scalar) (core.Comparison, error) {
	*c.compared++
	return c.inner.Compare(left, right)
}

func TestValidatorPlannerAndEvaluatorRouteScalarsThroughTheInjectedCodecs(t *testing.T) {
	var stringNormalized, stringCompared, timeNormalized, timeCompared, decimalNormalized, decimalCompared int
	codecs := values.Codecs()
	codecs.String = countingCodec{codecs.String, &stringNormalized, &stringCompared}
	codecs.Timestamp = countingCodec{codecs.Timestamp, &timeNormalized, &timeCompared}
	codecs.Decimal = countingCodec{codecs.Decimal, &decimalNormalized, &decimalCompared}
	c, err := core.New(codecs)
	if err != nil {
		t.Fatal(err)
	}
	s := userSnapshot(c)
	if stringNormalized == 0 {
		t.Error("the validator did not normalize declaration literals")
	}
	timeNormalized, timeCompared, decimalNormalized = 0, 0, 0
	plan := planned(t, c.Plan(input(), s))
	if timeNormalized < 2 || timeCompared < 1 {
		t.Errorf("planner: normalized %d times, compared %d", timeNormalized, timeCompared)
	}
	if decimalNormalized < 1 {
		t.Error("the planner did not normalize rule parameters")
	}
	timeNormalized, timeCompared, decimalNormalized, decimalCompared = 0, 0, 0, 0
	if !c.Evaluate(plan, userFacts("10.00")).Allowed() {
		t.Error("10.00 <= 50 was denied")
	}
	if c.Evaluate(plan, userFacts("51")).Allowed() {
		t.Error("51 <= 50 was allowed")
	}
	if timeNormalized < 1 || timeCompared < 1 {
		t.Errorf("evaluator: normalized %d times, compared %d", timeNormalized, timeCompared)
	}
	if decimalNormalized < 2 || decimalCompared < 2 {
		t.Errorf("evaluator: decimal normalized %d times, compared %d", decimalNormalized, decimalCompared)
	}
}

func TestTimestampValidityBelongsToTheCodec(t *testing.T) {
	permissive := coreWith(t, func(c *core.ValueCodecs) {
		c.Timestamp = stubCodec{
			normalize: func(input core.FieldValue) (core.Scalar, bool) {
				value, ok := input.AsText()
				return core.Text(value), ok && value != ""
			},
			compare: func(left, right core.Scalar) (core.Comparison, error) {
				l, _ := left.AsText()
				r, _ := right.AsText()
				if l == r {
					return core.Equal, nil
				}
				if l < r {
					return core.Less, nil
				}
				return core.Greater, nil
			},
		}
	})
	feb30 := input()
	feb30.Now, feb30.ValidUntil = "2026-02-30T00:00:00Z", "2026-03-31T00:00:00Z"
	planned(t, permissive.Plan(feb30, userSnapshot(permissive)))
	wantReason(t, fixtureCore.Plan(feb30, userSnapshot(fixtureCore)), "invalid_now")
	hour24 := input()
	hour24.Now = "2026-10-13T24:00:00Z"
	wantReason(t, fixtureCore.Plan(hour24, userSnapshot(fixtureCore)), "invalid_now")
}

func TestScalarMethodsDelegateToTheInstanceCodecs(t *testing.T) {
	c := fixtureCore
	if got, err := c.CanonicalTimestamp("2026-10-14T00:00:00.1Z"); err != nil || got != "2026-10-14T00:00:00.100000Z" {
		t.Errorf("timestamp %q, %v", got, err)
	}
	for _, bad := range []string{"2026-02-30T00:00:00Z", "2026-10-14T00:00:00+07:00"} {
		if _, err := c.CanonicalTimestamp(bad); !errors.Is(err, core.ErrInvalidValue) {
			t.Errorf("timestamp %q: %v", bad, err)
		}
	}
	if got, err := c.CanonicalInt64("9223372036854775807"); err != nil || got != "9223372036854775807" {
		t.Errorf("int64 %q, %v", got, err)
	}
	if _, err := c.CanonicalInt64("42.0"); !errors.Is(err, core.ErrInvalidValue) {
		t.Errorf("int64: %v", err)
	}
	value, err := c.NormalizeValue(core.FieldUUID, core.TextValue(strings.ToUpper(string(alice))))
	if got, _ := value.AsText(); err != nil || got != string(alice) {
		t.Errorf("uuid %q, %v", got, err)
	}
	if _, err := c.NormalizeValue("money", core.TextValue("1")); err == nil || errors.Is(err, core.ErrInvalidValue) {
		t.Errorf("unknown kind: %v", err)
	}
	if _, err := c.NormalizeValue(core.FieldInteger, core.BoolValue(true)); !errors.Is(err, core.ErrInvalidValue) {
		t.Errorf("boolean integer: %v", err)
	}
	if order, err := c.CompareValues(core.FieldDecimal, core.Text("10.0"), core.Text("10.00")); err != nil || order != core.Equal {
		t.Errorf("decimal %d, %v", order, err)
	}
	if order, err := c.CompareValues(core.FieldInteger, core.Text("9007199254740993"), core.Text("9007199254740992")); err != nil || order != core.Greater {
		t.Errorf("integer %d, %v", order, err)
	}
	if _, err := c.CompareValues("money", core.Text("1"), core.Text("2")); err == nil {
		t.Error("compare of an unknown kind succeeded")
	}
	if !c.IsCanonicalUUID(string(alice)) || c.IsCanonicalUUID(strings.ToUpper(string(alice))) {
		t.Error("IsCanonicalUUID")
	}
}

func TestSharedDeclarationsAreSafeAcrossGoroutines(t *testing.T) {
	s := userSnapshot(fixtureCore)
	var wg sync.WaitGroup
	results := make([]bool, 8)
	for i := range results {
		wg.Go(func() {
			decision := fixtureCore.Plan(input(), s)
			results[i] = decision.Allowed() && fixtureCore.Evaluate(decision.Plan(), userFacts("10.00")).Allowed()
		})
	}
	wg.Wait()
	for i, allowed := range results {
		if !allowed {
			t.Errorf("goroutine %d was denied", i)
		}
	}
}
