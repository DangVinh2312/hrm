package authentication_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"

	"hrm/api/internal/apperror"
	"hrm/api/internal/authentication"
	"hrm/api/internal/config"
	"hrm/api/test"
)

func TestProviderSettingsAreCheckedBeforeDiscovery(t *testing.T) {
	p := newIDP(t)
	cases := map[string]func(*config.ProductOidcProviderConfig){
		"http issuer":              func(s *config.ProductOidcProviderConfig) { s.Issuer = "http://idp.fixture" },
		"issuer with a query":      func(s *config.ProductOidcProviderConfig) { s.Issuer += "?a=1" },
		"issuer with a fragment":   func(s *config.ProductOidcProviderConfig) { s.Issuer += "#a" },
		"issuer with a user":       func(s *config.ProductOidcProviderConfig) { s.Issuer = "https://u@idp.fixture" },
		"issuer with a slash":      func(s *config.ProductOidcProviderConfig) { s.Issuer += "/" },
		"http redirect":            func(s *config.ProductOidcProviderConfig) { s.RedirectURI = "http://app.fixture/cb" },
		"no client":                func(s *config.ProductOidcProviderConfig) { s.ClientID = "" },
		"client of 257":            func(s *config.ProductOidcProviderConfig) { s.ClientID = strings.Repeat("c", 257) },
		"version zero":             func(s *config.ProductOidcProviderConfig) { s.Version = "0" },
		"version with a zero lead": func(s *config.ProductOidcProviderConfig) { s.Version = "01" },
		"version of 19 digits":     func(s *config.ProductOidcProviderConfig) { s.Version = strings.Repeat("9", 19) },
		"mapping without acr":      func(s *config.ProductOidcProviderConfig) { s.AssuranceMappings[0].Acr = "" },
		"mapping without amr":      func(s *config.ProductOidcProviderConfig) { s.AssuranceMappings[0].Amr = nil },
		"mapping with an empty amr": func(s *config.ProductOidcProviderConfig) {
			s.AssuranceMappings[0].Amr = []string{"pwd", ""}
		},
		"mapping to oidc": func(s *config.ProductOidcProviderConfig) { s.AssuranceMappings[0].Assurance = "oidc" },
	}
	for name, change := range cases {
		settings := p.settings()
		change(&settings)
		if _, err := authentication.NewOidcProvider(t.Context(), settings, p.client()); !errors.Is(err, authentication.ErrOidcConfiguration) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, change := range map[string]func(*config.ProductOidcProviderConfig){
		"loopback redirect": func(s *config.ProductOidcProviderConfig) {
			s.RedirectURI = "http://localhost:5173/api/auth/oidc/callback"
		},
		"public client": func(s *config.ProductOidcProviderConfig) { s.ClientSecret = "" },
		"client of 256": func(s *config.ProductOidcProviderConfig) { s.ClientID = strings.Repeat("c", 256) },
		"no mapping":    func(s *config.ProductOidcProviderConfig) { s.AssuranceMappings = nil },
	} {
		settings := p.settings()
		change(&settings)
		if _, err := authentication.NewOidcProvider(t.Context(), settings, p.client()); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := authentication.NewOidcProvider(t.Context(), p.settings(), nil); !errors.Is(err, authentication.ErrOidcConfiguration) {
		t.Errorf("no client: %v", err)
	}
}

func TestDiscoveryOfAnotherIssuerIsRefused(t *testing.T) {
	p := newIDP(t)
	settings := p.settings()
	settings.Issuer = "https://other.fixture"
	if _, err := authentication.NewOidcProvider(t.Context(), settings, p.client()); !errors.Is(err, authentication.ErrOidcConfiguration) {
		t.Errorf("%v", err)
	}
}

func TestIDTokensThatFailAuthentication(t *testing.T) {
	p := newIDP(t)
	provider := p.provider(t)
	now := time.Now()
	base := func(change rawClaims) rawClaims {
		claims := p.claims("subject-1", "nonce-1", now)
		for key, value := range change {
			claims[key] = value
		}
		return claims
	}
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	forged := &idp{key: other}
	cases := map[string]string{
		"wrong iss":                 p.idToken(t, base(rawClaims{"iss": `"https://other.fixture"`})),
		"wrong aud":                 p.idToken(t, base(rawClaims{"aud": `"other-client"`})),
		"several aud without azp":   p.idToken(t, base(rawClaims{"aud": `["hrm-client","other-client"]`})),
		"several aud, wrong azp":    p.idToken(t, base(rawClaims{"aud": `["hrm-client","other-client"]`, "azp": `"other-client"`})),
		"wrong nonce":               p.idToken(t, base(rawClaims{"nonce": `"nonce-2"`})),
		"no iat":                    p.idToken(t, base(rawClaims{"iat": ""})),
		"iat a string":              p.idToken(t, base(rawClaims{"iat": `"x"`})),
		"iat null":                  p.idToken(t, base(rawClaims{"iat": `null`})),
		"nbf past the window":       p.idToken(t, base(rawClaims{"nbf": strconv.FormatInt(now.Unix()+31, 10)})),
		"expired":                   p.idToken(t, base(rawClaims{"exp": strconv.FormatInt(now.Unix()-30, 10)})),
		"no exp":                    p.idToken(t, base(rawClaims{"exp": ""})),
		"bad signature":             forged.idToken(t, base(nil)),
		"HS256":                     p.hs256(base(nil)),
		"alg none":                  noneToken(base(nil)),
		"RS512 in the header":       p.sign(t, `{"alg":"RS512","kid":"k1"}`, base(nil)),
		"RS512 by the IdP key":      p.rs512(t, base(nil)),
		"unknown critical header":   p.sign(t, `{"alg":"RS256","kid":"k1","crit":["x"],"x":1}`, base(nil)),
		"empty sub":                 p.idToken(t, base(rawClaims{"sub": `""`})),
		"sub of 513":                p.idToken(t, base(rawClaims{"sub": strconv.Quote(strings.Repeat("s", 513))})),
		"auth_time with a fraction": p.idToken(t, base(rawClaims{"auth_time": `1.5`})),
		"not a JWS":                 "a.b",
	}
	for name, raw := range cases {
		if _, err := authentication.VerifyIDToken(t.Context(), provider, raw, "nonce-1", now); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%s: %v", name, err)
		}
	}
	got, err := authentication.VerifyIDToken(t.Context(), provider, p.idToken(t, base(rawClaims{
		"sub": strconv.Quote(strings.Repeat("s", 512)), "email": `"Ann@Example.Test"`, "email_verified": `"true"`,
		"acr": `"loa2"`, "amr": `["otp","pwd"]`, "auth_time": "1700000000",
	})), "nonce-1", now)
	if err != nil || got.Email != nil || got.Assurance != "mfa" || got.AuthTime == nil || *got.AuthTime != 1_700_000_000 {
		t.Errorf("valid token: %+v %v", got, err)
	}
	got, err = authentication.VerifyIDToken(t.Context(), provider, p.idToken(t, base(rawClaims{
		"email": `"Ann@Example.Test"`, "email_verified": `true`,
	})), "nonce-1", now)
	if err != nil || got.Email == nil || *got.Email != "ann@example.test" || got.Assurance != "oidc" || got.AuthTime != nil {
		t.Errorf("verified email: %+v %v", got, err)
	}
	got, err = authentication.VerifyIDToken(t.Context(), provider, p.idToken(t, base(rawClaims{
		"email": `"Ann@Example.Test"`, "EMAIL_VERIFIED": `true`,
	})), "nonce-1", now)
	if err != nil || got.Email != nil {
		t.Errorf("a verification claim in capitals: %+v %v", got, err)
	}
}

// paddedJSON is the document of members with a padding member, exactly size bytes long.
func paddedJSON(t *testing.T, members rawClaims, size int) string {
	t.Helper()
	empty := maps.Clone(members)
	empty["padding"] = `""`
	room := size - len(empty.json())
	if room < 0 {
		t.Fatalf("%d bytes do not fit the members", size)
	}
	empty["padding"] = strconv.Quote(strings.Repeat("x", room))
	return empty.json()
}

func writeBody(t *testing.T, w http.ResponseWriter, body string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write([]byte(body)); err != nil {
		t.Error(err)
	}
}

// A member in capitals after the exact one is what encoding/json v1 would keep.
func TestTheEndpointsOfDiscoveryAreReadByTheirExactNames(t *testing.T) {
	const elsewhere = "https://elsewhere.fixture/stolen"
	p := newIDP(t)
	document := idpMetadata().json()
	body := document[:len(document)-1] + `,"AUTHORIZATION_ENDPOINT":"` + elsewhere + `","TOKEN_ENDPOINT":"` + elsewhere + `"}`
	p.route(idpDiscoveryPath, func(w http.ResponseWriter, _ *http.Request) { writeBody(t, w, body) })
	var tokenAt atomic.Value
	p.route("/token", func(w http.ResponseWriter, r *http.Request) {
		tokenAt.Store(r.Host + r.URL.Path)
		p.answer(w, http.StatusBadRequest, rawClaims{"error": `"invalid_grant"`})
	})
	p.route("/stolen", func(w http.ResponseWriter, r *http.Request) {
		tokenAt.Store(r.Host + r.URL.Path)
		p.answer(w, http.StatusBadRequest, rawClaims{"error": `"invalid_grant"`})
	})
	provider, err := authentication.NewOidcProvider(t.Context(), p.settings(), p.client())
	if err != nil {
		t.Fatal(err)
	}
	if got := authentication.AuthorizationURL(provider, "state-1", "nonce-1", oauth2.GenerateVerifier()); !strings.HasPrefix(got, test.FixtureIssuer+"/authorize?") {
		t.Errorf("authorization at %s", strings.SplitN(got, "?", 2)[0])
	}
	if _, err := authentication.ExchangeCode(t.Context(), provider, "any-code", "any-verifier", "nonce-1", time.Now()); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("%v", err)
	}
	if got := tokenAt.Load(); got != strings.TrimPrefix(test.FixtureIssuer, "https://")+"/token" {
		t.Errorf("token at %v", got)
	}
}

