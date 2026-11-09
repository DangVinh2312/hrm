package workrequest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"

	"hrm/api-go/internal/modules/hrbase"
)

type approvalChain string

const (
	chainLead      approvalChain = "lead"
	chainLeadFinal approvalChain = "lead-final"
)

type requestEvent string

const (
	eventLeadApprove    requestEvent = "lead_approve"
	eventLeadReject     requestEvent = "lead_reject"
	eventFinalApprove   requestEvent = "final_approve"
	eventFinalReject    requestEvent = "final_reject"
	eventCancel         requestEvent = "cancel"
	eventCancelApproved requestEvent = "cancel_approved"
)

// approvalChainOf: late/early only need the Team Lead; the other kinds go on to the COO.
func approvalChainOf(kind hrbase.RequestKind) approvalChain {
	if timeOnly(kind) {
		return chainLead
	}
	return chainLeadFinal
}

// nextState is the state event leads to, false for any other pair. A one-step chain makes the lead's
// approval the final one; pending_final is still reachable for it when the lead step was skipped at submit.
// Guards beyond the state (version, actor, effect handlers) are the command's.
func nextState(state string, event requestEvent, chain approvalChain) (string, bool) {
	to := func(next string, valid bool) (string, bool) {
		if !valid {
			return "", false
		}
		return next, true
	}
	switch event {
	case eventLeadApprove:
		if chain == chainLead {
			return to(stateApproved, state == statePendingLead)
		}
		return to(statePendingFinal, state == statePendingLead)
	case eventLeadReject:
		return to(stateRejected, state == statePendingLead)
	case eventFinalApprove:
		return to(stateApproved, state == statePendingFinal)
	case eventFinalReject:
		return to(stateRejected, state == statePendingFinal)
	case eventCancel:
		return to(stateCancelled, state == statePendingLead || state == statePendingFinal)
	case eventCancelApproved:
		return to(stateCancelled, state == stateApproved)
	}
	return "", false
}

// decisionHash is the SHA-256 hex of [requestId, expectedVersion, decision, reason] as JSON.stringify writes
// it, with true appended only when the approver acknowledged the WFH limit, so a decision without the flag
// hashes as before it existed. The key is not hashed.
func decisionHash(input DecisionInput) (string, error) {
	tail := ""
	if input.AcknowledgeWfhLimit {
		tail = ",true"
	}
	return arrayHash([]*string{&input.RequestID, &input.ExpectedVersion, &input.Decision, input.Reason}, tail)
}

// cancelHash is the SHA-256 hex of [requestId, expectedVersion, reason] as JSON.stringify writes it; the key
// is not hashed.
func cancelHash(input CancelInput) (string, error) {
	return arrayHash([]*string{&input.RequestID, &input.ExpectedVersion, input.Reason}, "")
}

// arrayHash hashes the JSON array of values (nil is null) followed by the raw tail members.
func arrayHash(values []*string, tail string) (string, error) {
	payload := []byte{'['}
	for i, value := range values {
		if i > 0 {
			payload = append(payload, ',')
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return "", err
		}
		payload = append(payload, encoded...)
	}
	sum := sha256.Sum256(append(append(payload, tail...), ']'))
	return hex.EncodeToString(sum[:]), nil
}
