package credential

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"

	"hrm/api/internal/config"
)

const (
	gcmNonceBytes = 12
	gcmTagBytes   = 16
)

// SealedTOTPSecret is a TOTP secret at rest: AES-256-GCM with the 16 byte tag at the end of Ciphertext.
type SealedTOTPSecret struct {
	Ciphertext []byte
	Nonce      []byte
	KeyID      string
}

// ErrSealedSecret is every failure to seal or open; it never carries key material.
var ErrSealedSecret = errors.New("MFA secret cannot be opened")

// aad binds the purpose, the user and the key id, so a ciphertext copied to another row or relabelled with
// another key id does not open.
func aad(userID, keyID string) []byte {
	return []byte("HRM-MFA-TOTP\x00v1\x00" + userID + "\x00" + keyID)
}

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrSealedSecret
	}
	return cipher.NewGCM(block)
}

func seal(key, nonce []byte, userID, keyID string, secret []byte) ([]byte, error) {
	aead, err := gcm(key)
	if err != nil {
		return nil, ErrSealedSecret
	}
	return aead.Seal(nil, nonce, secret, aad(userID, keyID)), nil
}

// EncryptTOTPSecret seals with the current key and a fresh 12 byte nonce.
func EncryptTOTPSecret(ring config.MfaKeyRing, userID string, secret []byte) (SealedTOTPSecret, error) {
	key, ok := ring.Key(ring.Current())
	if !ok {
		return SealedTOTPSecret{}, ErrSealedSecret
	}
	nonce := make([]byte, gcmNonceBytes)
	_, _ = rand.Read(nonce)
	ciphertext, err := seal(key, nonce, userID, ring.Current(), secret)
	if err != nil {
		return SealedTOTPSecret{}, err
	}
	return SealedTOTPSecret{Ciphertext: ciphertext, Nonce: nonce, KeyID: ring.Current()}, nil
}

// DecryptTOTPSecret opens a sealed secret; an unknown key id, another user, a wrong nonce or tampered
// bytes fail.
func DecryptTOTPSecret(ring config.MfaKeyRing, userID string, sealed SealedTOTPSecret) ([]byte, error) {
	key, ok := ring.Key(sealed.KeyID)
	if !ok || len(sealed.Nonce) != gcmNonceBytes || len(sealed.Ciphertext) <= gcmTagBytes {
		return nil, ErrSealedSecret
	}
	aead, err := gcm(key)
	if err != nil {
		return nil, ErrSealedSecret
	}
	opened, err := aead.Open(nil, sealed.Nonce, sealed.Ciphertext, aad(userID, sealed.KeyID))
	if err != nil {
		return nil, ErrSealedSecret
	}
	return opened, nil
}
