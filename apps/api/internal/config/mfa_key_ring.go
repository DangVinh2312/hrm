package config

import (
	"encoding/base64"
	"regexp"
	"slices"
	"strings"
)

const (
	mfaKeyLength      = 32
	maxMfaKeysLength  = 4096
	invalidMfaKeyRing = "MFA_ENCRYPTION_KEYS must list unique <id>:<base64 32-byte key> entries and MFA_ENCRYPTION_KEY_ID must name one"
)

var mfaKeyEntry = regexp.MustCompile(`^([a-z0-9-]{1,32}):([A-Za-z0-9+/]{43}=)$`)

// MfaKeyRing holds the keys of TOTP secrets, encrypted at rest. Key material never reaches an error or
// a format verb.
type MfaKeyRing struct {
	current string
	keys    map[string][]byte
}

func (r MfaKeyRing) Current() string { return r.current }

func (r MfaKeyRing) IDs() []string {
	ids := make([]string, 0, len(r.keys))
	for id := range r.keys {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// Key returns a copy, so a caller cannot change the key the ring holds.
func (r MfaKeyRing) Key(id string) ([]byte, bool) {
	key, ok := r.keys[id]
	return slices.Clone(key), ok
}

func (MfaKeyRing) String() string { return "config.MfaKeyRing{redacted}" }

func (MfaKeyRing) GoString() string { return "config.MfaKeyRing{redacted}" }

type MfaKeyRingError struct{}

func (*MfaKeyRingError) Error() string { return invalidMfaKeyRing }

// ParseMfaKeyRing reads `<keyId>:<base64 of 32 bytes>` entries separated by commas; current must be one
// of them.
func ParseMfaKeyRing(keys, current string) (MfaKeyRing, error) {
	if keys == "" || current == "" || len(keys) > maxMfaKeysLength {
		return MfaKeyRing{}, &MfaKeyRingError{}
	}
	ring := map[string][]byte{}
	for _, entry := range strings.Split(keys, ",") {
		match := mfaKeyEntry.FindStringSubmatch(entry)
		if match == nil {
			return MfaKeyRing{}, &MfaKeyRingError{}
		}
		key, err := base64.StdEncoding.Strict().DecodeString(match[2])
		if err != nil || len(key) != mfaKeyLength {
			return MfaKeyRing{}, &MfaKeyRingError{}
		}
		if _, repeated := ring[match[1]]; repeated {
			return MfaKeyRing{}, &MfaKeyRingError{}
		}
		ring[match[1]] = key
	}
	if _, present := ring[current]; !present {
		return MfaKeyRing{}, &MfaKeyRingError{}
	}
	return MfaKeyRing{current: current, keys: ring}, nil
}
