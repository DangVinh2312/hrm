package declarations

import (
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/values"
)

func NewCore() (*core.Core, error) { return core.New(values.Codecs()) }
