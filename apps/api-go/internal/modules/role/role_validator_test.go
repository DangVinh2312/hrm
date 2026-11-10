package role

import (
	"crypto/sha256"
	"encoding/json/v2"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/declarations"
)

// tsCatalogSHA256 is sha256(JSON.stringify(roleCatalog(declarations))) of apps/api/dist on this release.
const tsCatalogSHA256 = "152dae7532848d320c5fc9be3d21bcdcdb85d6fb1580e4390e6450a94583fc66"

func release(t *testing.T) (*core.Core, *core.ValidatedDeclarations) {
	t.Helper()
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	validated, err := c.Validate(declarations.Source().Declarations)
	if err != nil {
		t.Fatal(err)
	}
	return c, validated
}

func pair(permission, template string, version int) GrantPair {
	return GrantPair{Permission: permission, Template: TemplateRef{Key: template, Version: version}}
}

func decode[T any](raw string) (T, error) {
	var body T
	err := json.Unmarshal([]byte(raw), &body, json.RejectUnknownMembers(true))
	return body, err
}

func refused(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("accepted %s: %v", what, err)
	}
}

func TestParseKeyTakesOnlyRuntimeKeys(t *testing.T) {
	if key, err := parseKey("custom.hr_lead"); err != nil || key != "custom.hr_lead" {
		t.Fatalf("custom.hr_lead: %q %v", key, err)
	}
	for _, bad := range []string{"hr.admin", "custom.", "custom.A", "custom.a" + strings.Repeat("b", 41), ""} {
		_, err := parseKey(bad)
		refused(t, bad, err)
	}
}

func TestParseCreate(t *testing.T) {
	ok := `{"key":"custom.reader","label":"  Người đọc  ","grants":[{"permission":"role.read","template":{"key":"role","version":1}}]}`
	body, err := decode[createBody](ok)
	if err != nil {
		t.Fatal(err)
	}
	input, err := parseCreate(body)
	want := CreateInput{Key: "custom.reader", Label: "Người đọc", Grants: []GrantPair{pair("role.read", "role", 1)}}
	if err != nil || !reflect.DeepEqual(input, want) {
		t.Fatalf("got %+v %v", input, err)
	}
	for _, raw := range []string{
		`{"key":"custom.reader","label":"x"}`,
		`{"key":"custom.reader","label":"x","grants":null}`,
		`{"key":"hr.admin","label":"x","grants":[]}`,
		`{"key":"custom.reader","label":"","grants":[]}`,
		`{"key":"custom.reader","label":"` + strings.Repeat("a", 121) + `","grants":[]}`,
		`{"key":"custom.reader","label":"a\u0000b","grants":[]}`,
		`{"key":"custom.reader","label":"x","grants":[{"permission":"role.read","template":{"key":"role","version":1}},{"permission":"role.read","template":{"key":"role","version":1}}]}`,
		`{"key":"custom.reader","label":"x","grants":[{"permission":"role.read","template":{"key":"role","version":0}}]}`,
		`{"key":"custom.reader","label":"x","grants":[{"permission":"role.read","template":{"key":"role","version":2147483648}}]}`,
	} {
		body, err := decode[createBody](raw)
		if err == nil {
			_, err = parseCreate(body)
		}
		if err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`{"key":"custom.reader","label":"x","grants":[],"managedBy":"code"}`,
		`{"key":"custom.reader","label":"x","grants":[{"permission":"role.read","template":{"key":"role","version":1},"parameters":{}}]}`,
		`{"key":"custom.reader","label":"x","grants":[{"permission":"role.read","template":"role"}]}`,
		`{"key":"custom.reader","label":"x","grants":[{"permission":"role.read","template":{"key":"role","version":1.5}}]}`,
		`{"key":"custom.reader","label":"x","grants":[{"permission":"role.read","template":{"key":"role","version":"1"}}]}`,
	} {
		if _, err := decode[createBody](raw); err == nil {
			t.Errorf("decoded %s", raw)
		}
	}
}

func TestParseCreateTakesExactlyTheLimits(t *testing.T) {
	grants := make([]GrantPair, 0, 301)
	for i := range 300 {
		grants = append(grants, pair(fmt.Sprintf("p.a%d", i), "t", 1))
	}
	input, err := parseCreate(createBody{Key: "custom.edge", Label: strings.Repeat("😀", 120), Grants: &grants})
	if err != nil || len(input.Grants) != 300 {
		t.Fatalf("300 grants: %v", err)
	}
	more := append(grants, pair("p.z", "t", 1))
	_, err = parseCreate(createBody{Key: "custom.edge", Label: "x", Grants: &more})
	refused(t, "301 grants", err)
}

