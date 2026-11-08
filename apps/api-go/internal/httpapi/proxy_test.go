package httpapi_test

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"hrm/api-go/internal/httpapi"
)

type seenRequest struct {
	method, uri, host string
	header            http.Header
	body              []byte
	contentLength     int64
	chunked           bool
}

type fakeUpstream struct {
	*httptest.Server
	mutex sync.Mutex
	seen  []seenRequest
}

func (u *fakeUpstream) last(t *testing.T) seenRequest {
	t.Helper()
	u.mutex.Lock()
	defer u.mutex.Unlock()
	if len(u.seen) == 0 {
		t.Fatal("nothing reached the upstream")
	}
	return u.seen[len(u.seen)-1]
}

func newFakeUpstream(t *testing.T, answer http.HandlerFunc) *fakeUpstream {
	t.Helper()
	upstream := &fakeUpstream{}
	upstream.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		upstream.mutex.Lock()
		upstream.seen = append(upstream.seen, seenRequest{
			r.Method, r.RequestURI, r.Host, r.Header.Clone(), body, r.ContentLength, slices.Contains(r.TransferEncoding, "chunked"),
		})
		upstream.mutex.Unlock()
		answer(w, r)
	}))
	t.Cleanup(upstream.Close)
	return upstream
}

// proxyFront is Go in front of target, with routes proxied the way the composition root does.
func proxyFront(t *testing.T, target string, trustProxy int, logger *slog.Logger) string {
	t.Helper()
	upstream, err := httpapi.NewUpstream(target, trustProxy, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(upstream.Close)
	engine := httpapi.NewEngine(logger)
	group := httpapi.NewGroup(engine.Group(""), nil)
	for _, route := range []httpapi.Route{
		{Method: http.MethodPost, Path: "/api/write"},
		{Method: http.MethodPut, Path: "/api/write"},
		{Method: http.MethodDelete, Path: "/api/write"},
		{Method: http.MethodGet, Path: "/api/read"},
		{Method: http.MethodGet, Path: "/api/items/:id"},
	} {
		if err := httpapi.RegisterProxied(group, route, upstream); err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(httpapi.NewHandler(engine))
	t.Cleanup(server.Close)
	return server.Listener.Addr().String()
}

func okUpstream(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }

type wireAnswer struct {
	status int
	header http.Header
	body   string
}

// exchange writes parts with a pause between them and reads answers until the connection closes or
// want of them arrived.
func exchange(t *testing.T, address string, parts []string, want int, method string) []wireAnswer {
	t.Helper()
	connection, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := connection.Close(); err != nil {
			t.Error(err)
		}
	}()
	if err := connection.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	for index, part := range parts {
		if index > 0 {
			time.Sleep(100 * time.Millisecond)
		}
		if _, err := connection.Write([]byte(part)); err != nil {
			break
		}
	}
	var answers []wireAnswer
	reader := bufio.NewReader(connection)
	for len(answers) < want {
		response, err := http.ReadResponse(reader, &http.Request{Method: method})
		if err != nil {
			break
		}
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		answers = append(answers, wireAnswer{response.StatusCode, response.Header, string(body)})
		if err := response.Body.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return answers
}

func rawProxy(t *testing.T, address, raw string) (*http.Response, string) {
	t.Helper()
	answers := exchangeResponses(t, address, raw)
	return answers.response, answers.body
}

type rawAnswer struct {
	response *http.Response
	body     string
}

func exchangeResponses(t *testing.T, address, raw string) rawAnswer {
	t.Helper()
	method, _, _ := strings.Cut(raw, " ")
	answers := exchange(t, address, []string{raw}, 1, method)
	if len(answers) != 1 {
		t.Fatalf("no answer to %q", raw)
	}
	return rawAnswer{&http.Response{StatusCode: answers[0].status, Header: answers[0].header}, answers[0].body}
}

func TestProxyKeepsEveryByteOfTheBody(t *testing.T) {
	upstream := newFakeUpstream(t, okUpstream)
	address := proxyFront(t, upstream.URL, 0, slog.New(slog.DiscardHandler))
	const jsonType = "Content-Type: application/json\r\n"
	escaped := `{"a":"` + "\\u00e9" + `\n"}`
	binary := "\x00\x01\xfe\xff not json"
	cases := map[string]struct {
		head          string
		sent, got     string
		method        string
		target        string
		wantChunked   bool
		contentLength int64
	}{
		"compact":          {jsonType + "Content-Length: 7\r\n", `{"a":1}`, `{"a":1}`, "POST", "/api/write", false, 7},
		"spaces and order": {jsonType + "Content-Length: 15\r\n", " { \"b\":1,\"a\":2}", " { \"b\":1,\"a\":2}", "POST", "/api/write", false, 15},
		"repeated key":     {jsonType + "Content-Length: 13\r\n", `{"a":1,"a":2}`, `{"a":1,"a":2}`, "POST", "/api/write", false, 13},
		"escapes":          {jsonType + "Content-Length: 16\r\n", escaped, escaped, "PUT", "/api/write", false, 16},
		"bom":              {jsonType + "Content-Length: 5\r\n", "\xef\xbb\xbf{}", "\xef\xbb\xbf{}", "POST", "/api/write", false, 5},
		"bom only":         {jsonType + "Content-Length: 3\r\n", "\xef\xbb\xbf", "\xef\xbb\xbf", "POST", "/api/write", false, 3},
		"empty":            {jsonType + "Content-Length: 0\r\n", "", "", "POST", "/api/write", false, 0},
		"empty delete":     {jsonType + "Content-Length: 0\r\n", "", "", "DELETE", "/api/write", false, 0},
		"get with body":    {jsonType + "Content-Length: 7\r\n", `{"a":1}`, `{"a":1}`, "GET", "/api/read", false, 7},
		"chunked":          {jsonType + "Transfer-Encoding: chunked\r\n", "2\r\n{}\r\n0\r\n\r\n", "{}", "POST", "/api/write", true, -1},
		"chunked get":      {jsonType + "Transfer-Encoding: chunked\r\n", "2\r\n{}\r\n0\r\n\r\n", "{}", "GET", "/api/read", true, -1},
		"not json":         {"Content-Type: application/octet-stream\r\nContent-Length: " + strconv.Itoa(len(binary)) + "\r\n", binary, binary, "POST", "/api/write", false, int64(len(binary))},
		"no type":          {"Content-Length: 2\r\n", "{]", "{]", "POST", "/api/write", false, 2},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			raw := c.method + " " + c.target + " HTTP/1.1\r\nHost: web.example\r\n" + c.head + "\r\n" + c.sent
			if response, _ := rawProxy(t, address, raw); response.StatusCode != http.StatusOK {
				t.Fatalf("status %d", response.StatusCode)
			}
			seen := upstream.last(t)
			if !bytes.Equal(seen.body, []byte(c.got)) {
				t.Errorf("body %q, want %q", seen.body, c.got)
			}
			if seen.method != c.method || seen.chunked != c.wantChunked || seen.contentLength != c.contentLength {
				t.Errorf("%s chunked %v length %d", seen.method, seen.chunked, seen.contentLength)
			}
		})
	}
}

