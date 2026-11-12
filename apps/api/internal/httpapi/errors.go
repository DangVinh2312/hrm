package httpapi

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"hrm/api/internal/apperror"
	"hrm/api/internal/database"
)

var errNoError = errors.New("WriteError called without an error")

type faultKey struct{}

// WriteError answers err as { statusCode, code } and stops the chain; both come from closed tables,
// nothing from the error or the request is copied in. A fault the caller did not plan answers 503 and
// is handed to the engine, which logs its type only.
func WriteError(c *gin.Context, err error) {
	if err == nil {
		err = errNoError
	}
	status, code, known := apperror.Response(err)
	if _, conflict := errors.AsType[*database.ConflictError](err); !known && conflict {
		status, code, known = http.StatusConflict, apperror.CodeFor(http.StatusConflict), true
	}
	if !known {
		c.Set(faultKey{}, err)
	}
	writeError(c, status, code)
}

func writeError(c *gin.Context, status int, code apperror.Code) {
	WriteJSONBytes(c, status, []byte(`{"statusCode":`+strconv.Itoa(status)+`,"code":"`+string(code)+`"}`))
	c.Abort()
}

// WriteJSONBytes answers body, which is JSON already, the way res.json does: Content-Length is set even
// past the buffer of net/http, where it would switch to chunked. No HTML escaping can get in between.
func WriteJSONBytes(c *gin.Context, status int, body []byte) {
	header := c.Writer.Header()
	header.Set("Content-Type", "application/json; charset=utf-8")
	header.Set("Content-Length", strconv.Itoa(len(body)))
	c.Status(status)
	if _, err := c.Writer.Write(body); err != nil {
		c.Set(faultKey{}, err)
	}
}

var errUnsafeFileName = errors.New("attachment file name outside [A-Za-z0-9._-]")

// WriteBinary answers 200 with an attachment: its media type, its length and a file name the caller fixed.
// The name goes into a quoted header parameter, so anything outside [A-Za-z0-9._-] is refused before a byte is
// written, never escaped.
func WriteBinary(c *gin.Context, contentType, fileName string, body []byte) error {
	if fileName == "" || strings.Trim(fileName, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-") != "" {
		return errUnsafeFileName
	}
	header := c.Writer.Header()
	header.Set("Content-Type", contentType)
	header.Set("Content-Disposition", `attachment; filename="`+fileName+`"`)
	header.Set("Content-Length", strconv.Itoa(len(body)))
	c.Status(http.StatusOK)
	if _, err := c.Writer.Write(body); err != nil {
		c.Set(faultKey{}, err)
	}
	return nil
}

type sqlStateError interface {
	error
	SQLState() string
}

// faultAttributes keeps a fault diagnosable without its text, which may carry statements, parameters
// or personal data: the types along the chain, and the fixed codes of a database error.
func faultAttributes(err error) []any {
	var types []string
	for current := err; current != nil; current = errors.Unwrap(current) {
		types = append(types, fmt.Sprintf("%T", current))
	}
	attributes := []any{"types", strings.Join(types, " < ")}
	if unavailable, ok := errors.AsType[*database.UnavailableError](err); ok {
		attributes = append(attributes, "code", unavailable.Code)
	}
	if driver, ok := errors.AsType[sqlStateError](err); ok {
		attributes = append(attributes, "sqlstate", driver.SQLState())
	}
	return attributes
}

func frames() string {
	counters := make([]uintptr, 32)
	found := runtime.CallersFrames(counters[:runtime.Callers(3, counters)])
	var lines []string
	for {
		frame, more := found.Next()
		lines = append(lines, fmt.Sprintf("%s %s:%d", frame.Function, frame.File, frame.Line))
		if !more {
			return strings.Join(lines, "\n")
		}
	}
}

// recoverAndLog answers a panic 503 like any other fault. http.ErrAbortHandler goes on to net/http,
// which drops the connection without a body; so does a panic after the response started, because a
// second status cannot be sent and a truncated body must not look complete.
func recoverAndLog(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			if recovered == http.ErrAbortHandler {
				panic(recovered)
			}
			logger.Error("panic", "type", fmt.Sprintf("%T", recovered), "frames", frames())
			if c.Writer.Written() {
				panic(http.ErrAbortHandler)
			}
			status := http.StatusServiceUnavailable
			writeError(c, status, apperror.CodeFor(status))
		}()
		c.Next()
		if fault, ok := c.Get(faultKey{}); ok {
			if err, isError := fault.(error); isError {
				logger.Error("request failed", faultAttributes(err)...)
			}
		}
	}
}
