package declarations

import (
	"hrm/api/internal/authorization/core"
	"hrm/api/internal/authorization/values"
)

func NewCore() (*core.Core, error) { return core.New(values.Codecs()) }
