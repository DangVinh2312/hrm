package credential_test

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authentication/credential"
	"hrm/api-go/internal/config"
)

// The expected values below were printed once by the TypeScript functions of apps/api/dist (Node
// 24.20.0); the other runtime reads them from the same database, so they must not drift.

// r spells a code point, so this file stays ASCII and every case shows which character it holds.
func r(code rune) string { return string(code) }

func digestHex(digest []byte, err error) string {
	if err != nil {
		return "error"
	}
	return hex.EncodeToString(digest)
}

func TestSessionDigestTakesOnlyTheCanonicalSecret(t *testing.T) {
	for secret, want := range map[string]string{
		"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc":  "dc4bf80c77473d130fa0de86ba4018fe98bb214005e6a5891d12ba91446f9e81",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA":  "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB":  "error",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA":   "error",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA": "error",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+":  "error",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=":  "error",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n": "error",
		"": "error",
	} {
		digest, err := credential.SessionDigest(secret)
		if got := digestHex(digest, err); got != want {
			t.Errorf("%q: %s, want %s", secret, got, want)
		}
		if err != nil && !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%q: %v", secret, err)
		}
	}
}

func TestANewSessionSecretHasItsDigest(t *testing.T) {
	a, b := credential.NewSessionSecret(), credential.NewSessionSecret()
	if a == b {
		t.Fatal("two secrets are equal")
	}
	digest, err := credential.SessionDigest(a)
	if err != nil || !bytes.Equal(digest, credential.SecretDigest(a)) {
		t.Errorf("digest of a new secret: %v", err)
	}
}

func TestSecretDigest(t *testing.T) {
	for text, want := range map[string]string{
		"":                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"abc":             "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		"oidc:ip:1.2.3.4": "da591af54a8c035e8d5ebdd2957cebbb2eeb7994844624820a9f1cc1d511ec30",
	} {
		if got := hex.EncodeToString(credential.SecretDigest(text)); got != want {
			t.Errorf("%q: %s", text, got)
		}
	}
}

func TestFreshAuthSQL(t *testing.T) {
	const want = `(reauthenticated_at IS NOT NULL AND reauthenticated_at<=statement_timestamp() AND statement_timestamp()-reauthenticated_at<interval '300 seconds')`
	if credential.FreshAuthSQL != want {
		t.Errorf("got %s", credential.FreshAuthSQL)
	}
}

func TestCanonicalLoginEmailIsPrintableASCIIOnly(t *testing.T) {
	longest := strings.Repeat("x", 242) + "@example.com"
	for email, want := range map[string]string{
		"Kim@Example.com":                  "kim@example.com",
		"kim@example.com":                  "kim@example.com",
		longest:                            longest,
		r(0x212a) + "im@example.com":       "",
		r(0x130) + "nfo@example.com":       "",
		"i" + r(0x307) + "nfo@example.com": "",
		"kim@ex" + r(0xe4) + "mple.com":    "",
		r(0xff4d) + "ail@example.com":      "",
		"a" + r(0x01) + "b@example.com":    "",
		"a" + r(0x7f) + "b@example.com":    "",
		"a" + r(0xa0) + "b@example.com":    "",
		"a\xed\xa0\xbdb@example.com":       "",
		"a" + r(0xfffd) + "b@example.com":  "",
		"a b@example.com":                  "",
		"ab@example":                       "",
		"a@@example.com":                   "",
		"@example.com":                     "",
		"a@.com":                           "",
		"a@b.":                             "",
		"x" + longest:                      "",
		"":                                 "",
		"kim@example.com\n":                "",
	} {
		got, err := credential.CanonicalLoginEmail(email)
		if want == "" {
			if !errors.Is(err, apperror.ErrAuthenticationFailed) {
				t.Errorf("%q: accepted as %q", email, got)
			}
			continue
		}
		if err != nil || got != want {
			t.Errorf("%q: %q %v, want %q", email, got, err, want)
		}
	}
}

func TestRootEnrollmentHash(t *testing.T) {
	got, err := credential.RootEnrollmentHash(credential.RootInvitation{
		UserID: "7c9e6679-7425-40de-944b-e07fc1f90ae7", Email: "root@example.com", AuthEpoch: "3",
		TokenHash: bytes.Repeat([]byte{0xaa}, 32),
	}, "https://accounts.google.com")
	if digestHex(got, err) != "06f9a862d8dfdab721ecd442e38af0a74ce8f528101fd08fc205d7c1e7069a17" {
		t.Errorf("got %x %v", got, err)
	}
}

