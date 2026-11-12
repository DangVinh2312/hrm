package declarations_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"os"
	"testing"

	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/declarations"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/authorization/manifest"
	"hrm/api/internal/authorization/values"
)

func TestProductDeclarationsMatchReferenceContent(t *testing.T) {
	c, err := core.New(values.Codecs())
	if err != nil {
		t.Fatal(err)
	}
	d, err := c.Validate(declarations.Source().Declarations)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("../../../contract/release.json")
	if err != nil {
		t.Fatal(err)
	}
	var reference struct {
		Declarations jsontext.Value `json:"declarations"`
	}
	if err := json.Unmarshal(data, &reference); err != nil {
		t.Fatal(err)
	}
	got := jsontext.Value(d.Canonical())
	if err := got.Compact(jsontext.ReorderRawObjects(true)); err != nil {
		t.Fatal(err)
	}
	if err := reference.Declarations.Compact(jsontext.ReorderRawObjects(true)); err != nil {
		t.Fatal(err)
	}
	if string(got) != string(reference.Declarations) {
		t.Fatal("declarations differ from accepted reference content")
	}
}

func TestRequiredBoundaryActionsAlwaysRequireFreshAuthentication(t *testing.T) {
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	d, err := c.Validate(declarations.Source().Declarations)
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, resource := range d.Resources() {
		for action, declaration := range resource.Actions {
			if declaration.Boundary != core.BoundaryRequired {
				continue
			}
			checked++
			policy, exists := d.Policy(declaration.Policy)
			fresh := false
			for _, requirement := range policy.ContextRequirements {
				if requirement.Validator == string(keys.ProductValidatorFresh) {
					fresh = true
				}
			}
			if !exists || !fresh {
				t.Errorf("%s.%s has no fresh authentication policy", resource.Key, action)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no required-boundary actions were checked")
	}
}

func TestStorageBindingsMatchReferenceAndAreFreshCopies(t *testing.T) {
	data, err := os.ReadFile("../../../contract/bindings.json")
	if err != nil {
		t.Fatal(err)
	}
	var reference struct {
		Bindings jsontext.Value `json:"bindings"`
	}
	if err := json.Unmarshal(data, &reference); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(declarations.Bindings(), json.Deterministic(true))
	if err != nil {
		t.Fatal(err)
	}
	actual := jsontext.Value(b)
	if err := actual.Compact(jsontext.ReorderRawObjects(true)); err != nil {
		t.Fatal(err)
	}
	if err := reference.Bindings.Compact(jsontext.ReorderRawObjects(true)); err != nil {
		t.Fatal(err)
	}
	if string(actual) != string(reference.Bindings) {
		t.Fatal("binding content differs")
	}
	hash := sha256.Sum256(actual)
	if hex.EncodeToString(hash[:]) != "fb986be60264352f1e26fa5638ae27c1629abde628e81083f9a104aa74e18934" {
		t.Fatalf("binding hash changed: %s", hex.EncodeToString(hash[:]))
	}
	copy := declarations.Bindings()
	copy.Resources[0].Columns["title"] = "changed"
	if declarations.Bindings().Resources[0].Columns["title"] != "title" {
		t.Fatal("binding mutated shared source")
	}
}

func TestProductManifestHashPinned(t *testing.T) {
	c, err := core.New(values.Codecs())
	if err != nil {
		t.Fatal(err)
	}
	r, err := manifest.Prepare(declarations.Source(), c)
	if err != nil {
		t.Fatal(err)
	}
	const expected = "5eda10c91670ac19fc707e0f505ed11c0014468b58f86ee7bee1a9532bbe6112"
	if r.Hash() != expected {
		t.Fatalf("manifest hash = %s", r.Hash())
	}
	data, err := os.ReadFile("../../../contract/manifest-readiness.json")
	if err != nil {
		t.Fatal(err)
	}
	var bridge struct {
		Sequence     string `json:"sequence"`
		ManifestHash string `json:"manifestHash"`
	}
	if err := json.Unmarshal(data, &bridge, json.RejectUnknownMembers(true)); err != nil {
		t.Fatal(err)
	}
	if bridge.Sequence != r.Sequence() || bridge.ManifestHash != r.Hash() {
		t.Fatal("readiness bridge differs from Go release")
	}
}
