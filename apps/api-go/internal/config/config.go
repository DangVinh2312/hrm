package config

import (
	"regexp"
	"strconv"
	"strings"
)

// Config is the validated environment of the API process. It holds credentials and keys: String and
// GoString redact them so a stray format verb cannot print them.
type Config struct {
	NodeEnv       string
	Port          int
	TrustProxy    int
	LogLevels     []string
	Databases     DatabaseURLs
	Origin        string
	OidcProviders []ProductOidcProviderConfig
	MfaKeys       MfaKeyRing
	// UpstreamURL is API_UPSTREAM_URL as given; only internal/app knows whether it is required, and
	// httpapi.NewUpstream validates it.
	UpstreamURL string
}

func (Config) String() string { return "config.Config{redacted}" }

func (Config) GoString() string { return "config.Config{redacted}" }

// DatabaseURLs holds one URL for each login of the API. There is no field for the migration, bootstrap
// or admin credential because the API process must not hold them.
type DatabaseURLs struct {
	Data      string
	Identity  string
	Authority string
	Sync      string
}

func (DatabaseURLs) String() string { return "config.DatabaseURLs{redacted}" }

func (DatabaseURLs) GoString() string { return "config.DatabaseURLs{redacted}" }

// ConfigError names the invalid variables, never their values.
type ConfigError struct {
	problems []string
}

func (e *ConfigError) Error() string {
	return "Invalid configuration: " + strings.Join(e.problems, "; ")
}

var (
	logLevels = map[string][]string{
		"error": {"fatal", "error"},
		"warn":  {"fatal", "error", "warn"},
		"info":  {"fatal", "error", "warn", "log"},
		"debug": {"fatal", "error", "warn", "log", "debug"},
	}
	trustProxyPattern = regexp.MustCompile(`^[0-9]$`)
)

// Load fails on every invalid variable at once, so one failed boot shows all of them.
func Load(env map[string]string) (Config, error) {
	var problems []string
	report := func(problem string) { problems = append(problems, problem) }

	nodeEnv := env["NODE_ENV"]
	if nodeEnv != "development" && nodeEnv != "test" && nodeEnv != "production" {
		report("NODE_ENV must be development, test or production")
	}
	port, portOK := parsePort(valueOr(env, "PORT", "3000"))
	if !portOK {
		report("PORT must be 0–65535")
	}
	trustProxyValue := valueOr(env, "TRUST_PROXY", "0")
	trustProxy := 0
	if trustProxyPattern.MatchString(trustProxyValue) {
		trustProxy = int(trustProxyValue[0] - '0')
	} else {
		report("TRUST_PROXY must be a proxy hop count 0–9")
	}
	levels, levelsOK := logLevels[valueOr(env, "LOG_LEVEL", "info")]
	if !levelsOK {
		report("LOG_LEVEL is invalid")
	}
	for _, key := range []string{"DATABASE_ADMIN_URL", "PRODUCT_MIGRATION_DATABASE_URL", "PRODUCT_BOOTSTRAP_DATABASE_URL"} {
		if env[key] != "" {
			report(key + " must not be present in the API process")
		}
	}
	databases, databaseProblems := loadDatabases(env)
	problems = append(problems, databaseProblems...)
	origin, originOK := parseOrigin(env["APP_ORIGIN"], nodeEnv)
	if !originOK {
		report("APP_ORIGIN must be a fixed HTTPS origin (HTTP only outside production)")
	}
	if _, present := env["AUTH_METHODS"]; present {
		report("AUTH_METHODS is no longer supported: remove it (sign-in is Google OIDC only)")
	}
	providers, providersOK := parseOidcProviders(env["OIDC_PROVIDERS_JSON"], origin)
	if !providersOK {
		report("OIDC_PROVIDERS_JSON must contain valid trusted provider configuration")
	}
	keys, keysErr := ParseMfaKeyRing(env["MFA_ENCRYPTION_KEYS"], env["MFA_ENCRYPTION_KEY_ID"])
	if keysErr != nil {
		report(keysErr.Error())
	}
	if len(problems) > 0 {
		return Config{}, &ConfigError{problems: problems}
	}
	return Config{
		NodeEnv:       nodeEnv,
		Port:          port,
		TrustProxy:    trustProxy,
		LogLevels:     levels,
		Databases:     databases,
		Origin:        origin,
		OidcProviders: providers,
		MfaKeys:       keys,
		UpstreamURL:   env["API_UPSTREAM_URL"],
	}, nil
}

func valueOr(env map[string]string, key, fallback string) string {
	if value := env[key]; value != "" {
		return value
	}
	return fallback
}

func parsePort(value string) (int, bool) {
	port, err := strconv.Atoi(value)
	return port, err == nil && port >= 0 && port <= 65535
}
