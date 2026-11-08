// Package apperror holds the closed set of error keys the API answers with. A key names a response
// class, never a fact the caller may not learn: absent and hidden records share error.notFound,
// every authentication failure shares error.authenticationFailed, CSRF, permission and boundary
// denials share error.accessDenied.
package apperror

import "errors"

// Code is a key of the closed set; it is also a message key of the web locales.
type Code string

var codes = [...]Code{
	"error.invalidRequest",
	"error.authenticationFailed",
	"error.accessDenied",
	"error.notFound",
	"error.conflict",
	"error.dateOutOfRange",
	"error.crossesYear",
	"error.kindNotAllowedInProbation",
	"error.teamNotMember",
	"error.nonWorkingDay",
	"error.makeupDay",
	"error.idempotencyKeyReused",
	"error.overlappingRequest",
	"error.insufficientLeave",
	"error.periodClosed",
	"error.wfhLimitAckRequired",
	"error.exportTooLarge",
	"error.unavailable",
}

// Codes returns a copy of the closed set, in the order of the contract.
func Codes() []Code {
	return append([]Code(nil), codes[:]...)
}

// CodeFor follows the status only, so no handler or error text chooses what is revealed.
func CodeFor(status int) Code {
	switch status {
	case 400:
		return "error.invalidRequest"
	case 401:
		return "error.authenticationFailed"
	case 403:
		return "error.accessDenied"
	case 404:
		return "error.notFound"
	case 409:
		return "error.conflict"
	}
	if status < 500 {
		return "error.invalidRequest"
	}
	return "error.unavailable"
}

// Rejection is a business rule with its own key. It may only be returned after the caller is
// authorized on the target, and the status comes from rejectionStatus, never from the thrower.
type Rejection struct {
	Code Code
}

func (r Rejection) Error() string { return "rejected: " + string(r.Code) }

func rejectionStatus(code Code) (int, bool) {
	switch code {
	case "error.dateOutOfRange", "error.crossesYear", "error.kindNotAllowedInProbation",
		"error.teamNotMember", "error.nonWorkingDay", "error.makeupDay", "error.idempotencyKeyReused",
		"error.insufficientLeave", "error.exportTooLarge":
		return 422, true
	case "error.overlappingRequest", "error.periodClosed", "error.wfhLimitAckRequired":
		return 409, true
	}
	return 0, false
}

var (
	ErrInvalidRequest       = errors.New("invalid request")
	ErrAuthenticationFailed = errors.New("authentication failed")
	ErrAccessDenied         = errors.New("access denied")
	ErrStepUpRequired       = errors.New("step-up required")
	ErrNotFound             = errors.New("not found")
	ErrCommandRejected      = errors.New("command rejected")
	ErrMfaConflict          = errors.New("mfa conflict")
	// ErrUnavailable is a planned 503, like ServiceUnavailableException: not a fault to log.
	ErrUnavailable = errors.New("unavailable")
)

// Response gives the status and key of err. known is false for a fault the caller did not plan,
// including a Rejection with an unlisted key: it answers 503 and is logged by its type only.
func Response(err error) (status int, code Code, known bool) {
	if rejection, ok := errors.AsType[Rejection](err); ok {
		if status, listed := rejectionStatus(rejection.Code); listed {
			return status, rejection.Code, true
		}
		return 503, CodeFor(503), false
	}
	switch {
	case errors.Is(err, ErrAuthenticationFailed):
		status = 401
	case errors.Is(err, ErrAccessDenied), errors.Is(err, ErrStepUpRequired):
		status = 403
	case errors.Is(err, ErrInvalidRequest):
		status = 400
	case errors.Is(err, ErrNotFound):
		status = 404
	case errors.Is(err, ErrCommandRejected), errors.Is(err, ErrMfaConflict):
		status = 409
	case errors.Is(err, ErrUnavailable):
		status = 503
	default:
		return 503, CodeFor(503), false
	}
	return status, CodeFor(status), true
}
