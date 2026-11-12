package administration

import (
	"errors"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authorization/declarations"
)

func text(value string) *string { return &value }

func TestARoleKeyOfARequestIsOnlyBoundedBySize(t *testing.T) {
	for _, accepted := range []string{"hr.admin", "custom.m8_x", "x", strings.Repeat("a", 96)} {
		if key, err := inputRoleKey(text(accepted)); err != nil || key != accepted {
			t.Errorf("%q: %q %v", accepted, key, err)
		}
	}
	for name, refused := range map[string]*string{"absent": nil, "empty": text(""), "97 bytes": text(strings.Repeat("a", 97)), "49 two-byte runes": text(strings.Repeat(string(rune(0xe9)), 49))} {
		if _, err := inputRoleKey(refused); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestAProvisionBodyNeedsAnEmailAndARoleKey(t *testing.T) {
	if input, err := parseProvision(provisionBody{Email: text("A@example.test"), RoleKey: text("hr.employee")}); err != nil || input.Email != "A@example.test" || input.RoleKey != "hr.employee" {
		t.Errorf("%+v %v", input, err)
	}
	for name, body := range map[string]provisionBody{
		"no email":      {RoleKey: text("hr.employee")},
		"no role":       {Email: text("a@example.test")},
		"long email":    {Email: text(strings.Repeat("a", 2049)), RoleKey: text("hr.employee")},
		"empty role":    {Email: text("a@example.test"), RoleKey: text("")},
		"long role key": {Email: text("a@example.test"), RoleKey: text(strings.Repeat("a", 97))},
	} {
		if _, err := parseProvision(body); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Without exactly one OIDC provider there is no issuer to enroll at: the service answers unavailable before it
// canonicalizes the email, asks the authority or opens a transaction (the controller has decoded the body and
// read the session cookie already).
func TestProvisioningWithoutAnIssuerIsUnavailable(t *testing.T) {
	_, err := (&Service{}).Provision(t.Context(), "secret", ProvisionInput{Email: "not an email", RoleKey: ""})
	if !errors.Is(err, apperror.ErrUnavailable) {
		t.Errorf("%v", err)
	}
}

func version(value int64) *int64 { return &value }

func TestABoundaryRefIsAKeyOfTheGrammarAndAnIntegerVersion(t *testing.T) {
	for _, key := range []string{"identityAdministration", "a", "A.b_c-9", "a" + strings.Repeat("b", 95)} {
		if ref, err := inputBoundaryRef(text(key), version(1)); err != nil || ref != (BoundaryRef{Key: key, Version: 1}) {
			t.Errorf("%q: %+v %v", key, ref, err)
		}
	}
	if ref, err := inputBoundaryRef(text("a"), version(2147483647)); err != nil || ref.Version != 2147483647 {
		t.Errorf("largest version: %+v %v", ref, err)
	}
	type ref struct {
		key     *string
		version *int64
	}
	for name, refused := range map[string]ref{
		"no key": {nil, version(1)}, "no version": {text("a"), nil}, "empty key": {text(""), version(1)},
		"digit first": {text("1a"), version(1)}, "space": {text("a b"), version(1)}, "97 bytes": {text("a" + strings.Repeat("b", 96)), version(1)},
		"zero": {text("a"), version(0)}, "negative": {text("a"), version(-1)}, "past int4": {text("a"), version(2147483648)},
	} {
		if _, err := inputBoundaryRef(refused.key, refused.version); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestABoundaryVersionSegmentIsDecimalWithoutALeadingZero(t *testing.T) {
	for segment, want := range map[string]int64{"1": 1, "42": 42, "2147483647": 2147483647, "9999999999": 9999999999} {
		if got := inputBoundaryVersionParam(segment); got == nil || *got != want {
			t.Errorf("%q: %v", segment, got)
		}
	}
	for _, segment := range []string{"", "0", "01", "+1", "-1", "1.0", "1e2", "a", "10000000000", " 1"} {
		if got := inputBoundaryVersionParam(segment); got != nil {
			t.Errorf("%q: %d", segment, *got)
		}
	}
	if _, err := inputBoundaryRef(text("a"), inputBoundaryVersionParam("2147483648")); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("a segment past int4: %v", err)
	}
}

func TestAnEmailBodyIsOneBoundedString(t *testing.T) {
	if email, err := parseEmailBody(emailBody{Email: text("A@example.test")}); err != nil || email != "A@example.test" {
		t.Errorf("%q %v", email, err)
	}
	for name, body := range map[string]emailBody{"absent": {}, "long": {Email: text(strings.Repeat("a", 2049))}} {
		if _, err := parseEmailBody(body); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// changeEmail and resetGoogleBinding enroll at the deployment's one provider: without it they are unavailable
// before anything else. resetMfa needs no provider and goes on to refuse the non-canonical id.
func TestTheIdentityCommandsNeedingAnIssuerAreUnavailableWithoutIt(t *testing.T) {
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{operations: &Operations{core: c}}
	if err := s.ChangeEmail(t.Context(), "secret", "X", "not an email"); !errors.Is(err, apperror.ErrUnavailable) {
		t.Errorf("changeEmail: %v", err)
	}
	if err := s.ResetGoogleBinding(t.Context(), "secret", "X"); !errors.Is(err, apperror.ErrUnavailable) {
		t.Errorf("resetGoogleBinding: %v", err)
	}
	if err := s.ResetMfa(t.Context(), "secret", "X"); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("resetMfa: %v", err)
	}
}

// With an issuer, the id is checked before the email: a non-canonical id is 403 whatever the email, a canonical
// id with a bad email is 400, both before the authority (nil here) is asked.
func TestAnEmailChangeChecksTheIdThenTheEmail(t *testing.T) {
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{operations: &Operations{core: c}, issuer: "https://issuer.example.test"}
	if err := s.ChangeEmail(t.Context(), "secret", strings.ToUpper("0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21"), "not an email"); !errors.Is(err, apperror.ErrAccessDenied) {
		t.Errorf("upper-case id: %v", err)
	}
	if err := s.ChangeEmail(t.Context(), "secret", "0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21", "not an email"); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("bad email: %v", err)
	}
	if err := s.BindBoundary(t.Context(), "secret", "0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21", BoundaryRef{Key: "a", Version: 0}); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("bad boundary: %v", err)
	}
}

// A target that is not a canonical lowercase UUID is refused before the authority (nil here) is asked.
func TestANonCanonicalTargetIsRefusedFirst(t *testing.T) {
	c, err := declarations.NewCore()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{strings.ToUpper("0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21"), "{0b9c7a8e-2f3d-4c1b-9a8e-7d6c5b4a3f21}", "0b9c7a8e2f3d4c1b9a8e7d6c5b4a3f21", "x", ""} {
		if done, err := onAccount(t.Context(), nil, c, "secret", accountCommand[accountID]{}, accountID(id)); done || !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("%q: %v %v", id, done, err)
		}
	}
}
