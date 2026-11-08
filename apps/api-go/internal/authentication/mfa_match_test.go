package authentication

import (
	"errors"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication/credential"
)

func TestAMatchCountsOnlyForTheSnapshotSecretAndItsSteps(t *testing.T) {
	snapshot := factorRow{
		Sealed:        credential.SealedTOTPSecret{Ciphertext: []byte{1, 2}, Nonce: []byte{3}, KeyID: "k1"},
		SecretVersion: "4", Step: "100",
	}
	match := codeMatch{at: 100, steps: [2]uint64{100, 101}, ok: [2]bool{false, true}}
	changed := map[string]func(*factorRow){
		"ciphertext": func(r *factorRow) { r.Sealed.Ciphertext = []byte{1, 9} },
		"nonce":      func(r *factorRow) { r.Sealed.Nonce = []byte{9} },
		"key":        func(r *factorRow) { r.Sealed.KeyID = "k2" },
		"version":    func(r *factorRow) { r.SecretVersion = "5" },
	}
	for name, change := range changed {
		row := snapshot
		change(&row)
		if _, _, err := match.matched(&snapshot, row); !errors.Is(err, apperror.ErrMfaConflict) {
			t.Errorf("another %s: %v", name, err)
		}
	}
	if _, _, err := match.matched(nil, snapshot); !errors.Is(err, apperror.ErrMfaConflict) {
		t.Errorf("no snapshot: %v", err)
	}
	fault := errors.New("open")
	if _, _, err := (codeMatch{at: 100, open: fault}).matched(&snapshot, snapshot); !errors.Is(err, fault) {
		t.Errorf("a seal fault: %v", err)
	}
	for step, want := range map[string]struct {
		step uint64
		ok   bool
		err  error
	}{"100": {100, false, nil}, "101": {101, true, nil}, "99": {0, false, apperror.ErrUnavailable}, "102": {0, false, apperror.ErrUnavailable}} {
		row := snapshot
		row.Step = step
		got, ok, err := match.matched(&snapshot, row)
		if got != want.step || ok != want.ok || !errors.Is(err, want.err) {
			t.Errorf("at %s: %d %v %v", step, got, ok, err)
		}
	}
}
