package config_test

import (
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"strings"
	"testing"

	"hrm/api-go/internal/config"
)

const (
	keyA = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
	keyB = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI="
)

func validEnv() map[string]string {
	env := map[string]string{
		"NODE_ENV":              "test",
		"APP_ORIGIN":            "http://localhost:3000",
		"OIDC_PROVIDERS_JSON":   `[{"issuer":"https://idp.example.test","clientId":"fixture-client","redirectUri":"http://localhost:3000/api/auth/oidc/callback","version":"1","assuranceMappings":[]}]`,
		"MFA_ENCRYPTION_KEYS":   "fixture:" + keyA,
		"MFA_ENCRYPTION_KEY_ID": "fixture",
	}
	for _, purpose := range []string{"data", "identity", "authority", "sync"} {
		env["PRODUCT_"+strings.ToUpper(purpose)+"_DATABASE_URL"] = "postgres://product_" + purpose + ":synthetic@localhost/product"
	}
	return env
}

func withEnv(changes map[string]string, removed ...string) map[string]string {
	env := validEnv()
	maps.Copy(env, changes)
	for _, key := range removed {
		delete(env, key)
	}
	return env
}

func TestLoadCarriesTheUpstream(t *testing.T) {
	loaded, err := config.Load(withEnv(map[string]string{"API_UPSTREAM_URL": "http://127.0.0.1:3001"}))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.UpstreamURL != "http://127.0.0.1:3001" {
		t.Errorf("%q", loaded.UpstreamURL)
	}
	if loaded, err = config.Load(validEnv()); err != nil || loaded.UpstreamURL != "" {
		t.Errorf("%q %v", loaded.UpstreamURL, err)
	}
}

func TestLoadAcceptsTheValidEnvironment(t *testing.T) {
	loaded, err := config.Load(validEnv())
	if err != nil {
		t.Fatal(err)
	}
	if loaded.NodeEnv != "test" || loaded.Port != 3000 || loaded.TrustProxy != 0 {
		t.Fatalf("defaults: %s %d %d", loaded.NodeEnv, loaded.Port, loaded.TrustProxy)
	}
	if loaded.Origin != "http://localhost:3000" {
		t.Fatalf("origin %q", loaded.Origin)
	}
	if loaded.Databases.Authority != "postgres://product_authority:synthetic@localhost/product" {
		t.Fatal("authority URL is not kept")
	}
	if len(loaded.OidcProviders) != 1 || loaded.OidcProviders[0].ClientID != "fixture-client" {
		t.Fatalf("providers %d", len(loaded.OidcProviders))
	}
	if loaded.MfaKeys.Current() != "fixture" {
		t.Fatalf("current key %q", loaded.MfaKeys.Current())
	}
	if got := strings.Join(loaded.LogLevels, ","); got != "fatal,error,warn,log" {
		t.Fatalf("log levels %q", got)
	}
}

