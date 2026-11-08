package httpapi_test

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/httpapi"
)

type reasonBody struct {
	Reason string   `json:"reason"`
	N      *int     `json:"n"`
	Count  int      `json:"count"`
	Ratio  *float64 `json:"ratio"`
}

// escape keeps the \uXXXX of a body out of the Go string literal, so a test holds the escape itself.
const escape = "\x5cu"

func decodeBody(contentType, body string) (reasonBody, error) {
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = request
	return httpapi.DecodeJSON[reasonBody](c)
}

func TestDecodeJSONReadsAnObject(t *testing.T) {
	const emoji = "\xf0\x9f\x98\x80"
	for name, c := range map[string]struct {
		contentType, body string
		reason            string
		n                 bool
	}{
		"fields":           {"application/json", `{"reason":"nghỉ phép ` + emoji + `","n":1}`, "nghỉ phép " + emoji, true},
		"missing field":    {"application/json", `{"reason":"x"}`, "x", false},
		"null pointer":     {"application/json", `{"n":null}`, "", false},
		"null in a string": {"application/json", `{"reason":null}`, "", false},
		"null in a number": {"application/json", `{"count":null}`, "", false},
		"charset utf-8":    {"application/json; charset=UTF-8", `{"reason":"x"}`, "x", false},
		"quoted charset":   {"application/json; charset=\"utf-8\"", `{"reason":"x"}`, "x", false},
		"raw pair":         {"application/json", `{"reason":"` + emoji + `"}`, emoji, false},
		"escaped pair":     {"application/json", `{"reason":"` + escape + `d83d` + escape + `de00"}`, emoji, false},
		"escaped key":      {"application/json", `{"` + escape + `0072eason":"x"}`, "x", false},
		"leading space":    {"application/json", " \n{}", "", false},
		"near the limit":   {"application/json", `{"reason":"` + strings.Repeat("a", 100<<10-14) + `"}`, strings.Repeat("a", 100<<10-14), false},
	} {
		got, err := decodeBody(c.contentType, c.body)
		if err != nil || got.Reason != c.reason || (got.N != nil) != c.n || got.Count != 0 {
			t.Errorf("%s: %+v %v", name, got, err)
		}
	}
}

func TestDecodeJSONRefusesAnythingElse(t *testing.T) {
	for name, c := range map[string]struct{ contentType, body string }{
		"no content type":            {"", `{}`},
		"text/plain":                 {"text/plain", `{}`},
		"+json":                      {"application/merge-patch+json", `{}`},
		"form":                       {"application/x-www-form-urlencoded", "a=1"},
		"latin1":                     {"application/json; charset=latin1", `{}`},
		"utf-16":                     {"application/json; charset=utf-16le", "{\x00}\x00"},
		"empty quoted charset":       {`application/json; charset=""`, `{}`},
		"empty":                      {"application/json", ""},
		"null":                       {"application/json", "null"},
		"array":                      {"application/json", `[{}]`},
		"string":                     {"application/json", `"x"`},
		"broken":                     {"application/json", `{`},
		"trailing value":             {"application/json", `{} {}`},
		"bom":                        {"application/json", "\xef\xbb\xbf{}"},
		"unknown member":             {"application/json", `{"reason":"x","role":"admin"}`},
		"other case member":          {"application/json", `{"Reason":"x"}`},
		"repeated member":            {"application/json", `{"reason":"x","reason":"y"}`},
		"repeated through an escape": {"application/json", `{"reason":"x","` + escape + `0072eason":"y"}`},
		"same text, both escaped":    {"application/json", `{"` + escape + `0072eason":"x","r` + escape + `0065ason":"y"}`},
		"invalid utf-8":              {"application/json", "{\"reason\":\"\xe2\x82\"}"},
		"lone surrogate":             {"application/json", `{"reason":"` + escape + `d83d"}`},
		"lone low surrogate":         {"application/json", `{"reason":"` + escape + `de00x"}`},
		"surrogate in a key":         {"application/json", `{"` + escape + `d83d":1}`},
		"wrong type":                 {"application/json", `{"n":"1"}`},
		"number past int":            {"application/json", `{"n":99999999999999999999}`},
		"number past a plain int":    {"application/json", `{"count":99999999999999999999}`},
		"huge exponent in an int":    {"application/json", `{"n":1e999}`},
		"huge exponent in a float":   {"application/json", `{"ratio":1e999}`},
		"fraction in an int":         {"application/json", `{"n":1.5}`},
		"over the limit":             {"application/json", `{"reason":"` + strings.Repeat("a", 100<<10) + `"}`},
	} {
		got, err := decodeBody(c.contentType, c.body)
		if !errors.Is(err, apperror.ErrInvalidRequest) || got != (reasonBody{}) {
			t.Errorf("%s: %+v %v", name, got, err)
		}
	}
}

