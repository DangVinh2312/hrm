package config

import (
	"encoding/json"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

const (
	maxOidcProviders = 8
	oidcCallbackPath = "/api/auth/oidc/callback"
)

// AssuranceMapping is checked in full when the provider is created; here it only has to have the shape.
type AssuranceMapping struct {
	Acr       string
	Amr       []string
	Assurance string
}

type ProductOidcProviderConfig struct {
	Issuer            string
	ClientID          string
	ClientSecret      string
	RedirectURI       string
	Version           string
	AssuranceMappings []AssuranceMapping
}

func (ProductOidcProviderConfig) String() string { return "config.ProductOidcProviderConfig{redacted}" }

func (ProductOidcProviderConfig) GoString() string {
	return "config.ProductOidcProviderConfig{redacted}"
}

// parseOrigin gives the serialized origin of APP_ORIGIN, which is what a browser sends.
func parseOrigin(raw, nodeEnv string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.User != nil && parsed.User.String() != "" {
		return "", false
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", false
	}
	if parsed.Scheme != "https" && (parsed.Scheme != "http" || nodeEnv == "production") {
		return "", false
	}
	return originOf(parsed)
}

func originOf(parsed *url.URL) (string, bool) {
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return "", false
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" {
		return "", false
	}
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	origin := parsed.Scheme + "://" + hostname
	if parsed.Port() == "" {
		return origin, true
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port > 65535 {
		return "", false
	}
	if (parsed.Scheme == "https" && port == 443) || (parsed.Scheme == "http" && port == 80) {
		return origin, true
	}
	return origin + ":" + strconv.Itoa(port), true
}

func parseOidcProviders(raw, origin string) ([]ProductOidcProviderConfig, bool) {
	var items []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil, false
	}
	if len(items) == 0 || len(items) > maxOidcProviders {
		return nil, false
	}
	providers := make([]ProductOidcProviderConfig, 0, len(items))
	issuers := make([]string, 0, len(items))
	for _, item := range items {
		provider, ok := parseOidcProvider(item, origin)
		if !ok || slices.Contains(issuers, provider.Issuer) {
			return nil, false
		}
		providers = append(providers, provider)
		issuers = append(issuers, provider.Issuer)
	}
	return providers, true
}

func parseOidcProvider(item json.RawMessage, origin string) (ProductOidcProviderConfig, bool) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(item, &fields); err != nil || fields == nil {
		return ProductOidcProviderConfig{}, false
	}
	issuer, issuerOK := stringField(fields, "issuer")
	clientID, clientOK := stringField(fields, "clientId")
	redirect, redirectOK := stringField(fields, "redirectUri")
	version, versionOK := stringField(fields, "version")
	secret, secretOK := optionalStringField(fields, "clientSecret")
	mappings, mappingsOK := parseAssuranceMappings(fields["assuranceMappings"])
	if !issuerOK || !clientOK || !redirectOK || !versionOK || !secretOK || !mappingsOK {
		return ProductOidcProviderConfig{}, false
	}
	if !trustedIssuer(issuer) || !trustedCallback(redirect, origin) {
		return ProductOidcProviderConfig{}, false
	}
	return ProductOidcProviderConfig{
		Issuer:            issuer,
		ClientID:          clientID,
		ClientSecret:      secret,
		RedirectURI:       redirect,
		Version:           version,
		AssuranceMappings: mappings,
	}, true
}

func trustedIssuer(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return false
	}
	return (parsed.User == nil || parsed.User.String() == "") && parsed.RawQuery == "" && parsed.Fragment == ""
}

// trustedCallback takes the URI only as the serialized origin writes it: the callback route compares with it
// and the IdP matches redirect_uri exactly, so another spelling of the same origin would fail every sign-in.
func trustedCallback(raw, origin string) bool {
	return origin != "" && raw == origin+oidcCallbackPath
}

// stringField reads the exact key: encoding/json would match a struct field in any letter case.
func stringField(fields map[string]json.RawMessage, key string) (string, bool) {
	return jsonString(fields[key])
}

func optionalStringField(fields map[string]json.RawMessage, key string) (string, bool) {
	raw, present := fields[key]
	if !present || string(raw) == "null" {
		return "", true
	}
	return jsonString(raw)
}

func jsonString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func parseAssuranceMappings(raw json.RawMessage) ([]AssuranceMapping, bool) {
	if len(raw) == 0 || raw[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, false
	}
	mappings := make([]AssuranceMapping, 0, len(items))
	for _, item := range items {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(item, &fields); err != nil || fields == nil {
			return nil, false
		}
		acr, acrOK := stringField(fields, "acr")
		assurance, assuranceOK := stringField(fields, "assurance")
		amr, amrOK := parseStrings(fields["amr"])
		if !acrOK || !assuranceOK || !amrOK {
			return nil, false
		}
		mappings = append(mappings, AssuranceMapping{Acr: acr, Amr: amr, Assurance: assurance})
	}
	return mappings, true
}

func parseStrings(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 || raw[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, false
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		value, ok := jsonString(item)
		if !ok {
			return nil, false
		}
		values = append(values, value)
	}
	return values, true
}
