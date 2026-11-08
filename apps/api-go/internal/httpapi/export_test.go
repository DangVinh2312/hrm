package httpapi

import (
	"time"

	"github.com/gin-gonic/gin"
)

var CheckInventoryOf = checkInventory

func DecodeJSON[T any](c *gin.Context) (T, error) { return decodeJSON[T](c) }

func (u *Upstream) ResponseHeaderTimeout() time.Duration { return u.transport.ResponseHeaderTimeout }
