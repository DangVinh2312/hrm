package workschedule

import (
	"encoding/json/v2"
	"net/http"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
	"hrm/api-go/internal/authorization/enforcement"
	"hrm/api-go/internal/authorization/keys"
	"hrm/api-go/internal/httpapi"
)

// Routes are the company schedule and each employee's own frames (ADR-19).
type Routes struct {
	Schedules HTTPPort
	Origin    string
}

func (r Routes) Register(group *httpapi.Group) error {
	calendar, employee := string(keys.WorkCalendarResourceWorkCalendar), string(keys.EmployeeResourceEmployee)
	manageCompany := enforcement.Authorize(calendar, string(keys.WorkCalendarActionManageSchedule))
	readEmployee := enforcement.Authorize(employee, string(keys.EmployeeActionReadSchedule))
	manageEmployee := enforcement.Authorize(employee, string(keys.EmployeeActionManageSchedule))
	for _, route := range []struct {
		method, path string
		class        enforcement.Classification
		handle       func(*gin.Context) error
	}{
		{http.MethodGet, "/api/hr/work-calendar/schedule", enforcement.Authorize(calendar, string(keys.WorkCalendarActionRead)), r.companySchedule},
		{http.MethodPut, "/api/hr/work-calendar/schedule/:effectiveFrom", manageCompany, r.putCompanySchedule},
		{http.MethodDelete, "/api/hr/work-calendar/schedule/:effectiveFrom", manageCompany, r.deleteCompanySchedule},
		{http.MethodGet, "/api/hr/employees/:id/schedule-frames", readEmployee, r.employeeFrames},
		{http.MethodPost, "/api/hr/employees/:id/schedule-frames", manageEmployee, r.addEmployeeFrame},
		{http.MethodDelete, "/api/hr/employees/:id/schedule-frames/:frameId", manageEmployee, r.endEmployeeFrame},
		{http.MethodGet, "/api/hr/employees/:id/schedule", readEmployee, r.employeeDays},
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

func answer[T any](c *gin.Context, status int, value T, found bool, err error) error {
	if err != nil {
		return err
	}
	if !found {
		return apperror.ErrNotFound
	}
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	httpapi.WriteJSONBytes(c, status, body)
	return nil
}

func (r Routes) secret(c *gin.Context) (string, error) {
	return httpapi.SessionSecret(c.Request, r.Origin)
}

func (r Routes) companySchedule(c *gin.Context) error {
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	view, found, err := r.Schedules.CompanySchedule(c.Request.Context(), secret)
	return answer(c, http.StatusOK, view, found, err)
}

// putCompanySchedule and every other write check Origin and CSRF before any input is parsed.
func (r Routes) putCompanySchedule(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[companyScheduleBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseCompanySchedule(c.Param("effectiveFrom"), body)
	if err != nil {
		return err
	}
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	result, err := r.Schedules.PutCompanySchedule(c.Request.Context(), secret, input)
	return answer(c, http.StatusOK, result, true, err)
}

func (r Routes) deleteCompanySchedule(c *gin.Context) error {
	if err := httpapi.EnforceCSRF(c.Request, r.Origin); err != nil {
		return err
	}
	date, err := parseDate(c.Param("effectiveFrom"))
	if err != nil {
		return err
	}
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	result, err := r.Schedules.DeleteCompanySchedule(c.Request.Context(), secret, date)
	return answer(c, http.StatusOK, result, true, err)
}

func (r Routes) employeeFrames(c *gin.Context) error {
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	id, err := httpapi.InputUUID(c.Param("id"))
	if err != nil {
		return err
	}
	view, found, err := r.Schedules.EmployeeFrames(c.Request.Context(), secret, id)
	return answer(c, http.StatusOK, view, found, err)
}

func (r Routes) addEmployeeFrame(c *gin.Context) error {
	body, err := httpapi.DecodeCommand[employeeFrameBody](c, r.Origin)
	if err != nil {
		return err
	}
	input, err := parseEmployeeFrame(c.Param("id"), body)
	if err != nil {
		return err
	}
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	result, found, err := r.Schedules.AddEmployeeFrame(c.Request.Context(), secret, input)
	return answer(c, http.StatusCreated, result, found, err)
}

// endEmployeeFrame ends the frame today, or removes it when it has not started.
func (r Routes) endEmployeeFrame(c *gin.Context) error {
	if err := httpapi.EnforceCSRF(c.Request, r.Origin); err != nil {
		return err
	}
	key, err := parseFrameKey(c.Param("id"), c.Param("frameId"))
	if err != nil {
		return err
	}
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	result, found, err := r.Schedules.EndEmployeeFrame(c.Request.Context(), secret, key)
	return answer(c, http.StatusOK, result, found, err)
}

// employeeDays is the hours of each day of ?from&to (at most 92 days), as requests see them.
func (r Routes) employeeDays(c *gin.Context) error {
	secret, err := r.secret(c)
	if err != nil {
		return err
	}
	query, err := parseScheduleQuery(c.Param("id"), c.Request.URL.RawQuery)
	if err != nil {
		return err
	}
	view, found, err := r.Schedules.EmployeeDays(c.Request.Context(), secret, query)
	return answer(c, http.StatusOK, view, found, err)
}
