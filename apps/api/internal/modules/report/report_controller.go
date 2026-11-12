package report

import (
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/authorization/enforcement"
	"hrm/api/internal/authorization/keys"
	"hrm/api/internal/httpapi"
)

// Routes are the six read-only reports and their XLSX twins, each on the report's own action; the scope is
// applied inside the query.
type Routes struct {
	Reports HTTPPort
	Origin  string
}

func (r Routes) Register(group *httpapi.Group) error {
	employee := string(keys.EmployeeResourceEmployee)
	for _, kind := range kinds {
		class := enforcement.Authorize(employee, string(actions[kind]))
		path := "/api/hr/reports/" + string(kind)
		if err := httpapi.Register(group, http.MethodGet, path, class, handle(func(c *gin.Context) error { return r.page(c, kind) })); err != nil {
			return err
		}
		if err := httpapi.Register(group, http.MethodGet, path+"/export", class, handle(func(c *gin.Context) error { return r.download(c, kind) })); err != nil {
			return err
		}
	}
	return nil
}

func handle(serve func(*gin.Context) error) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := serve(c); err != nil {
			httpapi.WriteError(c, err)
		}
	}
}

func (r Routes) page(c *gin.Context, kind Kind) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	query, err := parseQuery(kind, c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	result, err := r.Reports.Query(c.Request.Context(), secret, query)
	if err != nil {
		return err
	}
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	httpapi.WriteJSONBytes(c, http.StatusOK, body)
	return nil
}

// download writes the file, or nothing at all when the client has already gone.
func (r Routes) download(c *gin.Context, kind Kind) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	query, err := parseExportQuery(kind, c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	file, delivered, err := r.Reports.Export(c.Request.Context(), secret, query)
	if err != nil || !delivered {
		return err
	}
	return httpapi.WriteBinary(c, file.ContentType, file.FileName, file.Content)
}