func TestDiscoveryWithoutAUsableEndpointIsRefused(t *testing.T) {
	cases := map[string]rawClaims{
		"no authorization endpoint":          {"authorization_endpoint": ""},
		"no token endpoint":                  {"token_endpoint": ""},
		"authorization endpoint in capitals": {"authorization_endpoint": "", "AUTHORIZATION_ENDPOINT": strconv.Quote(test.FixtureIssuer + "/authorize")},
		"token endpoint in capitals":         {"token_endpoint": "", "TOKEN_ENDPOINT": strconv.Quote(test.FixtureIssuer + "/token")},
		"authorization endpoint over HTTP":   {"authorization_endpoint": `"http://idp.fixture/authorize"`},
		"token endpoint over HTTP":           {"token_endpoint": `"http://idp.fixture/token"`},
	}
	for name, change := range cases {
		p := newIDP(t)
		p.publishing(change)
		if _, err := authentication.NewOidcProvider(t.Context(), p.settings(), p.client()); !errors.Is(err, authentication.ErrOidcConfiguration) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestDiscoveryAnswersAreBoundedAtOneMebibyte(t *testing.T) {
	p := newIDP(t)
	serve := func(size int) {
		body := paddedJSON(t, idpMetadata(), size)
		p.route(idpDiscoveryPath, func(w http.ResponseWriter, _ *http.Request) { writeBody(t, w, body) })
	}
	serve(authentication.MaxProviderBody)
	if _, err := authentication.NewOidcProvider(t.Context(), p.settings(), p.client()); err != nil {
		t.Errorf("at the limit: %v", err)
	}
	serve(authentication.MaxProviderBody + 1)
	if _, err := authentication.NewOidcProvider(t.Context(), p.settings(), p.client()); !errors.Is(err, authentication.ErrOidcConfiguration) {
		t.Errorf("past the limit: %v", err)
	}
}

func TestKeyAnswersAreBoundedAtOneMebibyte(t *testing.T) {
	p := newIDP(t)
	provider := p.provider(t)
	now := time.Now()
	raw := p.idToken(t, p.claims("subject-1", "nonce-1", now))
	serve := func(size int) {
		body := paddedJSON(t, p.keySet(), size)
		p.route("/jwks", func(w http.ResponseWriter, _ *http.Request) { writeBody(t, w, body) })
	}
	serve(authentication.MaxProviderBody + 1)
	if _, err := authentication.VerifyIDToken(t.Context(), provider, raw, "nonce-1", now); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("past the limit: %v", err)
	}
	serve(authentication.MaxProviderBody)
	if _, err := authentication.VerifyIDToken(t.Context(), provider, raw, "nonce-1", now); err != nil {
		t.Errorf("at the limit: %v", err)
	}
}

func TestATokenAnswerPastTheLimitFailsAuthentication(t *testing.T) {
	p := newIDP(t)
	provider := p.provider(t)
	verifier := oauth2.GenerateVerifier()
	code := p.authorize(t, authentication.AuthorizationURL(provider, "state-1", "nonce-1", verifier), "subject-1", nil).Query().Get("code")
	body := paddedJSON(t, rawClaims{"access_token": `"access"`, "token_type": `"Bearer"`}, authentication.MaxProviderBody+1)
	p.route("/token", func(w http.ResponseWriter, _ *http.Request) { writeBody(t, w, body) })
	if _, err := authentication.ExchangeCode(t.Context(), provider, code, verifier, "nonce-1", time.Now()); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("%v", err)
	}
}

