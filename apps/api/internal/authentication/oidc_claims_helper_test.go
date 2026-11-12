package authentication

import (
	"errors"
	"maps"
	"slices"
	"strconv"
	"strings"
	"testing"

	"hrm/api/internal/apperror"
	"hrm/api/internal/config"
)

const (
	claimsNow    = 1_800_000_000
	claimsIssuer = "https://idp.example.test"
	claimsClient = "client-1"
)

var claimsRules = claimRules{
	issuer: claimsIssuer, clientID: claimsClient, nonce: "nonce-1",
	mappings: []config.AssuranceMapping{{Acr: "loa2", Amr: []string{"pwd", "otp"}, Assurance: "mfa"}},
}

// claims holds raw JSON per member, so a test can drop a member or give it any type.
type claims map[string]string

func baseClaims() claims {
	return claims{
		"iss": strconv.Quote(claimsIssuer), "sub": `"subject-1"`, "aud": strconv.Quote(claimsClient),
		"nonce": `"nonce-1"`, "iat": strconv.Itoa(claimsNow), "exp": strconv.Itoa(claimsNow + 600),
	}
}

func (c claims) with(changes claims) claims {
	merged := maps.Clone(c)
	for key, value := range changes {
		if value == "" {
			delete(merged, key)
		} else {
			merged[key] = value
		}
	}
	return merged
}

func (c claims) payload() []byte {
	members := make([]string, 0, len(c))
	for _, key := range slices.Sorted(maps.Keys(c)) {
		members = append(members, strconv.Quote(key)+":"+c[key])
	}
	return []byte("{" + strings.Join(members, ",") + "}")
}

func check(c claims) (VerifiedClaims, error) {
	return checkIDTokenClaims(c.payload(), claimsRules, claimsNow)
}

