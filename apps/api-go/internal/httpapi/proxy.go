package httpapi

import (
	"context"
	"errors"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
)

const (
	upstreamDialTimeout  = 2 * time.Second
	upstreamReadyTimeout = 2 * time.Second
	// Below the keepAliveTimeout of 5 s of the Node server: a request written on a socket Node is
	// closing fails, and only reads are retried.
	upstreamIdleTimeout = 4 * time.Second
	upstreamIdleConns   = 32
	// shortcut: the only limit on an upstream that stays silent after a request, so a stuck NestJS holds a
	// goroutine this long; the proxy ends at C2 and is not deployed before it, upgrade if that changes.
	upstreamAnswerTimeout = 300 * time.Second
)

var errInvalidUpstream = errors.New("API_UPSTREAM_URL must be an http or https origin")

// Upstream is the NestJS API that serves the routes not migrated yet.
type Upstream struct {
	target     *url.URL
	trustProxy int
	logger     *slog.Logger
	transport  *http.Transport
	client     *http.Client
}

// parseUpstreamURL accepts only an origin: nothing in it may change what a proxied request says.
func parseUpstreamURL(target string) (*url.URL, error) {
	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Hostname() == "" ||
		parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return nil, errInvalidUpstream
	}
	return parsed, nil
}

func NewUpstream(target string, trustProxy int, logger *slog.Logger) (*Upstream, error) {
	parsed, err := parseUpstreamURL(target)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: upstreamDialTimeout}).DialContext,
		DisableCompression:    true,
		IdleConnTimeout:       upstreamIdleTimeout,
		MaxIdleConnsPerHost:   upstreamIdleConns,
		ResponseHeaderTimeout: upstreamAnswerTimeout,
	}
	return &Upstream{
		target:     parsed,
		trustProxy: trustProxy,
		logger:     logger,
		transport:  transport,
		client: &http.Client{
			Transport:     transport,
			Timeout:       upstreamReadyTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
}

// Handle forwards the request as received: the body, the target and the Host header stay as sent. Only
// X-Forwarded-For changes, so NestJS with one trusted hop sees the client this process computed; the
// other forwarding headers are dropped, as NestJS trusts this hop.
func (u *Upstream) Handle(c *gin.Context) {
	clientIP := ClientIP(c, u.trustProxy)
	// The answer of NestJS has its own; ReverseProxy adds to what is set, it does not replace.
	clearSecurityHeaders(c.Writer.Header())
	proxy := httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.Out.URL.Scheme, request.Out.URL.Host = u.target.Scheme, u.target.Host
			setOriginalTarget(request.Out.URL, request.In)
			request.Out.Header.Set("X-Forwarded-For", clientIP)
		},
		Transport: u.transport,
		ErrorLog:  log.New(io.Discard, "", 0),
		ErrorHandler: func(_ http.ResponseWriter, _ *http.Request, err error) {
			if !errors.Is(err, context.Canceled) {
				u.logger.Error("upstream failed", faultAttributes(err)...)
			}
			setSecurityHeaders(c.Writer.Header())
			WriteError(c, apperror.ErrUnavailable)
		},
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}

// setOriginalTarget sends the path and query as they came on the wire: Opaque is what net/http writes
// on the request line, and NewHandler changed the raw path of In for the router. An absolute target
// has no origin-form bytes to keep, so its parsed path goes.
func setOriginalTarget(out *url.URL, in *http.Request) {
	path, query, _ := strings.Cut(in.RequestURI, "?")
	if !strings.HasPrefix(path, "/") {
		path = in.URL.EscapedPath()
	}
	out.Opaque = path
	// ReverseProxy has already dropped the query parameters it cannot parse.
	out.RawQuery = query
}

// Ready asks NestJS for its own readiness; a redirect or any other answer is not ready.
func (u *Upstream) Ready(ctx context.Context) bool {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.target.String()+"/api/health/ready", http.NoBody)
	if err != nil {
		return false
	}
	response, err := u.client.Do(request)
	if err != nil {
		return false
	}
	_, drainErr := io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return errors.Join(drainErr, response.Body.Close()) == nil && response.StatusCode == http.StatusOK
}

// Close drops the idle connections; requests still in flight end with the server that owns them.
func (u *Upstream) Close() {
	u.transport.CloseIdleConnections()
}