func TestTheProviderClientFollowsNoRedirect(t *testing.T) {
	p := newIDP(t)
	var followed atomic.Int32
	moved := func(target string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target, http.StatusFound) }
	}
	p.route("/moved-discovery", func(w http.ResponseWriter, _ *http.Request) {
		followed.Add(1)
		p.answer(w, http.StatusOK, idpMetadata())
	})
	provider := p.provider(t)
	p.route(idpDiscoveryPath, moved("/moved-discovery"))
	if _, err := authentication.NewOidcProvider(t.Context(), p.settings(), p.client()); !errors.Is(err, authentication.ErrOidcConfiguration) {
		t.Errorf("discovery: %v", err)
	}
	now := time.Now()
	p.route("/moved-keys", func(w http.ResponseWriter, _ *http.Request) {
		followed.Add(1)
		p.answer(w, http.StatusOK, p.keySet())
	})
	p.route("/jwks", moved("/moved-keys"))
	raw := p.idToken(t, p.claims("subject-1", "nonce-1", now))
	if _, err := authentication.VerifyIDToken(t.Context(), provider, raw, "nonce-1", now); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("keys: %v", err)
	}
	p.route("/moved-token", func(w http.ResponseWriter, _ *http.Request) {
		followed.Add(1)
		p.answer(w, http.StatusOK, rawClaims{"access_token": `"access"`, "token_type": `"Bearer"`, "id_token": strconv.Quote(raw)})
	})
	p.route("/token", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/moved-token", http.StatusTemporaryRedirect)
	})
	if _, err := authentication.ExchangeCode(t.Context(), provider, "any-code", "any-verifier", "nonce-1", now); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("token: %v", err)
	}
	if n := followed.Load(); n != 0 {
		t.Errorf("%d redirects followed", n)
	}
}

