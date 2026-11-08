package httpapi

import (
	"bytes"
	"encoding/json/v2"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"hrm/api-go/internal/apperror"
)

const bodyLimit = 100 << 10

// DecodeCommand is how a route that writes reads its body. CSRF comes first, so a request that fails it
// is refused without its body being read, and the answer says nothing about the body. A write without a
// body calls EnforceCSRF instead.
func DecodeCommand[T any](c *gin.Context, origin string) (T, error) {
	if err := EnforceCSRF(c.Request, origin); err != nil {
		var zero T
		return zero, err
	}
	return decodeJSON[T](c)
}

// DecodeEmptyCommand is how a route that takes no fields reads its body: CSRF first, then no body at all or
// an empty object, so a member the route does not declare is refused.
func DecodeEmptyCommand(c *gin.Context, origin string) error {
	if err := EnforceCSRF(c.Request, origin); err != nil {
		return err
	}
	if c.Request.ContentLength == 0 {
		return nil
	}
	_, err := decodeJSON[struct{}](c)
	return err
}

// decodeJSON reads the body of c as one JSON object of type T. encoding/json/v2 refuses repeated
// members, invalid UTF-8 and lone surrogates (ADR-21); unknown members are refused too, so a field
// the route does not declare never passes silently. Every refusal is ErrInvalidRequest.
func decodeJSON[T any](c *gin.Context) (T, error) {
	var decoded T
	contentType := c.Request.Header.Values("Content-Type")
	if len(contentType) != 1 {
		return decoded, apperror.ErrInvalidRequest
	}
	mediaType, params, err := mime.ParseMediaType(contentType[0])
	charset, declared := params["charset"]
	if err != nil || mediaType != "application/json" || (declared && !strings.EqualFold(charset, "utf-8")) {
		return decoded, apperror.ErrInvalidRequest
	}
	body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, bodyLimit))
	if err != nil || !bytes.HasPrefix(bytes.TrimLeft(body, " \t\r\n"), []byte("{")) {
		return decoded, apperror.ErrInvalidRequest
	}
	if err := json.Unmarshal(body, &decoded, json.RejectUnknownMembers(true)); err != nil {
		var zero T
		return zero, apperror.ErrInvalidRequest
	}
	return decoded, nil
}
