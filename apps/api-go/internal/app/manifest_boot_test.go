package app

import (
	"context"
	"errors"
	"slices"
	"testing"

	"hrm/api-go/internal/config"
	"hrm/api-go/internal/database"
)

func TestEveryManifestBootStepFailurePreventsListen(t *testing.T) {
	for _, phase := range []string{"protection", "manifest"} {
		var count int
		if phase == "protection" {
			count = len(permissionBootSteps())
		} else {
			count = len(manifestBootSteps())
		}
		for index := range count {
			calls := &recorder{}
			using := testSteps(t, calls)
			checks := using.afterKeys
			if phase == "protection" {
				checks = using.afterPrivileges
			}
			name := checks[index].name
			t.Run(name, func(t *testing.T) {
				boom := errors.New("boot check failed")
				checks[index].run = func(context.Context, config.Config, database.Pools) error { return boom }
				_, err := boot(t.Context(), testConfig("http://127.0.0.1:1"), quietLogger(), using)
				var step *BootError
				if !errors.As(err, &step) || step.Step != name || !errors.Is(err, boom) {
					t.Fatalf("wrong failure: %v", err)
				}
				if slices.Contains(calls.list(), "listen") {
					t.Fatal("failed boot listened")
				}
				if !slices.Contains(calls.list(), "close pools") {
					t.Fatal("failed boot leaked pools")
				}
			})
		}
	}
}
