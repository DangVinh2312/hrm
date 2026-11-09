package declarations

import (
	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/authorization/keys"
)

func RuntimeCapabilities() core.Capabilities {
	return core.Capabilities{Validators: []string{string(keys.ProductValidatorFresh)}, ObligationHandlers: []string{string(keys.ProductObligationAudit)}}
}
