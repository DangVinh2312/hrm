package credential

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestHOTPOfRFC6238WithEightDigits(t *testing.T) {
	secret := []byte("12345678901234567890")
	for counter, want := range map[uint64]string{
		0: "84755224", 1: "94287082", 9: "45520489", 37037036: "07081804", 66666666: "69279037",
		666666666: "65353130", 18446744073709551615: "63094451",
	} {
		if got := hotp(secret, counter, 8); got != want {
			t.Errorf("%d: %s, want %s", counter, got, want)
		}
	}
}

// The ciphertext Node writes for this key, nonce and the AAD of the helper: Go sealing with the same
// nonce must give the same bytes.
func TestSealMatchesNodeForAFixedNonce(t *testing.T) {
	got, err := seal(bytes.Repeat([]byte{0x11}, 32), bytes.Repeat([]byte{0x33}, 12),
		"7c9e6679-7425-40de-944b-e07fc1f90ae7", "k1", []byte("12345678901234567890"))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(got) != "b5b16172ffa442148b88da5f941fd61e31f03604b7924b5d8db4f0c52301a51bd6da49a8" {
		t.Errorf("got %x", got)
	}
}