func TestProxyKeepsTheTargetAndHeadersOfTheRequest(t *testing.T) {
	upstream := newFakeUpstream(t, okUpstream)
	address := proxyFront(t, upstream.URL, 0, slog.New(slog.DiscardHandler))
	for _, target := range []string{
		"/api/read",
		"/api/read?",
		"/api/read?b=2&a=1&a=%FF&c=%zz&d=+",
		"/api/items/a%2Fb",
		"/api/items/%41",
		"/api/items/a+b",
		"/api/items/AbC?x=1",
	} {
		if response, _ := rawProxy(t, address, "GET "+target+" HTTP/1.1\r\nHost: web.example\r\n\r\n"); response.StatusCode != http.StatusOK {
			t.Errorf("%s: %d", target, response.StatusCode)
			continue
		}
		if seen := upstream.last(t); seen.uri != target || seen.host != "web.example" {
			t.Errorf("%s reached as %s, host %s", target, seen.uri, seen.host)
		}
	}
	raw := "GET /api/read HTTP/1.1\r\nHost: web.example\r\nOrigin: https://a.example\r\nOrigin: https://b.example\r\n" +
		"Cookie: a=1\r\nCookie: b=2\r\nX-Csrf-Token: t\r\nX-Latin: caf\xe9\r\nAccept-Language: vi\r\n\r\n"
	if response, _ := rawProxy(t, address, raw); response.StatusCode != http.StatusOK {
		t.Fatal(response.StatusCode)
	}
	seen := upstream.last(t)
	if !slices.Equal(seen.header.Values("Origin"), []string{"https://a.example", "https://b.example"}) ||
		!slices.Equal(seen.header.Values("Cookie"), []string{"a=1", "b=2"}) ||
		seen.header.Get("X-Csrf-Token") != "t" || seen.header.Get("X-Latin") != "caf\xe9" {
		t.Errorf("%v", seen.header)
	}
}