func TestRateLimitClient(t *testing.T) {
	for address, want := range map[string]string{
		"1.2.3.4":                    "1.2.3.4",
		"1.2.3.4:8080":               "1.2.3.4",
		"[2001:db8:1:2:3:4:5:6]:443": "2001:db8:1:2::/64",
		"2001:db8:1:2:3:4:5:6":       "2001:db8:1:2::/64",
		"2001:0db8:0001:0002::1":     "2001:db8:1:2::/64",
		"2001:db8::1":                "2001:db8:0:0::/64",
		"2001:DB8:A:B::":             "2001:db8:a:b::/64",
		"fe80::1%eth0":               "fe80:0:0:0::/64",
		"::ffff:1.2.3.4":             "1.2.3.4",
		"::ffff:102:304":             "1.2.3.4",
		"::1.2.3.4":                  "1.2.3.4",
		"::1":                        "0:0:0:0::/64",
		"::":                         "0:0:0:0::/64",
		"64:ff9b::1.2.3.4":           "1.2.3.4",
		"64:ff9b::0102:0304":         "1.2.3.4",
		"64:ff9b:1::1.2.3.4":         "64:ff9b:1:0::/64",
		"01.2.3.4":                   "01.2.3.4",
		"not-an-ip":                  "not-an-ip",
		"[not-v6]:80":                "[not-v6]:80",
	} {
		if got := credential.RateLimitClient(address); got != want {
			t.Errorf("%q: %q, want %q", address, got, want)
		}
	}
}

type bucket struct {
	digest string
	limit  int32
}

func TestRateLimitBucketsInOrderNetworkClientIdentifier(t *testing.T) {
	const user = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	login := bucket{"d15fe20531562985a8f42181931f50c36ec7564a8c347c43f248d07128ab2a04", 20}
	for _, c := range []struct {
		client, identifier, purpose string
		want                        []bucket
	}{
		{"1.2.3.4", "1.2.3.4", "oidc", []bucket{{"da591af54a8c035e8d5ebdd2957cebbb2eeb7994844624820a9f1cc1d511ec30", 20}}},
		{"2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64", "oidc", []bucket{
			{"941fe2ce1d0521bac89be651485e438b69c9e47c0d3e20f86fa7f4f5ec857d5b", 200},
			{"4a3d0d0931481900c5373485470cc5160024692bf0dc7fac8a69eb64a5c2b863", 20},
		}},
		{"1.2.3.4", user, "mfa", []bucket{{"3c9d0da317f3bddcbb5a9b471c07137220dd1de6a57b4463e6cef2419c3ca0cf", 20}, login}},
		{"2001:db8:a:b::9", user, "mfa", []bucket{
			{"49d940317b609cc35a91dc41bc471c9dcaeecf7d44d9a614da4fd5bf5a4d7ef6", 200},
			{"e903e6162d8de79681c2860577946a8737df6c78c477160ad857d4594ebe1ba9", 20},
			login,
		}},
	} {
		buckets, err := credential.RateLimitBuckets(c.client, c.identifier, c.purpose)
		if err != nil {
			t.Fatalf("%s: %v", c.client, err)
		}
		var got []bucket
		for _, b := range buckets {
			got = append(got, bucket{hex.EncodeToString(b.Key), b.Limit})
		}
		if len(got) != len(c.want) {
			t.Fatalf("%s %s: %v", c.client, c.purpose, got)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s %s bucket %d: %v, want %v", c.client, c.purpose, i, got[i], c.want[i])
			}
		}
	}
}

func TestRateLimitBucketsRefuseAnEmptyOrLongClient(t *testing.T) {
	for _, client := range []string{"", strings.Repeat("a", 257), strings.Repeat(r(0xe9), 257), strings.Repeat(r(0x1f600), 257)} {
		if _, err := credential.RateLimitBuckets(client, "x", "oidc"); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%d bytes: %v", len(client), err)
		}
	}
	for _, client := range []string{strings.Repeat(r(0xe9), 256), strings.Repeat(r(0x1f600), 256)} {
		if _, err := credential.RateLimitBuckets(client, "x", "oidc"); err != nil {
			t.Errorf("256 characters, %d bytes: %v", len(client), err)
		}
	}
}