// hang never answers. net/http notices the client going away only after the request body was read, and
// httptest.Server.Close waits for this handler.
func hang(_ http.ResponseWriter, r *http.Request) {
	if _, err := io.Copy(io.Discard, r.Body); err == nil {
		<-r.Context().Done()
	}
}

// inTime fails unless call took about the provider timeout. The context of the call is far longer, so only
// the client's own timeout ends a hung answer in that time.
func inTime(t *testing.T, call func(ctx context.Context) error, want error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 4*authentication.ProviderTimeout)
	defer cancel()
	start := time.Now()
	err := call(ctx)
	elapsed := time.Since(start)
	if !errors.Is(err, want) {
		t.Errorf("%v", err)
	}
	if elapsed < authentication.ProviderTimeout-time.Second || elapsed >= 3*authentication.ProviderTimeout {
		t.Errorf("answered after %v", elapsed)
	}
}

func TestAHungDiscoveryEndsAtTheProviderTimeout(t *testing.T) {
	t.Parallel()
	p := newIDP(t)
	p.route(idpDiscoveryPath, hang)
	inTime(t, func(ctx context.Context) error {
		_, err := authentication.NewOidcProvider(ctx, p.settings(), p.client())
		return err
	}, authentication.ErrOidcConfiguration)
}

func TestHungKeysEndAtTheProviderTimeout(t *testing.T) {
	t.Parallel()
	p := newIDP(t)
	provider := p.provider(t)
	p.route("/jwks", hang)
	now := time.Now()
	raw := p.idToken(t, p.claims("subject-1", "nonce-1", now))
	inTime(t, func(ctx context.Context) error {
		_, err := authentication.VerifyIDToken(ctx, provider, raw, "nonce-1", now)
		return err
	}, apperror.ErrAuthenticationFailed)
}

func TestAHungTokenEndpointEndsAtTheProviderTimeout(t *testing.T) {
	t.Parallel()
	p := newIDP(t)
	provider := p.provider(t)
	p.route("/token", hang)
	inTime(t, func(ctx context.Context) error {
		_, err := authentication.ExchangeCode(ctx, provider, "any-code", "any-verifier", "nonce-1", time.Now())
		return err
	}, apperror.ErrAuthenticationFailed)
}