func TestParseUpdate(t *testing.T) {
	digest := strings.Repeat("a", 64)
	grants := []GrantPair{pair("role.read", "role", 1)}
	input, err := parseUpdate("custom.reader", updateBody{Label: "Đọc", Grants: &grants, ExpectedDigest: digest})
	if err != nil || input.Key != "custom.reader" || input.ExpectedDigest != digest || input.Label != "Đọc" {
		t.Fatalf("got %+v %v", input, err)
	}
	_, err = parseUpdate("hr.admin", updateBody{Label: "x", Grants: &grants, ExpectedDigest: digest})
	refused(t, "hr.admin", err)
	for _, bad := range []string{"", strings.Repeat("A", 64), strings.Repeat("a", 63), strings.Repeat("a", 65)} {
		_, err := parseUpdate("custom.reader", updateBody{Label: "x", Grants: &grants, ExpectedDigest: bad})
		refused(t, "digest "+bad, err)
	}
	if _, err := decode[updateBody](`{"label":"x","grants":[],"expectedDigest":"` + digest + `","key":"custom.other"}`); err == nil {
		t.Error("decoded a key in the update body")
	}
}

func TestCheckCatalog(t *testing.T) {
	_, validated := release(t)
	if err := checkCatalog(validated, "x", []GrantPair{pair("role.read", "role", 1), pair("employee.read", "allEmployees", 1)}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]GrantPair{
		{pair("nope.read", "role", 1)},
		{pair("role.nope", "role", 1)},
		{pair("role.read", "allEmployees", 1)},
		{pair("role.read", "role", 2)},
		{pair("document.read", "ownedDocuments", 1)},
		{pair("document.update", "ownedDocuments", 1)},
		{pair("hrCompany.approvals", "company", 1)},
	} {
		refused(t, fmt.Sprint(bad), checkCatalog(validated, "x", bad))
	}
	both := []GrantPair{pair("hrCompany.approvals", "company", 1), pair("workRequest.decideFinal", "finalQueue", 1)}
	if err := checkCatalog(validated, "x", both); err != nil {
		t.Errorf("approvals with decideFinal: %v", err)
	}
	refused(t, "untrimmed label", checkCatalog(validated, " x", nil))
}

func TestTheCatalogIsEveryAcceptedPairSortedAndBounded(t *testing.T) {
	_, validated := release(t)
	pairs, err := catalog(validated)
	if err != nil {
		t.Fatal(err)
	}
	if len(pairs) != 142 {
		t.Errorf("catalog has %d pairs, the TypeScript release has 142", len(pairs))
	}
	encoded, err := json.Marshal(pairs)
	if err != nil {
		t.Fatal(err)
	}
	if digest := fmt.Sprintf("%x", sha256.Sum256(encoded)); digest != tsCatalogSHA256 {
		t.Errorf("catalog JSON sha256 %s, the TypeScript roleCatalog gives %s", digest, tsCatalogSHA256)
	}
	if !slices.IsSortedFunc(pairs, func(a, b GrantPair) int {
		return strings.Compare(a.Permission+" "+a.Template.Key, b.Permission+" "+b.Template.Key)
	}) {
		t.Error("catalog is not sorted")
	}
	for _, p := range pairs {
		if isDocument(p.Permission) || checkCatalog(validated, "x", []GrantPair{p}) != nil && p.Permission != permissionApprovals {
			t.Errorf("catalog lists %v", p)
		}
	}
}

func TestCapabilities(t *testing.T) {
	got := capabilities([]GrantPair{
		pair("account.read", "allAccounts", 1),
		pair("workRequest.decideFinal", "finalQueue", 1),
		pair("hrCompany.approvals", "company", 1),
		pair("employee.update", "selfEmployee", 1),
	})
	want := []Capability{CapabilitySelfApproval, CapabilityRequestDecision, CapabilityAccountAdministration}
	if !slices.Equal(got, want) {
		t.Errorf("got %v want %v", got, want)
	}
	if got := capabilities(nil); got == nil || len(got) != 0 {
		t.Errorf("no grant: %v", got)
	}
}
