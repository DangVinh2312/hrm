package authentication_test

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"maps"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"hrm/api/internal/authentication"
	"hrm/api/internal/config"
	"hrm/api/test"
)

const (
	idpClient   = "hrm-client"
	idpSecret   = "client-secret-fixture"
	idpRedirect = "https://app.fixture/api/auth/oidc/callback"
	idpKeyID    = "k1"

	idpDiscoveryPath = "/.well-known/openid-configuration"
)

// rawClaims holds raw JSON per member, so a test can drop a member ("") or give it any type.
type rawClaims map[string]string

func (c rawClaims) json() string {
	members := make([]string, 0, len(c))
	for _, key := range slices.Sorted(maps.Keys(c)) {
		if c[key] != "" {
			members = append(members, strconv.Quote(key)+":"+c[key])
		}
	}
	return "{" + strings.Join(members, ",") + "}"
}

type grant struct{ challenge, idToken string }

// idp is a local OIDC provider at test.FixtureIssuer over TLS: discovery, one RS256 key made for the test, and
// a token endpoint that checks the code once, PKCE S256, the client and the redirect URI.
type idp struct {
	t      *testing.T
	server *httptest.Server
	key    *rsa.PrivateKey
	mu     sync.Mutex
	codes  map[string]grant
	routes map[string]http.HandlerFunc
}

func newIDP(t *testing.T) *idp {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &idp{t: t, key: key, codes: map[string]grant{}, routes: map[string]http.HandlerFunc{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+idpDiscoveryPath, func(w http.ResponseWriter, _ *http.Request) {
		p.answer(w, http.StatusOK, idpMetadata())
	})
	mux.HandleFunc("GET /jwks", func(w http.ResponseWriter, _ *http.Request) { p.answer(w, http.StatusOK, p.keySet()) })
	mux.HandleFunc("POST /token", p.token)
	p.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		replaced := p.routes[r.URL.Path]
		p.mu.Unlock()
		if replaced != nil {
			replaced(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(p.server.Close)
	return p
}

func idpMetadata() rawClaims {
	return rawClaims{
		"issuer": strconv.Quote(test.FixtureIssuer), "authorization_endpoint": strconv.Quote(test.FixtureIssuer + "/authorize"),
		"token_endpoint": strconv.Quote(test.FixtureIssuer + "/token"), "jwks_uri": strconv.Quote(test.FixtureIssuer + "/jwks"),
	}
}

func (p *idp) keySet() rawClaims {
	n := base64.RawURLEncoding.EncodeToString(p.key.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(p.key.E)).Bytes())
	return rawClaims{"keys": `[{"kty":"RSA","use":"sig","alg":"RS256","kid":"` + idpKeyID + `","n":"` + n + `","e":"` + e + `"}]`}
}

// route replaces what the provider answers at a path.
func (p *idp) route(path string, handler http.HandlerFunc) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.routes[path] = handler
}

// publishing answers discovery with the given metadata members over the default ones.
func (p *idp) publishing(extra rawClaims) {
	metadata := idpMetadata()
	maps.Copy(metadata, extra)
	p.route(idpDiscoveryPath, func(w http.ResponseWriter, _ *http.Request) { p.answer(w, http.StatusOK, metadata) })
}

func (p *idp) answer(w http.ResponseWriter, status int, body rawClaims) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write([]byte(body.json())); err != nil {
		p.t.Error(err)
	}
}

func (p *idp) token(w http.ResponseWriter, r *http.Request) {
	if r.ParseForm() != nil {
		p.answer(w, http.StatusBadRequest, rawClaims{"error": `"invalid_request"`})
		return
	}
	p.mu.Lock()
	issued, ok := p.codes[r.PostForm.Get("code")]
	delete(p.codes, r.PostForm.Get("code"))
	p.mu.Unlock()
	verifier := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
	if !ok || r.PostForm.Get("grant_type") != "authorization_code" || r.PostForm.Get("client_id") != idpClient ||
		r.PostForm.Get("client_secret") != idpSecret || r.PostForm.Get("redirect_uri") != idpRedirect ||
		base64.RawURLEncoding.EncodeToString(verifier[:]) != issued.challenge {
		p.answer(w, http.StatusBadRequest, rawClaims{"error": `"invalid_grant"`})
		return
	}
	p.answer(w, http.StatusOK, rawClaims{
		"access_token": `"access"`, "token_type": `"Bearer"`, "expires_in": "300", "id_token": strconv.Quote(issued.idToken),
	})
}