func TestLoadRejects(t *testing.T) {
	cases := []struct {
		name    string
		changes map[string]string
		removed []string
		message string
	}{
		{name: "admin credential", changes: map[string]string{"DATABASE_ADMIN_URL": "postgres://postgres:x@localhost/postgres"}, message: "DATABASE_ADMIN_URL must not be present"},
		{name: "migration credential", changes: map[string]string{"PRODUCT_MIGRATION_DATABASE_URL": "postgres://product_migration:x@localhost/product"}, message: "PRODUCT_MIGRATION_DATABASE_URL must not be present"},
		{name: "bootstrap credential", changes: map[string]string{"PRODUCT_BOOTSTRAP_DATABASE_URL": "postgres://product_bootstrap:x@localhost/product"}, message: "PRODUCT_BOOTSTRAP_DATABASE_URL must not be present"},
		{name: "AUTH_METHODS oidc", changes: map[string]string{"AUTH_METHODS": "oidc"}, message: "AUTH_METHODS"},
		{name: "AUTH_METHODS local", changes: map[string]string{"AUTH_METHODS": "local,oidc"}, message: "AUTH_METHODS"},
		{name: "AUTH_METHODS empty", changes: map[string]string{"AUTH_METHODS": ""}, message: "AUTH_METHODS"},
		{name: "another login in data", changes: map[string]string{"PRODUCT_DATA_DATABASE_URL": "postgres://product_identity:x@localhost/product"}, message: "PRODUCT_DATA_DATABASE_URL"},
		{name: "percent encoded login", changes: map[string]string{"PRODUCT_DATA_DATABASE_URL": "postgres://product%5Fdata:x@localhost/product"}, message: "PRODUCT_DATA_DATABASE_URL"},
		{name: "wrong protocol", changes: map[string]string{"PRODUCT_DATA_DATABASE_URL": "mysql://product_data:x@localhost/product"}, message: "PRODUCT_DATA_DATABASE_URL"},
		{name: "no host", changes: map[string]string{"PRODUCT_SYNC_DATABASE_URL": "postgres://product_sync:x@/product"}, message: "PRODUCT_SYNC_DATABASE_URL"},
		{name: "no database", changes: map[string]string{"PRODUCT_SYNC_DATABASE_URL": "postgres://product_sync:x@localhost/"}, message: "PRODUCT_SYNC_DATABASE_URL"},
		{name: "not a URL", changes: map[string]string{"PRODUCT_SYNC_DATABASE_URL": "do-not-print-me-either"}, message: "PRODUCT_SYNC_DATABASE_URL"},
		{name: "another database name", changes: map[string]string{"PRODUCT_SYNC_DATABASE_URL": "postgres://product_sync:x@localhost/other"}, message: "must point to one database"},
		{name: "another host", changes: map[string]string{"PRODUCT_AUTHORITY_DATABASE_URL": "postgres://product_authority:x@elsewhere/product"}, message: "must point to one database"},
		{name: "another port", changes: map[string]string{"PRODUCT_IDENTITY_DATABASE_URL": "postgres://product_identity:x@localhost:5433/product"}, message: "must point to one database"},
		{name: "missing data URL", removed: []string{"PRODUCT_DATA_DATABASE_URL"}, message: "PRODUCT_DATA_DATABASE_URL"},
		{name: "missing identity URL", removed: []string{"PRODUCT_IDENTITY_DATABASE_URL"}, message: "PRODUCT_IDENTITY_DATABASE_URL"},
		{name: "missing authority URL", removed: []string{"PRODUCT_AUTHORITY_DATABASE_URL"}, message: "PRODUCT_AUTHORITY_DATABASE_URL"},
		{name: "missing sync URL", removed: []string{"PRODUCT_SYNC_DATABASE_URL"}, message: "PRODUCT_SYNC_DATABASE_URL"},
		{name: "missing NODE_ENV", removed: []string{"NODE_ENV"}, message: "NODE_ENV"},
		{name: "unknown NODE_ENV", changes: map[string]string{"NODE_ENV": "staging"}, message: "NODE_ENV"},
		{name: "missing origin", removed: []string{"APP_ORIGIN"}, message: "APP_ORIGIN"},
		{name: "origin with path", changes: map[string]string{"APP_ORIGIN": "http://localhost:3000/app"}, message: "APP_ORIGIN"},
		{name: "origin with query", changes: map[string]string{"APP_ORIGIN": "http://localhost:3000/?a=1"}, message: "APP_ORIGIN"},
		{name: "origin with credentials", changes: map[string]string{"APP_ORIGIN": "http://user:x@localhost:3000"}, message: "APP_ORIGIN"},
		{name: "origin without host", changes: map[string]string{"APP_ORIGIN": "https://"}, message: "APP_ORIGIN"},
		{name: "origin of another scheme", changes: map[string]string{"APP_ORIGIN": "ftp://localhost"}, message: "APP_ORIGIN"},
		{name: "http origin in production", changes: map[string]string{"NODE_ENV": "production"}, message: "APP_ORIGIN"},
		{name: "missing providers", removed: []string{"OIDC_PROVIDERS_JSON"}, message: "OIDC_PROVIDERS_JSON"},
		{name: "empty providers", changes: map[string]string{"OIDC_PROVIDERS_JSON": "[]"}, message: "OIDC_PROVIDERS_JSON"},
		{name: "providers not a list", changes: map[string]string{"OIDC_PROVIDERS_JSON": "{}"}, message: "OIDC_PROVIDERS_JSON"},
		{name: "null provider", changes: map[string]string{"OIDC_PROVIDERS_JSON": "[null]"}, message: "OIDC_PROVIDERS_JSON"},
		{name: "http issuer", changes: map[string]string{"OIDC_PROVIDERS_JSON": provider("http://idp.example.test", "http://localhost:3000/api/auth/oidc/callback")}, message: "OIDC_PROVIDERS_JSON"},
		{name: "issuer with query", changes: map[string]string{"OIDC_PROVIDERS_JSON": provider("https://idp.example.test/?a=1", "http://localhost:3000/api/auth/oidc/callback")}, message: "OIDC_PROVIDERS_JSON"},
		{name: "callback on another origin", changes: map[string]string{"OIDC_PROVIDERS_JSON": provider("https://idp.example.test", "http://elsewhere:3000/api/auth/oidc/callback")}, message: "OIDC_PROVIDERS_JSON"},
		{name: "callback on another path", changes: map[string]string{"OIDC_PROVIDERS_JSON": provider("https://idp.example.test", "http://localhost:3000/callback")}, message: "OIDC_PROVIDERS_JSON"},
		{name: "field name of another case", changes: map[string]string{"OIDC_PROVIDERS_JSON": `[{"ISSUER":"https://idp.example.test","clientId":"c","redirectUri":"http://localhost:3000/api/auth/oidc/callback","version":"1","assuranceMappings":[]}]`}, message: "OIDC_PROVIDERS_JSON"},
		{name: "version not a string", changes: map[string]string{"OIDC_PROVIDERS_JSON": `[{"issuer":"https://idp.example.test","clientId":"c","redirectUri":"http://localhost:3000/api/auth/oidc/callback","version":1,"assuranceMappings":[]}]`}, message: "OIDC_PROVIDERS_JSON"},
		{name: "repeated issuer", changes: map[string]string{"OIDC_PROVIDERS_JSON": "[" + strings.Trim(provider("https://idp.example.test", "http://localhost:3000/api/auth/oidc/callback"), "[]") + "," + strings.Trim(provider("https://idp.example.test", "http://localhost:3000/api/auth/oidc/callback"), "[]") + "]"}, message: "OIDC_PROVIDERS_JSON"},
		{name: "missing key ring", removed: []string{"MFA_ENCRYPTION_KEYS"}, message: "MFA_ENCRYPTION_KEYS"},
		{name: "missing key id", removed: []string{"MFA_ENCRYPTION_KEY_ID"}, message: "MFA_ENCRYPTION_KEYS"},
		{name: "truncated key", changes: map[string]string{"MFA_ENCRYPTION_KEYS": "fixture:" + keyA[:42]}, message: "MFA_ENCRYPTION_KEYS"},
		{name: "current not in the ring", changes: map[string]string{"MFA_ENCRYPTION_KEY_ID": "other"}, message: "MFA_ENCRYPTION_KEYS"},
		{name: "port too large", changes: map[string]string{"PORT": "65536"}, message: "PORT"},
		{name: "port negative", changes: map[string]string{"PORT": "-1"}, message: "PORT"},
		{name: "port not a number", changes: map[string]string{"PORT": "abc"}, message: "PORT"},
		{name: "port with a fraction", changes: map[string]string{"PORT": "80.5"}, message: "PORT"},
		{name: "port with spaces", changes: map[string]string{"PORT": " 8080 "}, message: "PORT"},
		{name: "port in hex", changes: map[string]string{"PORT": "0x50"}, message: "PORT"},
		{name: "unknown log level", changes: map[string]string{"LOG_LEVEL": "verbose"}, message: "LOG_LEVEL"},
	}
	for _, value := range []string{"true", "-1", "10", "1.5", "loopback", "1\n"} {
		cases = append(cases, struct {
			name    string
			changes map[string]string
			removed []string
			message string
		}{name: "TRUST_PROXY " + value, changes: map[string]string{"TRUST_PROXY": value}, message: "TRUST_PROXY"})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := config.Load(withEnv(tc.changes, tc.removed...))
			var invalid *config.ConfigError
			if !errors.As(err, &invalid) {
				t.Fatalf("got %v, want ConfigError", err)
			}
			if !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("%q does not name %q", err, tc.message)
			}
		})
	}
}

