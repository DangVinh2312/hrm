package httpapi_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/httpapi"
)

func clientIP(remote string, trustProxy int, forwarded ...string) string {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = remote
	for _, value := range forwarded {
		request.Header.Add("X-Forwarded-For", value)
	}
	request.Header.Set("X-Real-IP", "192.0.2.99")
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = request
	return httpapi.ClientIP(c, trustProxy)
}

func TestClientIPFollowsTrustedHops(t *testing.T) {
	cases := []struct {
		hops      int
		remote    string
		forwarded []string
		want      string
	}{
		{0, "203.0.113.5:1234", []string{"1.1.1.1"}, "203.0.113.5"},
		{0, "[2001:db8::1]:1234", []string{"2001:db8::2"}, "2001:db8::1"},
		{0, "203.0.113.5:1234", nil, "203.0.113.5"},
		{1, "10.0.0.1:1", []string{"198.51.100.7"}, "198.51.100.7"},
		{1, "10.0.0.1:1", []string{"1.1.1.1, 198.51.100.7"}, "198.51.100.7"},
		{2, "10.0.0.1:1", []string{"1.1.1.1, 198.51.100.7"}, "1.1.1.1"},
		{2, "10.0.0.1:1", []string{"198.51.100.7"}, "198.51.100.7"},
		{1, "10.0.0.1:1", nil, "10.0.0.1"},
		{1, "[::1]:1", []string{"2001:db8::2"}, "2001:db8::2"},
		{2, "[::1]:1", []string{"2001:db8::3, 2001:db8::2"}, "2001:db8::3"},
		{1, "10.0.0.1:1", []string{"1.1.1.1", "2.2.2.2"}, "2.2.2.2"},
		{2, "10.0.0.1:1", []string{"1.1.1.1", "2.2.2.2"}, "1.1.1.1"},
		{1, "10.0.0.1:1", []string{"1.1.1.1,,  2.2.2.2 "}, "2.2.2.2"},
		{1, "10.0.0.1:1", []string{"\t2.2.2.2"}, "2.2.2.2"},
		{9, "10.0.0.1:1", []string{"1.1.1.1, 2.2.2.2, 3.3.3.3"}, "1.1.1.1"},
		{1, "10.0.0.1:1", []string{""}, "10.0.0.1"},
		{1, "10.0.0.1:1", []string{" , "}, "10.0.0.1"},
	}
	for _, c := range cases {
		if got := clientIP(c.remote, c.hops, c.forwarded...); got != c.want {
			t.Errorf("hops %d remote %s forwarded %q: %q, want %q", c.hops, c.remote, c.forwarded, got, c.want)
		}
	}
}

func TestClientIPAtATrustedPositionIsAnAddressOrTheSocket(t *testing.T) {
	for _, forwarded := range []string{
		"garbage",
		"unknown",
		"\xe9",
		"1.1.1.1 2.2.2.2",
		"1.1.1.1:443",
		"[2001:db8::2]:443",
		"999.1.1.1",
		"203.0.113.9, garbage",
	} {
		if got := clientIP("10.0.0.1:1", 1, forwarded); got != "10.0.0.1" {
			t.Errorf("%q: %q", forwarded, got)
		}
	}
	if got := clientIP("10.0.0.1:1", 2, "garbage, 198.51.100.7"); got != "10.0.0.1" {
		t.Errorf("past the proxy: %q", got)
	}
	if got := clientIP("10.0.0.1:1", 1, "garbage, 198.51.100.7"); got != "198.51.100.7" {
		t.Errorf("an untrusted position is not read: %q", got)
	}
}

func TestClientIPIsCanonical(t *testing.T) {
	for _, c := range []struct {
		hops      int
		remote    string
		forwarded []string
		want      string
	}{
		{0, "[::ffff:203.0.113.5]:1", nil, "203.0.113.5"},
		{1, "[::ffff:10.0.0.1]:1", []string{"garbage"}, "10.0.0.1"},
		{1, "10.0.0.1:1", []string{"::ffff:198.51.100.7"}, "198.51.100.7"},
		{1, "10.0.0.1:1", []string{"::FFFF:C633:6407"}, "198.51.100.7"},
		{1, "10.0.0.1:1", []string{"2001:0DB8:0::2"}, "2001:db8::2"},
		{1, "10.0.0.1:1", []string{"fe80::1%eth0"}, "fe80::1"},
		{0, "[fe80::1%en0]:1", nil, "fe80::1"},
	} {
		if got := clientIP(c.remote, c.hops, c.forwarded...); got != c.want {
			t.Errorf("hops %d remote %s forwarded %q: %q, want %q", c.hops, c.remote, c.forwarded, got, c.want)
		}
	}
}

func TestForgedForwardedForIsIgnoredWithoutTrustedHops(t *testing.T) {
	for _, forged := range [][]string{{"1.1.1.1"}, {"127.0.0.1", "10.0.0.1"}, {"unknown"}} {
		if got := clientIP("198.51.100.20:5555", 0, forged...); got != "198.51.100.20" {
			t.Errorf("%q: %q", forged, got)
		}
	}
}
