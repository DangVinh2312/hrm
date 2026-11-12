// Package httpapi is the HTTP layer shared by every route: engine, error answers, cookies and CSRF,
// JSON bodies and the client address.
package httpapi

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
)

// NewEngine has no logger or recovery of Gin: the default logger writes query strings and the
// default recovery answers 500 with an empty body.
func NewEngine(logger *slog.Logger) *gin.Engine {
	engine := gin.New()
	engine.RedirectTrailingSlash = false
	engine.RedirectFixedPath = false
	engine.ForwardedByClientIP = false
	engine.HandleMethodNotAllowed = false
	// An escaped letter is not a static segment, and an escaped slash stays inside its parameter.
	engine.UseRawPath = true
	engine.UnescapePathValues = true
	engine.Use(recoverAndLog(logger), securityHeaders, refuseUndecodablePath)
	engine.NoRoute(func(c *gin.Context) { WriteError(c, apperror.ErrNotFound) })
	return engine
}

func securityHeaders(c *gin.Context) {
	setSecurityHeaders(c.Writer.Header())
}

func setSecurityHeaders(header http.Header) {
	header.Set("Cache-Control", "no-store")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("X-Content-Type-Options", "nosniff")
}

// NewServer bounds every connection; net/http reads up to 4096 bytes past MaxHeaderBytes before it
// refuses.
func NewServer(handler http.Handler, port int) *http.Server {
	return &http.Server{
		Addr:              ":" + strconv.Itoa(port),
		Handler:           handler,
		MaxHeaderBytes:    16384,
		ReadHeaderTimeout: 60 * time.Second,
		ReadTimeout:       300 * time.Second,
		IdleTimeout:       5 * time.Second,
		// `OPTIONS *` goes to the engine like any path, which answers 404 in the error shape.
		DisableGeneralOptionsHandler: true,
	}
}

// Group is where routes register; it carries the RequestAuth installed at the composition root.
type Group struct {
	routes           *gin.RouterGroup
	auth             enforcement.RequestAuth
	registered       []RegisteredRoute
	permissionExists func(resource, action string) bool
}

func NewGroup(routes *gin.RouterGroup, auth enforcement.RequestAuth, permissionExists ...func(resource, action string) bool) *Group {
	group := &Group{routes: routes, auth: auth}
	if len(permissionExists) == 1 {
		group.permissionExists = permissionExists[0]
	}
	return group
}

var (
	errNoHandler     = errors.New("product route has no handler")
	errNoRequestAuth = errors.New("authenticated product route needs a RequestAuth")
)

// Routes returns what was registered on the group, for CheckInventory.
func (g *Group) Routes() []RegisteredRoute {
	return slices.Clone(g.registered)
}

// Register adds a route served here, so none is reachable without its classification check; CheckRoutes
// refuses a route added another way, and CheckInventory one the contract does not give this class. A GET
// also answers HEAD.
func Register(group *Group, method, path string, classification enforcement.Classification, handler gin.HandlerFunc) error {
	return register(group, RegisteredRoute{Route{method, path}, classification}, handler)
}

func register(group *Group, route RegisteredRoute, handler gin.HandlerFunc) error {
	if err := route.Classification.Registrable(group.permissionExists); err != nil {
		return err
	}
	if handler == nil {
		return errNoHandler
	}
	if route.Classification != enforcement.Public() && group.auth == nil {
		return errNoRequestAuth
	}
	wrapped := guarded(route.Classification, group.auth, handler)
	group.routes.Handle(route.Method, route.Path, wrapped)
	if route.Method == http.MethodGet {
		group.routes.Handle(http.MethodHead, route.Path, wrapped)
	}
	group.registered = append(group.registered, route)
	return nil
}

// CheckRoutes compares the name of this closure, which is a detail of the compiler: Go 1.27 keeps it
// through inlining, nothing promises that. A change that gives one call site another name refuses that
// route at boot; a change that renames them all still matches, because CheckRoutes asks this function.
//
//go:noinline
func guarded(classification enforcement.Classification, auth enforcement.RequestAuth, handler gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := classification.Check(c.Request, auth); err != nil {
			WriteError(c, err)
			return
		}
		handler(c)
	}
}

// CheckRoutes fails when a route of engine does not end in the handler Register installs, such as one
// added with engine.GET; a guard that is only a convention would let such a route be public.
func CheckRoutes(engine *gin.Engine) error {
	want := functionName(guarded(enforcement.Public(), nil, nil))
	var unguarded []string
	for _, route := range engine.Routes() {
		if route.Handler != want {
			unguarded = append(unguarded, route.Method+" "+route.Path)
		}
	}
	if len(unguarded) > 0 {
		return fmt.Errorf("routes outside httpapi.Register: %s", strings.Join(unguarded, ", "))
	}
	return nil
}

func functionName(handler gin.HandlerFunc) string {
	return runtime.FuncForPC(reflect.ValueOf(handler).Pointer()).Name()
}