func TestProxyOverwritesForwardedHeadersWithTheClientIP(t *testing.T) {
	upstream := newFakeUpstream(t, okUpstream)
	spoofed := "X-Forwarded-For: 203.0.113.9, 198.51.100.7\r\nX-Forwarded-Host: evil.example\r\n" +
		"X-Forwarded-Proto: https\r\nForwarded: for=203.0.113.9\r\nX-Real-Ip: 203.0.113.9\r\n"
	for trustProxy, want := range map[int]string{0: "127.0.0.1", 1: "198.51.100.7", 2: "203.0.113.9"} {
		address := proxyFront(t, upstream.URL, trustProxy, slog.New(slog.DiscardHandler))
		if response, _ := rawProxy(t, address, "GET /api/read HTTP/1.1\r\nHost: x\r\n"+spoofed+"\r\n"); response.StatusCode != http.StatusOK {
			t.Fatal(response.StatusCode)
		}
		seen := upstream.last(t)
		if !slices.Equal(seen.header.Values("X-Forwarded-For"), []string{want}) {
			t.Errorf("hop %d: %v", trustProxy, seen.header.Values("X-Forwarded-For"))
		}
		for _, name := range []string{"X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded"} {
			if seen.header.Get(name) != "" {
				t.Errorf("%s reached the upstream", name)
			}
		}
	}
}

func TestProxyAnswersWhatTheUpstreamAnswers(t *testing.T) {
	var body = strings.Repeat("x", 100000)
	upstream := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Add("Set-Cookie", "a=1; Path=/; HttpOnly")
		header.Add("Set-Cookie", "b=2; Path=/; Max-Age=0")
		for _, name := range []string{"Cache-Control", "Referrer-Policy", "X-Content-Type-Options"} {
			header.Set(name, "from-upstream")
		}
		header.Set("X-Powered-By", "Express")
		header.Set("Etag", `W/"1"`)
		switch r.URL.Path {
		case "/api/items/redirect":
			header.Set("Location", "/login?error=oidc")
			w.WriteHeader(http.StatusSeeOther)
		case "/api/items/empty":
			w.WriteHeader(http.StatusNotModified)
		default:
			header.Set("Content-Disposition", `attachment; filename="r.xlsx"`)
			w.WriteHeader(http.StatusTeapot)
			if _, err := io.WriteString(w, body); err != nil {
				t.Error(err)
			}
		}
	})
	address := proxyFront(t, upstream.URL, 0, slog.New(slog.DiscardHandler))
	redirect, _ := rawProxy(t, address, "GET /api/items/redirect HTTP/1.1\r\nHost: x\r\n\r\n")
	if redirect.StatusCode != http.StatusSeeOther || redirect.Header.Get("Location") != "/login?error=oidc" {
		t.Errorf("redirect: %d %v", redirect.StatusCode, redirect.Header)
	}
	if !slices.Equal(redirect.Header.Values("Set-Cookie"), []string{"a=1; Path=/; HttpOnly", "b=2; Path=/; Max-Age=0"}) {
		t.Errorf("cookies: %v", redirect.Header.Values("Set-Cookie"))
	}
	for _, name := range []string{"Cache-Control", "Referrer-Policy", "X-Content-Type-Options"} {
		if !slices.Equal(redirect.Header.Values(name), []string{"from-upstream"}) {
			t.Errorf("%s: %v", name, redirect.Header.Values(name))
		}
	}
	if notModified, _ := rawProxy(t, address, "GET /api/items/empty HTTP/1.1\r\nHost: x\r\nIf-None-Match: *\r\n\r\n"); notModified.StatusCode != http.StatusNotModified {
		t.Errorf("304: %d", notModified.StatusCode)
	}
	full, text := rawProxy(t, address, "GET /api/items/big HTTP/1.1\r\nHost: x\r\n\r\n")
	if full.StatusCode != http.StatusTeapot || text != body || full.Header.Get("Content-Disposition") == "" ||
		full.Header.Get("X-Powered-By") != "Express" || full.Header.Get("Etag") != `W/"1"` {
		t.Errorf("%d, %d bytes, %v", full.StatusCode, len(text), full.Header)
	}
	head, text := rawProxy(t, address, "HEAD /api/items/big HTTP/1.1\r\nHost: x\r\n\r\n")
	if head.StatusCode != http.StatusTeapot || text != "" || upstream.last(t).method != http.MethodHead {
		t.Errorf("HEAD: %d %q", head.StatusCode, text)
	}
}

