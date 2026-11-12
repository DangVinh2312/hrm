package httpapi

import (
	"github.com/gin-gonic/gin"
)

var CheckInventoryOf = checkInventory

func DecodeJSON[T any](c *gin.Context) (T, error) { return decodeJSON[T](c) }