func provider(issuer, redirect string) string {
	return fmt.Sprintf(`[{"issuer":%q,"clientId":"c","redirectUri":%q,"version":"1","assuranceMappings":[]}]`, issuer, redirect)
}

func TestLoadReportsEveryProblem(t *testing.T) {
	_, err := config.Load(map[string]string{"DATABASE_ADMIN_URL": "postgres://postgres:x@localhost/postgres"})
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, name := range []string{
		"NODE_ENV", "DATABASE_ADMIN_URL", "PRODUCT_DATA_DATABASE_URL", "PRODUCT_SYNC_DATABASE_URL",
		"APP_ORIGIN", "OIDC_PROVIDERS_JSON", "MFA_ENCRYPTION_KEYS",
	} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("%q does not name %s", err, name)
		}
	}
}

func TestLoadNeverEchoesSecrets(t *testing.T) {
	leaky := base64.StdEncoding.EncodeToString([]byte("do-not-print-this-key-material!!"))
	for name, env := range map[string]map[string]string{
		"wrong protocol":  withEnv(map[string]string{"PRODUCT_DATA_DATABASE_URL": "mysql://leaky_user:do-not-print-me@127.0.0.1/product"}),
		"bad escape":      withEnv(map[string]string{"PRODUCT_DATA_DATABASE_URL": "postgres://product_data:do-not-print-me%zz@127.0.0.1/product"}),
		"present offline": withEnv(map[string]string{"PRODUCT_BOOTSTRAP_DATABASE_URL": "do-not-print-me-either"}),
		"key truncated":   withEnv(map[string]string{"MFA_ENCRYPTION_KEYS": "fixture:" + leaky[:len(leaky)-2]}),
		"key not current": withEnv(map[string]string{"MFA_ENCRYPTION_KEYS": "other:" + leaky}),
		"key repeated":    withEnv(map[string]string{"MFA_ENCRYPTION_KEYS": "fixture:" + leaky + ",fixture:" + leaky}),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := config.Load(env)
			if err == nil {
				t.Fatal("expected an error")
			}
			for _, secret := range []string{"do-not-print-me", "leaky_user", leaky[:12]} {
				if strings.Contains(err.Error(), secret) {
					t.Fatalf("the error echoes %q", secret)
				}
			}
		})
	}
}

