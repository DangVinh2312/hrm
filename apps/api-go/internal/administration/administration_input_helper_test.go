package administration

import (
	"errors"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/declarations"
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
