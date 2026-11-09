package setting

import (
	"context"
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/httpapi"
	"hrm/api-go/internal/modules/settingcore"
)

type HistoryQuery struct {
	Key           settingcore.Key
	Limit, Offset int
}

// Port is the setting operations bound to the authority. A read answers found=false when the plan of the
// caller does not reach the settings anchor: 404, the same answer for a roleless account and a missing page.
type Port interface {
	List(ctx context.Context, secret string) (ListView, bool, error)
	Profile(ctx context.Context, secret string) (ProfileView, bool, error)
	Security(ctx context.Context, secret string) (SecurityView, bool, error)
	History(ctx context.Context, secret string, query HistoryQuery) (HistoryView, bool, error)
	Update(ctx context.Context, secret string, input UpdateInput) (UpdateResult, error)
}

// Routes is the HTTP side of the settings. Writing is one route per group, so the permission checked is
// the one the key needs.
type Routes struct {
	Settings Port
	Origin   string
}

func (r Routes) Register(group *httpapi.Group) error {
	authorize := func(action keys.SettingAction) enforcement.Classification {
		return enforcement.Authorize(string(keys.SettingResourceSetting), string(action))
	}
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodGet, "/api/administration/settings", authorize(keys.SettingActionRead), r.list},
		{http.MethodGet, "/api/administration/settings/profile", authorize(keys.SettingActionReadProfile), r.profile},
		{http.MethodGet, "/api/administration/settings/security", authorize(keys.SettingActionRead), r.security},
		{http.MethodGet, "/api/administration/settings/:key/history", authorize(keys.SettingActionRead), r.history},
		{http.MethodPut, "/api/administration/settings/profile/:key", authorize(keys.SettingActionUpdateProfile), func(c *gin.Context) error { return r.update(c, settingcore.GroupProfile) }},
		{http.MethodPut, "/api/administration/settings/rule/:key", authorize(keys.SettingActionUpdateRule), func(c *gin.Context) error { return r.update(c, settingcore.GroupRule) }},
	} {
		handler := func(c *gin.Context) {
			if err := route.handle(c); err != nil {
				httpapi.WriteError(c, err)
			}
		}
		if err := httpapi.Register(group, route.method, route.path, route.class, handler); err != nil {
			return err
		}
	}
	return nil
}

func found[T any](c *gin.Context, value T, reached bool, err error) error {
	if err != nil {
		return err
	}
	if !reached {
		return apperror.ErrNotFound
	}
	return answer(c, value)
}

func answer[T any](c *gin.Context, value T) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	httpapi.WriteJSONBytes(c, http.StatusOK, body)
	return nil
}

func (r Routes) secret(c *gin.Context) (string, error) {
	return httpapi.SessionSecret(c.Request, r.Origin)
}

func (r Routes) list(c *gin.Context) error {
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	view, reached, err := r.Settings.List(c.Request.Context(), secret)
	return found(c, view, reached, err)
}

func (r Routes) profile(c *gin.Context) error {
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	view, reached, err := r.Settings.Profile(c.Request.Context(), secret)
	return found(c, view, reached, err)
}

func (r Routes) security(c *gin.Context) error {
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	view, reached, err := r.Settings.Security(c.Request.Context(), secret)
	return found(c, view, reached, err)
}

func (r Routes) history(c *gin.Context) error {
	key, err := parseKey(c.Param("key"))
	if err != nil {
		return err
	}
	page, err := parseHistoryQuery(c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	view, reached, err := r.Settings.History(c.Request.Context(), secret, HistoryQuery{Key: key, Limit: page.Limit, Offset: page.Offset})
	return found(c, view, reached, err)
}

// update checks Origin and CSRF before any input is parsed.
func (r Routes) update(c *gin.Context, group settingcore.Group) error {
	body, err := httpapi.DecodeCommand[updateBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseUpdate(group, c.Param("key"), body)
	if err != nil {
		return err
	}
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	result, err := r.Settings.Update(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return answer(c, result)
}