func TestConfigDoesNotPrintSecrets(t *testing.T) {
	loaded, err := config.Load(validEnv())
	if err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"%v", "%+v", "%#v", "%s"} {
		for _, value := range []any{loaded, &loaded, loaded.MfaKeys, loaded.Databases} {
			printed := fmt.Sprintf(format, value)
			if strings.Contains(printed, "synthetic") || strings.Contains(printed, keyA[:12]) {
				t.Fatalf("%s prints a secret", format)
			}
		}
	}
}

func TestLoadPort(t *testing.T) {
	for value, want := range map[string]int{
		"":      3000,
		"0":     0,
		"8080":  8080,
		"65535": 65535,
	} {
		t.Run(value, func(t *testing.T) {
			loaded, err := config.Load(withEnv(map[string]string{"PORT": value}))
			if err != nil {
				t.Fatal(err)
			}
			if loaded.Port != want {
				t.Fatalf("got %d, want %d", loaded.Port, want)
			}
		})
	}
}

func TestLoadOriginAndCallbackCompareAsOrigins(t *testing.T) {
	loaded, err := config.Load(withEnv(map[string]string{
		"NODE_ENV":            "production",
		"APP_ORIGIN":          "https://HRM.Example.test:443/",
		"OIDC_PROVIDERS_JSON": provider("https://idp.example.test", "https://hrm.example.test/api/auth/oidc/callback"),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Origin != "https://hrm.example.test" {
		t.Fatalf("origin %q", loaded.Origin)
	}
}

// The callback compares with the URI as written and the IdP matches redirect_uri exactly, so a URI that only
// normalizes to the origin would pass here and fail every sign-in.
func TestLoadRefusesACallbackNotWrittenLikeTheOrigin(t *testing.T) {
	const path = "/api/auth/oidc/callback"
	for _, redirect := range []string{
		"https://HRM.EXAMPLE.TEST" + path,
		"https://hrm.example.test:443" + path,
		"HTTPS://hrm.example.test" + path,
		"https://hrm.example.test" + path + "?x=1",
		"https://hrm.example.test" + path + "#x",
		"https://user@hrm.example.test" + path,
	} {
		_, err := config.Load(withEnv(map[string]string{
			"NODE_ENV":            "production",
			"APP_ORIGIN":          "https://hrm.example.test",
			"OIDC_PROVIDERS_JSON": provider("https://idp.example.test", redirect),
		}))
		if err == nil || !strings.Contains(err.Error(), "OIDC_PROVIDERS_JSON") {
			t.Errorf("%s: %v", redirect, err)
		}
	}
}

func TestLoadKeepsProviderFields(t *testing.T) {
	loaded, err := config.Load(withEnv(map[string]string{
		"OIDC_PROVIDERS_JSON": `[{"issuer":"https://idp.example.test","clientId":"c","clientSecret":"s","redirectUri":"http://localhost:3000/api/auth/oidc/callback","version":"7","assuranceMappings":[{"acr":"a","amr":["otp"],"assurance":"mfa"}],"ignored":true}]`,
	}))
	if err != nil {
		t.Fatal(err)
	}
	got := loaded.OidcProviders[0]
	if got.Issuer != "https://idp.example.test" || got.ClientSecret != "s" || got.RedirectURI != "http://localhost:3000/api/auth/oidc/callback" || got.Version != "7" {
		t.Fatalf("fields %+v", got.Issuer)
	}
	if len(got.AssuranceMappings) != 1 || got.AssuranceMappings[0].Acr != "a" || got.AssuranceMappings[0].Amr[0] != "otp" || got.AssuranceMappings[0].Assurance != "mfa" {
		t.Fatal("mappings are not kept")
	}
}

func TestParseMfaKeyRing(t *testing.T) {
	ring, err := config.ParseMfaKeyRing("k1:"+keyA+",k2:"+keyB, "k2")
	if err != nil {
		t.Fatal(err)
	}
	if ring.Current() != "k2" {
		t.Fatalf("current %q", ring.Current())
	}
	if ids := ring.IDs(); len(ids) != 2 || ids[0] != "k1" || ids[1] != "k2" {
		t.Fatalf("ids %v", ids)
	}
	key, ok := ring.Key("k1")
	if !ok || base64.StdEncoding.EncodeToString(key) != keyA {
		t.Fatal("k1 is not the first key")
	}
	key[0] ^= 0xff
	again, _ := ring.Key("k1")
	if base64.StdEncoding.EncodeToString(again) != keyA {
		t.Fatal("a caller changed the key held by the ring")
	}
	if _, ok := ring.Key("absent"); ok {
		t.Fatal("an unknown id has a key")
	}
}

func TestParseMfaKeyRingRejects(t *testing.T) {
	long := "k1:" + keyA
	for len(long) <= 4096 {
		long += ",k1:" + keyA
	}
	nonCanonical := keyA[:42] + "F="
	for name, input := range map[string][2]string{
		"no keys":             {"", "k1"},
		"no current":          {"k1:" + keyA, ""},
		"current absent":      {"k1:" + keyA, "k2"},
		"repeated id":         {"k1:" + keyA + ",k1:" + keyB, "k1"},
		"no separator":        {keyA, "k1"},
		"uppercase id":        {"K1:" + keyA, "K1"},
		"empty id":            {":" + keyA, ""},
		"id too long":         {strings.Repeat("a", 33) + ":" + keyA, strings.Repeat("a", 33)},
		"trailing comma":      {"k1:" + keyA + ",", "k1"},
		"short key":           {"k1:AQEB", "k1"},
		"url-safe alphabet":   {"k1:" + strings.ReplaceAll(keyA, "A", "-"), "k1"},
		"non-canonical key":   {"k1:" + nonCanonical, "k1"},
		"too long":            {long, "k1"},
		"too long by a space": {"k1:" + keyA + strings.Repeat(" ", 4097), "k1"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := config.ParseMfaKeyRing(input[0], input[1])
			var invalid *config.MfaKeyRingError
			if !errors.As(err, &invalid) {
				t.Fatalf("got %v, want MfaKeyRingError", err)
			}
			if strings.Contains(err.Error(), keyA[:8]) {
				t.Fatal("the error echoes key material")
			}
		})
	}
}