// client reaches the server for test.FixtureIssuer and trusts only its certificate.
func (p *idp) client() *http.Client {
	transport := p.server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: transport.TLSClientConfig.RootCAs, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	address := p.server.Listener.Addr().String()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}
	return &http.Client{Transport: transport}
}

func (p *idp) settings() config.ProductOidcProviderConfig {
	return config.ProductOidcProviderConfig{
		Issuer: test.FixtureIssuer, ClientID: idpClient, ClientSecret: idpSecret, RedirectURI: idpRedirect, Version: "1",
		AssuranceMappings: []config.AssuranceMapping{{Acr: "loa2", Amr: []string{"pwd", "otp"}, Assurance: "mfa"}},
	}
}

func (p *idp) provider(t *testing.T) *authentication.OidcProvider {
	t.Helper()
	provider, err := authentication.NewOidcProvider(t.Context(), p.settings(), p.client())
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

func (p *idp) claims(subject, nonce string, now time.Time) rawClaims {
	return rawClaims{
		"iss": strconv.Quote(test.FixtureIssuer), "aud": strconv.Quote(idpClient), "sub": strconv.Quote(subject),
		"nonce": strconv.Quote(nonce), "iat": strconv.FormatInt(now.Unix(), 10), "exp": strconv.FormatInt(now.Add(5*time.Minute).Unix(), 10),
	}
}

func base64URL(text string) string { return base64.RawURLEncoding.EncodeToString([]byte(text)) }

// sign is an RS256 signature by the provider's key under the given header.
func (p *idp) sign(t *testing.T, header string, claims rawClaims) string {
	t.Helper()
	input := base64URL(header) + "." + base64URL(claims.json())
	digest := sha256.Sum256([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func (p *idp) idToken(t *testing.T, claims rawClaims) string {
	return p.sign(t, `{"alg":"RS256","kid":"`+idpKeyID+`","typ":"JWT"}`, claims)
}

// hs256 signs with HMAC over the public modulus, the classic confusion of an RS256 key.
func (p *idp) hs256(claims rawClaims) string {
	input := base64URL(`{"alg":"HS256","kid":"`+idpKeyID+`"}`) + "." + base64URL(claims.json())
	mac := hmac.New(sha256.New, p.key.N.Bytes())
	mac.Write([]byte(input))
	return input + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// authorize answers an authorization URL as the user would: the code carries the challenge of the URL and the
// ID token made from change applied over the default claims of subject and the URL's nonce.
func (p *idp) authorize(t *testing.T, authorization, subject string, change rawClaims) *url.URL {
	t.Helper()
	parsed, err := url.Parse(authorization)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	if parsed.Scheme+"://"+parsed.Host+parsed.Path != test.FixtureIssuer+"/authorize" || query.Get("response_type") != "code" ||
		query.Get("client_id") != idpClient || query.Get("redirect_uri") != idpRedirect || query.Get("scope") != "openid email profile" ||
		query.Get("code_challenge_method") != "S256" || query.Get("state") == "" || query.Get("nonce") == "" {
		t.Fatalf("authorization URL %s", parsed.Redacted())
	}
	claims := p.claims(subject, query.Get("nonce"), time.Now())
	maps.Copy(claims, change)
	code := rand.Text()
	p.mu.Lock()
	p.codes[code] = grant{challenge: query.Get("code_challenge"), idToken: p.idToken(t, claims)}
	p.mu.Unlock()
	callback, err := url.Parse(idpRedirect + "?code=" + url.QueryEscape(code) + "&state=" + url.QueryEscape(query.Get("state")))
	if err != nil {
		t.Fatal(err)
	}
	return callback
}
