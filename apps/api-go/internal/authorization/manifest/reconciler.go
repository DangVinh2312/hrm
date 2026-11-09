package manifest

import (
	"slices"

	"hrm/api-go/internal/authorization/core"
	"hrm/api-go/internal/database"
)

type Reconciler struct {
	runner       *database.Runner
	core         *core.Core
	capabilities core.Capabilities
}

func NewReconciler(runner *database.Runner, c *core.Core, capabilities core.Capabilities) (*Reconciler, error) {
	if runner == nil || c == nil {
		return nil, reject("invalid_release")
	}
	return &Reconciler{runner: runner, core: c, capabilities: core.Capabilities{Validators: slices.Clone(capabilities.Validators), ObligationHandlers: slices.Clone(capabilities.ObligationHandlers)}}, nil
}
