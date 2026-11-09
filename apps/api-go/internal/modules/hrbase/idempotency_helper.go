package hrbase

import "hrm/api-go/internal/apperror"

type Claim[T any] struct {
	Hash   string
	Result T
}

func Replay[T any](prior Claim[T], hash string) (T, error) {
	if prior.Hash != hash {
		var zero T
		return zero, apperror.Rejection{Code: "error.idempotencyKeyReused"}
	}
	return prior.Result, nil
}