func TestBase32(t *testing.T) {
	for text, want := range map[string]string{
		"": "", "f": "MY", "fo": "MZXQ", "foo": "MZXW6", "foob": "MZXW6YQ", "fooba": "MZXW6YTB", "foobar": "MZXW6YTBOI",
	} {
		if got := credential.Base32Encode([]byte(text)); got != want {
			t.Errorf("encode %q: %q", text, got)
		}
		if got, err := credential.Base32Decode(want); err != nil || string(got) != text {
			t.Errorf("decode %q: %q %v", want, got, err)
		}
	}
	for _, text := range []string{"MZXW6YR", "M", "MZX", "mzxw6", "MZXW6YQ=", "MZ0", "MZXW6\n", "MZ XW6"} {
		if got, err := credential.Base32Decode(text); err == nil {
			t.Errorf("decode %q: %x", text, got)
		}
	}
}

var rfcSecret = []byte("12345678901234567890")

func TestHOTP(t *testing.T) {
	for counter, want := range map[uint64]string{
		0: "755224", 1: "287082", 9: "520489", 37037036: "081804", 66666666: "279037",
		666666666: "353130", 18446744073709551615: "094451",
	} {
		if got := credential.HOTP(rfcSecret, counter); got != want {
			t.Errorf("%d: %s, want %s", counter, got, want)
		}
	}
}

func TestMatchTOTPTakesTheStepBeforeAndAfter(t *testing.T) {
	for _, c := range []struct {
		code    string
		step    uint64
		matched uint64
		ok      bool
	}{
		{"295165", 100, 100, true},
		{"516516", 100, 99, true},
		{"329376", 100, 101, true},
		{"629694", 100, 0, false},
		{"755224", 0, 0, true},
		{"12345", 100, 0, false},
		{"1234567", 100, 0, false},
		{"29516" + r(0xff15), 100, 0, false},
		{" 295165", 100, 0, false},
		{"094451", 18446744073709551615, 18446744073709551615, true},
	} {
		matched, ok := credential.MatchTOTP(rfcSecret, c.code, c.step)
		if ok != c.ok || matched != c.matched {
			t.Errorf("%q at %d: %d %v", c.code, c.step, matched, ok)
		}
	}
}

func TestTOTPURI(t *testing.T) {
	const tail = "?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=HRM&algorithm=SHA1&digits=6&period=30"
	for email, want := range map[string]string{
		"kim+test@example.com": "otpauth://totp/HRM:kim%2Btest%40example.com" + tail,
		"a!~*'()_.-@x.y":       "otpauth://totp/HRM:a!~*'()_.-%40x.y" + tail,
		"":                     "otpauth://totp/HRM:" + tail,
	} {
		if got := credential.TOTPURI(rfcSecret, &email); got != want {
			t.Errorf("%q: %s", email, got)
		}
	}
	if got := credential.TOTPURI(rfcSecret, nil); got != "otpauth://totp/HRM"+tail {
		t.Errorf("no email: %s", got)
	}
}

func TestRecoveryCodes(t *testing.T) {
	code := credential.NewRecoveryCode()
	if normalized, ok := credential.NormalizeRecoveryCode(credential.FormatRecoveryCode(code)); !ok || normalized != code {
		t.Errorf("a new code %q does not read back: %q %v", code, normalized, ok)
	}
	if got := credential.FormatRecoveryCode("ABCDEFGHIJKLMNOP"); got != "ABCD-EFGH-IJKL-MNOP" {
		t.Errorf("format: %s", got)
	}
	for input, want := range map[string]string{
		"abcd-efgh-ijkl-mnop":                        "ABCDEFGHIJKLMNOP",
		"ABCD EFGH\tIJKL\nMNOP":                      "ABCDEFGHIJKLMNOP",
		"ABCDEFGHIJKLMNOP" + strings.Repeat(" ", 48): "ABCDEFGHIJKLMNOP",
		"ABCDEFGHIJKLMNOP" + strings.Repeat(" ", 49): "",
		"ABCDEFGHIJKLMNO1":                           "",
		"ABCDEFGHIJKLMNO":                            "",
		"ABCDEFGHIJKLMNOPQ":                          "",
		strings.Repeat("-", 65):                      "",
		"ABCDEFGHIJKLMNO" + r(0x17f):                 "",
		"ABCDEFGHIJKLMNO" + r(0x131):                 "",
		"ABCDEFGHIJKLMN" + r(0xdf):                   "",
		"ABCDEFGHIJKLMN" + r(0xfb00):                 "",
		"ABCDEFGH" + r(0x85) + "IJKLMNOP":            "",
		"ABCDEFGH" + r(0xfeff) + "IJKLMNOP":          "ABCDEFGHIJKLMNOP",
		"ABCDEFGH" + r(0xa0) + "IJKLMNOP":            "ABCDEFGHIJKLMNOP",
	} {
		got, ok := credential.NormalizeRecoveryCode(input)
		if ok != (want != "") || got != want {
			t.Errorf("%q: %q %v, want %q", input, got, ok, want)
		}
	}
	got := hex.EncodeToString(credential.RecoveryCodeHash("7c9e6679-7425-40de-944b-e07fc1f90ae7", "ABCDEFGHIJKLMNOP"))
	if got != "555e6a2396adcbce9b8c620efb98c37ba97674f209c1f274a53fe72e42fa09fe" {
		t.Errorf("hash %s", got)
	}
}