func TestIDTokenClaimsThatFailAuthentication(t *testing.T) {
	long := strconv.Quote(strings.Repeat(string(rune(0x10000)), 513))
	cases := map[string]claims{
		"another issuer":            {"iss": `"https://other.example.test"`},
		"issuer without scheme":     {"iss": `"idp.example.test"`},
		"issuer not a string":       {"iss": `["https://idp.example.test"]`},
		"no issuer":                 {"iss": ""},
		"another audience":          {"aud": `"client-2"`},
		"audience not listed":       {"aud": `["client-2"]`},
		"audience a number":         {"aud": `1`},
		"no audience":               {"aud": ""},
		"audiences without azp":     {"aud": `["client-1","client-2"]`},
		"audiences with other azp":  {"aud": `["client-1","client-2"]`, "azp": `"client-2"`},
		"audiences with azp null":   {"aud": `["client-1","client-2"]`, "azp": `null`},
		"another nonce":             {"nonce": `"nonce-2"`},
		"no nonce":                  {"nonce": ""},
		"nonce not a string":        {"nonce": `1`},
		"no iat":                    {"iat": ""},
		"iat a string":              {"iat": `"1800000000"`},
		"iat null":                  {"iat": `null`},
		"nbf past the tolerance":    {"nbf": strconv.Itoa(claimsNow + 31)},
		"nbf a string":              {"nbf": `"0"`},
		"nbf null":                  {"nbf": `null`},
		"no exp":                    {"exp": ""},
		"exp at the tolerance":      {"exp": strconv.Itoa(claimsNow - 30)},
		"exp a string":              {"exp": `"1800000600"`},
		"exp null":                  {"exp": `null`},
		"empty subject":             {"sub": `""`},
		"subject over 512":          {"sub": long},
		"subject not a string":      {"sub": `1`},
		"no subject":                {"sub": ""},
		"auth_time negative":        {"auth_time": `-1`},
		"auth_time past year 9999":  {"auth_time": `253402300800`},
		"auth_time with a fraction": {"auth_time": `1.5`},
		"auth_time a string":        {"auth_time": `"1"`},
		"auth_time null":            {"auth_time": `null`},
		"sub only in capitals":      {"sub": "", "SUB": `"subject-1"`},
		"nonce only in capitals":    {"nonce": "", "NONCE": `"nonce-1"`},
		"iat only in capitals":      {"iat": "", "IAT": strconv.Itoa(claimsNow)},
		"Exp in mixed case":         {"exp": "", "Exp": strconv.Itoa(claimsNow + 600)},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := check(baseClaims().with(change)); !errors.Is(err, apperror.ErrAuthenticationFailed) {
				t.Errorf("got %v", err)
			}
		})
	}
	for name, payload := range map[string]string{"not an object": `[]`, "not JSON": `{`, "empty": ``} {
		if _, err := checkIDTokenClaims([]byte(payload), claimsRules, claimsNow); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

// payloadWith is the base payload with raw members after the base ones, in the given order.
func payloadWith(members string) []byte {
	base := baseClaims().payload()
	return []byte(string(base[:len(base)-1]) + "," + members + "}")
}

func TestClaimNamesMatchExactly(t *testing.T) {
	const verifiedEmailMembers = `"email":"ann@example.test","email_verified":true`
	cases := map[string]struct {
		members, subject, email string
	}{
		"later EMAIL_VERIFIED":  {`"email":"ann@example.test","email_verified":false,"EMAIL_VERIFIED":true`, "subject-1", ""},
		"only Email_Verified":   {`"email":"ann@example.test","Email_Verified":true`, "subject-1", ""},
		"only EMAIL":            {`"EMAIL":"ann@example.test","email_verified":true`, "subject-1", ""},
		"later SUB":             {`"SUB":"subject-2"`, "subject-1", ""},
		"exact names":           {verifiedEmailMembers, "subject-1", "ann@example.test"},
		"space around a member": {`"email" : "ann@example.test" , "email_verified" : true `, "subject-1", "ann@example.test"},
	}
	for name, c := range cases {
		got, err := checkIDTokenClaims(payloadWith(c.members), claimsRules, claimsNow)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if got.Subject != c.subject || (got.Email == nil) != (c.email == "") || (got.Email != nil && *got.Email != c.email) {
			t.Errorf("%s: subject %q, email %v", name, got.Subject, got.Email)
		}
	}
}

func TestARepeatedClaimOrABrokenStringFailsAuthentication(t *testing.T) {
	cases := map[string]string{
		"sub twice":               `"sub":"subject-2"`,
		"iss twice":               `"iss":"https://idp.example.test"`,
		"email_verified twice":    `"email_verified":false,"email_verified":true`,
		"an unread member twice":  `"custom":1,"custom":2`,
		"sub again by an escape":  `"s` + "\\" + `u0075b":"subject-2"`,
		"a lone surrogate":        `"custom":"` + "\\" + `ud800"`,
		"invalid UTF-8":           `"custom":"` + string([]byte{0xff}) + `"`,
		"a repeat inside a value": `"custom":{"a":1,"a":2}`,
	}
	for name, members := range cases {
		if _, err := checkIDTokenClaims(payloadWith(members), claimsRules, claimsNow); !errors.Is(err, apperror.ErrAuthenticationFailed) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}

func TestIDTokenClaimsAtTheEdgesPass(t *testing.T) {
	cases := map[string]claims{
		"base":                      {},
		"one audience in an array":  {"aud": `["client-1"]`},
		"audiences with our azp":    {"aud": `["client-1","client-2"]`, "azp": `"client-1"`},
		"single audience other azp": {"azp": `"client-2"`},
		"nbf at the tolerance":      {"nbf": strconv.Itoa(claimsNow + 30)},
		"exp inside the tolerance":  {"exp": strconv.Itoa(claimsNow - 29)},
		"iat far in the future":     {"iat": strconv.Itoa(claimsNow + 86_400)},
		"subject of 512":            {"sub": strconv.Quote(strings.Repeat(string(rune(0x10000)), 512))},
	}
	for name, change := range cases {
		if got, err := check(baseClaims().with(change)); err != nil || got.Subject == "" {
			t.Errorf("%s: %+v %v", name, got, err)
		}
	}
}

func TestAuthTimeIsAWholeSecondInRange(t *testing.T) {
	cases := map[string]*int64{"": nil, "0": new(int64(0)), "1700000000": new(int64(1_700_000_000)),
		"1.0": new(int64(1)), "1e3": new(int64(1000)), "253402300799": new(int64(253402300799))}
	for raw, want := range cases {
		got, err := check(baseClaims().with(claims{"auth_time": raw}))
		if err != nil || (got.AuthTime == nil) != (want == nil) || (want != nil && *got.AuthTime != *want) {
			t.Errorf("auth_time %q: %v %v", raw, got.AuthTime, err)
		}
	}
}

func TestOnlyAVerifiedEmailIsTaken(t *testing.T) {
	cases := map[string]struct {
		change claims
		want   string
	}{
		"verified":                {claims{"email": `"Ann@Example.Test"`, "email_verified": `true`}, "ann@example.test"},
		"verified as a string":    {claims{"email": `"ann@example.test"`, "email_verified": `"true"`}, ""},
		"not verified":            {claims{"email": `"ann@example.test"`, "email_verified": `false`}, ""},
		"no verification":         {claims{"email": `"ann@example.test"`}, ""},
		"verified, not a string":  {claims{"email": `["ann@example.test"]`, "email_verified": `true`}, ""},
		"verified, not an email":  {claims{"email": `"ann"`, "email_verified": `true`}, ""},
		"verified, not ASCII":     {claims{"email": strconv.Quote("ann@" + string(rune(0x212a)) + ".test"), "email_verified": `true`}, ""},
		"verified, null":          {claims{"email": `null`, "email_verified": `true`}, ""},
		"verified, no email":      {claims{"email_verified": `true`}, ""},
		"verified number one":     {claims{"email": `"ann@example.test"`, "email_verified": `1`}, ""},
		"verified, email too big": {claims{"email": strconv.Quote(strings.Repeat("a", 250) + "@a.test"), "email_verified": `true`}, ""},
	}
	for name, c := range cases {
		got, err := check(baseClaims().with(c.change))
		if err != nil {
			t.Errorf("%s: an email never fails the login: %v", name, err)
			continue
		}
		if (got.Email == nil) != (c.want == "") || (got.Email != nil && *got.Email != c.want) {
			t.Errorf("%s: %v", name, got.Email)
		}
	}
}

func TestAssuranceComesFromAMappingOfAcrAndEveryAmr(t *testing.T) {
	cases := map[string]struct {
		change claims
		want   string
	}{
		"mapped":               {claims{"acr": `"loa2"`, "amr": `["otp","pwd","hwk"]`}, "mfa"},
		"one amr missing":      {claims{"acr": `"loa2"`, "amr": `["pwd"]`}, "oidc"},
		"amr not an array":     {claims{"acr": `"loa2"`, "amr": `"pwd otp"`}, "oidc"},
		"amr with non-strings": {claims{"acr": `"loa2"`, "amr": `["pwd",1,"otp"]`}, "mfa"},
		"another acr":          {claims{"acr": `"loa1"`, "amr": `["pwd","otp"]`}, "oidc"},
		"acr not a string":     {claims{"acr": `["loa2"]`, "amr": `["pwd","otp"]`}, "oidc"},
		"nothing":              {claims{}, "oidc"},
	}
	for name, c := range cases {
		if got, err := check(baseClaims().with(c.change)); err != nil || got.Assurance != c.want {
			t.Errorf("%s: %q %v", name, got.Assurance, err)
		}
	}
}