func TestDiscoveryMetadataIsReadExactly(t *testing.T) {
	const flag = "authorization_response_iss_parameter_supported"
	cases := map[string]struct {
		extra    rawClaims
		required bool
		refused  bool
	}{
		"absent":        {rawClaims{}, false, false},
		"published":     {rawClaims{flag: "true"}, true, false},
		"false":         {rawClaims{flag: "false"}, false, false},
		"null":          {rawClaims{flag: "null"}, false, false},
		"in capitals":   {rawClaims{strings.ToUpper(flag): "true"}, false, false},
		"not a boolean": {rawClaims{flag: `"true"`}, false, true},
	}
	for name, c := range cases {
		p := newIDP(t)
		p.publishing(c.extra)
		provider, err := authentication.NewOidcProvider(t.Context(), p.settings(), p.client())
		if c.refused {
			if !errors.Is(err, authentication.ErrOidcConfiguration) {
				t.Errorf("%s: %v", name, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if got := authentication.RequiresIssuerParameter(provider); got != c.required {
			t.Errorf("%s: required %v", name, got)
		}
	}
}

func noneToken(claims rawClaims) string {
	return base64URL(`{"alg":"none"}`) + "." + base64URL(claims.json()) + "."
}

// rs512 is a valid RS512 signature by the IdP's own key: only the RS256 pin refuses it.
func (p *idp) rs512(t *testing.T, claims rawClaims) string {
	t.Helper()
	input := base64URL(`{"alg":"RS512","kid":"`+idpKeyID+`"}`) + "." + base64URL(claims.json())
	digest := sha512.Sum512([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA512, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
}

// The challenge was computed once by openid-client 6.8.8 calculatePKCECodeChallenge (apps/api).
func TestTheAuthorizationURLCarriesTheParametersOfTheTypeScriptOne(t *testing.T) {
	p := newIDP(t)
	raw := authentication.AuthorizationURL(p.provider(t), "state-1", "nonce-1", "dBjftJeZ4CVP-mJ0kZlIS8tQ4C-ABQ2xBYBk-ULr2Vs")
	parsed, err := url.Parse(raw)
	if err != nil || !strings.HasPrefix(raw, test.FixtureIssuer+"/authorize?") {
		t.Fatalf("%s %v", raw, err)
	}
	want := url.Values{
		"client_id": {idpClient}, "redirect_uri": {idpRedirect},
		"response_type": {"code"}, "scope": {"openid email profile"}, "state": {"state-1"}, "nonce": {"nonce-1"},
		"code_challenge": {"xYJz9Q1YXPJ9pasegw5Nh8h2nfwcFRJUdUTRj_VMv90"}, "code_challenge_method": {"S256"},
	}
	if got := parsed.Query(); !reflect.DeepEqual(got, want) {
		t.Errorf("%v", got)
	}
}

func TestTheCodeIsRedeemedOnceWithItsVerifier(t *testing.T) {
	p := newIDP(t)
	provider := p.provider(t)
	verifier := oauth2.GenerateVerifier()
	authorization := authentication.AuthorizationURL(provider, "state-1", "nonce-1", verifier)
	code := p.authorize(t, authorization, "subject-1", nil).Query().Get("code")
	if _, err := authentication.ExchangeCode(t.Context(), provider, code, oauth2.GenerateVerifier(), "nonce-1", time.Now()); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("wrong PKCE verifier: %v", err)
	}
	code = p.authorize(t, authorization, "subject-1", nil).Query().Get("code")
	got, err := authentication.ExchangeCode(t.Context(), provider, code, verifier, "nonce-1", time.Now())
	if err != nil || got.Subject != "subject-1" {
		t.Errorf("right verifier: %+v %v", got, err)
	}
	if _, err := authentication.ExchangeCode(t.Context(), provider, code, verifier, "nonce-1", time.Now()); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("code reused: %v", err)
	}
	settings := p.settings()
	settings.ClientSecret = "another-secret"
	wrongClient, err := authentication.NewOidcProvider(t.Context(), settings, p.client())
	if err != nil {
		t.Fatal(err)
	}
	code = p.authorize(t, authorization, "subject-1", nil).Query().Get("code")
	if _, err := authentication.ExchangeCode(t.Context(), wrongClient, code, verifier, "nonce-1", time.Now()); !errors.Is(err, apperror.ErrAuthenticationFailed) {
		t.Errorf("wrong client secret: %v", err)
	}
}