func TestDecodeJSONRefusesTwoContentTypeLines(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
	request.Header.Add("Content-Type", "application/json")
	request.Header.Add("Content-Type", "text/plain")
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = request
	if _, err := httpapi.DecodeJSON[reasonBody](c); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("%v", err)
	}
}

type countingBody struct {
	*strings.Reader
	reads int
}

func (b *countingBody) Read(p []byte) (int, error) {
	b.reads++
	return b.Reader.Read(p)
}

func commandRequest(body io.Reader, headers map[string]string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/write", body)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	return request
}

func decodeCommand(request *http.Request) (reasonBody, error) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = request
	return httpapi.DecodeCommand[reasonBody](c, httpOrigin)
}

func TestDecodeCommandChecksCSRFBeforeItReadsTheBody(t *testing.T) {
	token := httpapi.NewCSRF()
	allowed := map[string]string{
		"Origin": httpOrigin, "X-Csrf-Token": token, "Cookie": "authz_csrf=" + token, "Content-Type": "application/json",
	}
	got, err := decodeCommand(commandRequest(strings.NewReader(`{"reason":"x"}`), allowed))
	if err != nil || got.Reason != "x" {
		t.Errorf("allowed: %+v %v", got, err)
	}
	if _, err := decodeCommand(commandRequest(strings.NewReader(`{`), allowed)); !errors.Is(err, apperror.ErrInvalidRequest) {
		t.Errorf("broken body with CSRF: %v", err)
	}
	for name, headers := range map[string]map[string]string{
		"no token":     {"Origin": httpOrigin, "Cookie": "authz_csrf=" + token, "Content-Type": "application/json"},
		"other origin": {"Origin": httpsOrigin, "X-Csrf-Token": token, "Cookie": "authz_csrf=" + token, "Content-Type": "application/json"},
		"no cookie":    {"Origin": httpOrigin, "X-Csrf-Token": token, "Content-Type": "application/json"},
		"no type":      {"Origin": httpOrigin},
	} {
		for _, content := range []string{`{`, `{"reason":"x"}`, strings.Repeat("a", 200<<10)} {
			body := &countingBody{Reader: strings.NewReader(content)}
			got, err := decodeCommand(commandRequest(body, headers))
			if !errors.Is(err, apperror.ErrAccessDenied) || got != (reasonBody{}) {
				t.Errorf("%s: %+v %v", name, got, err)
			}
			if body.reads != 0 {
				t.Errorf("%s: the body was read before CSRF", name)
			}
		}
	}
}

func TestDecodeEmptyCommandTakesNoBodyOrAnEmptyObject(t *testing.T) {
	token := strings.Repeat("a", 43)
	run := func(body string, contentType string, csrf bool) error {
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		if csrf {
			request.Header.Set("Origin", httpOrigin)
			request.Header.Set("X-Csrf-Token", token)
			request.Header.Set("Cookie", "authz_csrf="+token)
		}
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = request
		return httpapi.DecodeEmptyCommand(c, httpOrigin)
	}
	for name, c := range map[string]struct{ body, contentType string }{
		"no body":                 {"", ""},
		"no body, a content type": {"", "application/json"},
		"empty object":            {"{}", "application/json"},
	} {
		if err := run(c.body, c.contentType, true); err != nil {
			t.Errorf("%s: %v", name, err)
		}
		if err := run(c.body, c.contentType, false); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("%s without CSRF: %v", name, err)
		}
	}
	for name, c := range map[string]struct{ body, contentType string }{
		"a member":          {`{"extra":1}`, "application/json"},
		"an array":          {`[]`, "application/json"},
		"null":              {`null`, "application/json"},
		"broken":            {`{`, "application/json"},
		"no content type":   {`{}`, ""},
		"another type":      {`{}`, "text/plain"},
		"a member of a key": {`{"":1}`, "application/json"},
	} {
		if err := run(c.body, c.contentType, true); !errors.Is(err, apperror.ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
		if err := run(c.body, c.contentType, false); !errors.Is(err, apperror.ErrAccessDenied) {
			t.Errorf("%s without CSRF: %v", name, err)
		}
	}
}

func TestAWriteRouteAnswers403ForABrokenBodyWithoutCSRF(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group(""), nil)
	reached := false
	if err := httpapi.Register(group, http.MethodPost, "/api/write", enforcement.Public(), func(c *gin.Context) {
		if _, err := httpapi.DecodeCommand[reasonBody](c, httpOrigin); err != nil {
			httpapi.WriteError(c, err)
			return
		}
		reached = true
	}); err != nil {
		t.Fatal(err)
	}
	request := commandRequest(strings.NewReader(`{`), map[string]string{"Content-Type": "application/json"})
	assertError(t, serve(engine, request), http.StatusForbidden, "error.accessDenied")
	if reached {
		t.Error("the handler went on")
	}
}
