package attendance

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
)

// adjustmentHash hashes the array [employeeId, workDate, minutes, reason, reference] as JSON.stringify writes
// it, an omitted reference as null; the key is not hashed. encoding/json v2 escapes only what JSON requires,
// as JSON.stringify does; v1 would also escape <, >, &, U+2028 and U+2029.
func adjustmentHash(input AdjustmentInput) (string, error) {
	var elements [5][]byte
	var errs [5]error
	elements[0], errs[0] = json.Marshal(input.EmployeeID)
	elements[1], errs[1] = json.Marshal(input.WorkDate)
	elements[2], errs[2] = json.Marshal(input.Minutes)
	elements[3], errs[3] = json.Marshal(input.Reason)
	elements[4], errs[4] = json.Marshal(input.Reference)
	if err := errors.Join(errs[:]...); err != nil {
		return "", err
	}
	payload := append(append([]byte{'['}, bytes.Join(elements[:], []byte{','})...), ']')
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}