func TestProxyDoesNotCompressOnItsOwn(t *testing.T) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	upstream := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept-Encoding") == "gzip" {
			w.Header().Set("Content-Encoding", "gzip")
			if _, err := w.Write(compressed.Bytes()); err != nil {
				t.Error(err)
			}
		}
	})
	address := proxyFront(t, upstream.URL, 0, slog.New(slog.DiscardHandler))
	if _, text := rawProxy(t, address, "GET /api/read HTTP/1.1\r\nHost: x\r\n\r\n"); text != "" || upstream.last(t).header.Get("Accept-Encoding") != "" {
		t.Errorf("%q, %v", text, upstream.last(t).header)
	}
	if _, text := rawProxy(t, address, "GET /api/read HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip\r\n\r\n"); text != compressed.String() {
		t.Errorf("the compressed body changed: %q", text)
	}
}

func deadUpstream(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return "http://" + address
}

func TestADeadUpstreamAnswers503InTheErrorShape(t *testing.T) {
	var logged bytes.Buffer
	address := proxyFront(t, deadUpstream(t), 0, slog.New(slog.NewTextHandler(&logged, nil)))
	response, text := rawProxy(t, address, "POST /api/write?canary=QUERYCANARY HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 18\r\n\r\n{\"a\":\"BODYCANARY\"}")
	if response.StatusCode != http.StatusServiceUnavailable || text != `{"statusCode":503,"code":"error.unavailable"}` ||
		response.Header.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Errorf("%d %q %v", response.StatusCode, text, response.Header)
	}
	for name, want := range map[string]string{"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"} {
		if !slices.Equal(response.Header.Values(name), []string{want}) {
			t.Errorf("%s: %v", name, response.Header.Values(name))
		}
	}
	line := logged.String()
	if !strings.Contains(line, "*net.OpError") {
		t.Errorf("the fault is not diagnosable: %s", line)
	}
	for _, canary := range []string{"CANARY", "127.0.0.1", "connection refused"} {
		if strings.Contains(line, canary) {
			t.Errorf("the log holds %s: %s", canary, line)
		}
	}
}

