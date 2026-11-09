package workcalendar

import (
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/httpapi"
)

// Routes are read by every HR role and changed by HR/Admin with a fresh session.
type Routes struct {
	Calendar HTTPPort
	Origin   string
}

func (r Routes) Register(group *httpapi.Group) error {
	resource := string(keys.WorkCalendarResourceWorkCalendar)
	manage := enforcement.Authorize(resource, string(keys.WorkCalendarActionManage))
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodGet, "/api/hr/work-calendar", enforcement.Authorize(resource, string(keys.WorkCalendarActionRead)), r.year},
		{http.MethodPut, "/api/hr/work-calendar/holidays", manage, r.setHolidays},
		{http.MethodPut, "/api/hr/work-calendar/days/:date", manage, r.setDay},
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

func answer[T any](c *gin.Context, value T) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	httpapi.WriteJSONBytes(c, http.StatusOK, body)
	return nil
}

func (r Routes) year(c *gin.Context) error {
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	year, err := parseYear(c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	view, found, err := r.Calendar.Year(c.Request.Context(), secret, year)
	if err != nil {
		return err
	}
	if !found {
		return apperror.ErrNotFound
	}
	return answer(c, view)
}

// setDay checks Origin and CSRF before any input is parsed.
func (r Routes) setDay(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[dayBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseDay(c.Param("date"), body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Calendar.SetDay(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return answer(c, result)
}

func (r Routes) setHolidays(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[holidaysBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseHolidays(body)
	if err != nil {
		return err
	}
	secret, err := httpapi.SessionSecret(c.Request, r.Origin)
	if err != nil {
		return err
	}
	result, err := r.Calendar.SetHolidays(c.Request.Context(), secret, input)
	if err != nil {
		return err
	}
	return answer(c, result)
}