const (
	mfaUser = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	mfaKeys = "k1:ERERERERERERERERERERERERERERERERERERERERERE=,k2:IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI="
)

func ring(t *testing.T) config.MfaKeyRing {
	t.Helper()
	parsed, err := config.ParseMfaKeyRing(mfaKeys, "k2")
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func unhex(t *testing.T, text string) []byte {
	t.Helper()
	raw, err := hex.DecodeString(text)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestASecretSealedByTypeScriptOpens(t *testing.T) {
	keys := ring(t)
	sealed := credential.SealedTOTPSecret{
		Ciphertext: unhex(t, "4b4f5a217c71aa7f503f379cc40fd473e8c53db451e3544765150e56be8be6df1ae9eeb5"),
		Nonce:      unhex(t, "70f6838caa8c42f895c63530"),
		KeyID:      "k2",
	}
	opened, err := credential.DecryptTOTPSecret(keys, mfaUser, sealed)
	if err != nil || !bytes.Equal(opened, rfcSecret) {
		t.Fatalf("opened %x %v", opened, err)
	}
	fixed := credential.SealedTOTPSecret{
		Ciphertext: unhex(t, "b5b16172ffa442148b88da5f941fd61e31f03604b7924b5d8db4f0c52301a51bd6da49a8"),
		Nonce:      unhex(t, "333333333333333333333333"),
		KeyID:      "k1",
	}
	if opened, err := credential.DecryptTOTPSecret(keys, mfaUser, fixed); err != nil || !bytes.Equal(opened, rfcSecret) {
		t.Fatalf("opened with the old key %x %v", opened, err)
	}

	tampered := sealed
	tampered.Ciphertext = bytes.Clone(sealed.Ciphertext)
	tampered.Ciphertext[0] ^= 1
	shortNonce := sealed
	shortNonce.Nonce = sealed.Nonce[:11]
	tagOnly := sealed
	tagOnly.Ciphertext = sealed.Ciphertext[len(sealed.Ciphertext)-16:]
	relabelled := sealed
	relabelled.KeyID = "k1"
	unknown := sealed
	unknown.KeyID = "k3"
	for name, c := range map[string]struct {
		user   string
		sealed credential.SealedTOTPSecret
	}{
		"other user":  {"00000000-0000-4000-8000-000000000002", sealed},
		"relabelled":  {mfaUser, relabelled},
		"unknown key": {mfaUser, unknown},
		"tampered":    {mfaUser, tampered},
		"short nonce": {mfaUser, shortNonce},
		"tag only":    {mfaUser, tagOnly},
	} {
		if opened, err := credential.DecryptTOTPSecret(keys, c.user, c.sealed); !errors.Is(err, credential.ErrSealedSecret) || opened != nil {
			t.Errorf("%s: %x %v", name, opened, err)
		}
	}
}

func TestASecretSealsWithTheCurrentKeyAndAFreshNonce(t *testing.T) {
	keys := ring(t)
	a, err := credential.EncryptTOTPSecret(keys, mfaUser, rfcSecret)
	if err != nil {
		t.Fatal(err)
	}
	b, err := credential.EncryptTOTPSecret(keys, mfaUser, rfcSecret)
	if err != nil {
		t.Fatal(err)
	}
	if a.KeyID != "k2" || len(a.Nonce) != 12 || len(a.Ciphertext) != len(rfcSecret)+16 || bytes.Equal(a.Nonce, b.Nonce) {
		t.Errorf("sealed %s %d %d, same nonce %v", a.KeyID, len(a.Nonce), len(a.Ciphertext), bytes.Equal(a.Nonce, b.Nonce))
	}
	if opened, err := credential.DecryptTOTPSecret(keys, mfaUser, a); err != nil || !bytes.Equal(opened, rfcSecret) {
		t.Errorf("round trip %x %v", opened, err)
	}
	if _, err := credential.EncryptTOTPSecret(config.MfaKeyRing{}, mfaUser, rfcSecret); err == nil {
		t.Error("an empty ring sealed")
	}
	if text := base64.StdEncoding.EncodeToString(a.Ciphertext); strings.Contains(text, "ERERERER") {
		t.Error("key material in the ciphertext")
	}
}
