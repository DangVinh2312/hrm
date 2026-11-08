package apperror_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"hrm/api-go/internal/apperror"
)

type contract struct {
	Codes    []apperror.Code `json:"codes"`
	ByStatus []struct {
		Status int           `json:"status"`
		Code   apperror.Code `json:"code"`
	} `json:"byStatus"`
	Below500   apperror.Code `json:"below500"`
	From500    apperror.Code `json:"from500"`
	Rejections []struct {
		Code   apperror.Code `json:"code"`
		Status int           `json:"status"`
	} `json:"rejections"`
}

func readContract(t *testing.T) contract {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "contract", "api-errors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var parsed contract
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestCodesAreTheContractSet(t *testing.T) {
	if got, want := apperror.Codes(), readContract(t).Codes; !slices.Equal(got, want) {
		t.Errorf("codes %v, contract %v", got, want)
	}
}

func TestCodesReturnsACopy(t *testing.T) {
	apperror.Codes()[0] = "error.changed"
	if apperror.Codes()[0] != "error.invalidRequest" {
		t.Error("the closed set changed through a returned slice")
	}
}

func TestEveryStatusHasItsKey(t *testing.T) {
	expected := map[int]apperror.Code{
		400: "error.invalidRequest", 401: "error.authenticationFailed", 403: "error.accessDenied",
		404: "error.notFound", 409: "error.conflict", 413: "error.invalidRequest", 415: "error.invalidRequest",
		422: "error.invalidRequest", 429: "error.invalidRequest", 499: "error.invalidRequest",
		500: "error.unavailable", 502: "error.unavailable", 503: "error.unavailable",
	}
	for status, code := range expected {
		if got := apperror.CodeFor(status); got != code {
			t.Errorf("status %d: %s, want %s", status, got, code)
		}
	}
	parsed := readContract(t)
	for _, entry := range parsed.ByStatus {
		if got := apperror.CodeFor(entry.Status); got != entry.Code {
			t.Errorf("contract status %d: %s, want %s", entry.Status, got, entry.Code)
		}
	}
	if apperror.CodeFor(400) != parsed.Below500 || apperror.CodeFor(500) != parsed.From500 {
		t.Error("the defaults differ from the contract")
	}
	for status := 100; status < 600; status++ {
		if !slices.Contains(apperror.Codes(), apperror.CodeFor(status)) {
			t.Errorf("status %d has a key outside the closed set", status)
		}
	}
}

func TestRejectionTableIsTheContract(t *testing.T) {
	rejections := readContract(t).Rejections
	if len(rejections) != 12 {
		t.Fatalf("contract has %d rejections, want 12", len(rejections))
	}
	listed := map[apperror.Code]bool{}
	for _, entry := range rejections {
		listed[entry.Code] = true
		status, code, known := apperror.Response(apperror.Rejection{Code: entry.Code})
		if !known || status != entry.Status || code != entry.Code {
			t.Errorf("%s: %d %s %v, want %d", entry.Code, status, code, known, entry.Status)
		}
	}
	for _, code := range apperror.Codes() {
		if listed[code] {
			continue
		}
		if _, _, known := apperror.Response(apperror.Rejection{Code: code}); known {
			t.Errorf("%s is not a rejection key but is answered as one", code)
		}
	}
}

func TestAnUnknownRejectionKeyIsAProgrammingFault(t *testing.T) {
	for _, code := range []apperror.Code{"", "error.custom", "error.notFound", "error.unavailable", "ERROR.PERIODCLOSED"} {
		status, answered, known := apperror.Response(apperror.Rejection{Code: code})
		if known || status != 503 || answered != "error.unavailable" {
			t.Errorf("%q: %d %s %v", code, status, answered, known)
		}
	}
}

func TestMappedErrorsAnswerTheirStatus(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   apperror.Code
	}{
		{apperror.ErrInvalidRequest, 400, "error.invalidRequest"},
		{apperror.ErrAuthenticationFailed, 401, "error.authenticationFailed"},
		{apperror.ErrAccessDenied, 403, "error.accessDenied"},
		{apperror.ErrStepUpRequired, 403, "error.accessDenied"},
		{apperror.ErrNotFound, 404, "error.notFound"},
		{apperror.ErrCommandRejected, 409, "error.conflict"},
		{apperror.ErrMfaConflict, 409, "error.conflict"},
		{apperror.ErrUnavailable, 503, "error.unavailable"},
		{fmt.Errorf("role: %w", apperror.ErrAccessDenied), 403, "error.accessDenied"},
		{fmt.Errorf("submit: %w", apperror.Rejection{Code: "error.periodClosed"}), 409, "error.periodClosed"},
	}
	for _, c := range cases {
		status, code, known := apperror.Response(c.err)
		if !known || status != c.status || code != c.code {
			t.Errorf("%v: %d %s %v, want %d %s", c.err, status, code, known, c.status, c.code)
		}
	}
}

func TestAnUnexpectedErrorIsUnavailable(t *testing.T) {
	for _, err := range []error{errors.New("person@example.test"), nil, &json.SyntaxError{}} {
		status, code, known := apperror.Response(err)
		if known || status != 503 || code != "error.unavailable" {
			t.Errorf("%v: %d %s %v", err, status, code, known)
		}
	}
}

func TestErrorTextCarriesNoKeyChoice(t *testing.T) {
	if got := (apperror.Rejection{Code: "error.periodClosed"}).Error(); got != "rejected: error.periodClosed" {
		t.Errorf("%q", got)
	}
}