func TestAnUpstreamCutMidBodyCutsTheClient(t *testing.T) {
	upstream := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte("partial")); err != nil {
			t.Error(err)
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Error(err)
		}
		panic(http.ErrAbortHandler)
	})
	address := proxyFront(t, upstream.URL, 0, slog.New(slog.DiscardHandler))
	connection, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := connection.Close(); err != nil {
			t.Error(err)
		}
	}()
	if err := connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Write([]byte("GET /api/read HTTP/1.1\r\nHost: x\r\n\r\n")); err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(connection)
	var timeout net.Error
	if errors.As(err, &timeout) {
		t.Fatal("the connection stayed open")
	}
	if bytes.Contains(content, []byte("503")) {
		t.Errorf("a started answer turned into an error: %q", content)
	}
	if len(content) == 0 {
		return
	}
	response, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(content)), nil)
	if err != nil {
		return
	}
	if _, err := io.ReadAll(response.Body); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("the client read a whole answer: %q, %v", content, err)
	}
}

func TestUpstreamReady(t *testing.T) {
	status := http.StatusOK
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/moved" {
			w.WriteHeader(http.StatusOK)
			return
		}
		if status == http.StatusSeeOther {
			w.Header().Set("Location", "/moved")
		}
		w.WriteHeader(status)
	}))
	defer server.Close()
	upstream, err := httpapi.NewUpstream(server.URL, 0, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	for answer, want := range map[int]bool{
		http.StatusOK: true, http.StatusServiceUnavailable: false, http.StatusNotFound: false, http.StatusSeeOther: false,
	} {
		status = answer
		if got := upstream.Ready(t.Context()); got != want {
			t.Errorf("%d: %v", answer, got)
		}
	}
	if slices.Contains(paths, "/moved") || !slices.Contains(paths, "/api/health/ready") {
		t.Errorf("%v", paths)
	}
	dead, err := httpapi.NewUpstream(deadUpstream(t), 0, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer dead.Close()
	if dead.Ready(t.Context()) {
		t.Error("a dead upstream is ready")
	}
}

func TestNewUpstreamRefusesAnUnusableTarget(t *testing.T) {
	for _, target := range []string{"", "ftp://x", "http://", "http://u:p@x", "http://x?y=1", "http://x/path", "x:3000", "http://x#f"} {
		if _, err := httpapi.NewUpstream(target, 0, slog.New(slog.DiscardHandler)); err == nil {
			t.Errorf("%q accepted", target)
		}
	}
	upstream, err := httpapi.NewUpstream("http://x:3000", 0, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	upstream.Close()
}

func TestRegisterProxiedAlsoAnswersHead(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group(""), nil)
	upstream, err := httpapi.NewUpstream("http://x:3000", 0, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	for _, route := range []httpapi.Route{{Method: http.MethodGet, Path: "/a"}, {Method: http.MethodPost, Path: "/b"}} {
		if err := httpapi.RegisterProxied(group, route, upstream); err != nil {
			t.Fatal(err)
		}
	}
	var found []string
	for _, route := range engine.Routes() {
		found = append(found, route.Method+" "+route.Path)
	}
	slices.Sort(found)
	if !slices.Equal(found, []string{"GET /a", "HEAD /a", "POST /b"}) {
		t.Errorf("%v", found)
	}
	if err := httpapi.CheckRoutes(engine); err != nil {
		t.Error(err)
	}
}

func TestRegisterProxiedNeedsAnUpstream(t *testing.T) {
	engine := httpapi.NewEngine(slog.New(slog.DiscardHandler))
	group := httpapi.NewGroup(engine.Group(""), nil)
	if err := httpapi.RegisterProxied(group, httpapi.Route{Method: http.MethodGet, Path: "/a"}, nil); err == nil {
		t.Error("a route with no upstream was registered")
	}
	if len(engine.Routes()) != 0 || len(group.Routes()) != 0 {
		t.Errorf("%v %v", engine.Routes(), group.Routes())
	}
}

func TestTheUpstreamHasAsLongToAnswerAsAClientHasToSend(t *testing.T) {
	upstream, err := httpapi.NewUpstream("http://x:3000", 0, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	if got, want := upstream.ResponseHeaderTimeout(), httpapi.NewServer(nil, 0).ReadTimeout; got != want || got != 300*time.Second {
		t.Errorf("%s, read timeout %s", got, want)
	}
}
