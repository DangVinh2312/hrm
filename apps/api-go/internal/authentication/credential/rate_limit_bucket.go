package credential

import (
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"hrm/api-go/internal/apperror"
)

const (
	maxClientKey   = 256
	clientLimit    = 20
	identityLimit  = 20
	networkLimit   = 200
	prefix64Suffix = "::/64"
)

var (
	bracketedAddress = regexp.MustCompile(`^\[([^\]]+)\](?::\d+)?$`)
	ipv4WithPort     = regexp.MustCompile(`^(\d+\.\d+\.\d+\.\d+):\d+$`)
	nat64Prefix      = [4]byte{0x00, 0x64, 0xff, 0x9b}
)

// Bucket is one row of rate_limit: the digest of its label and the attempts it allows per window.
type Bucket struct {
	Key   []byte
	Limit int32
}

// RateLimitClient is the client of a limiter bucket. One IPv6 /64 is one client, since a host usually
// owns the whole prefix; an IPv6 form that carries an IPv4 client (mapped ::ffff:0:0/96, compatible
// ::/96, NAT64 64:ff9b::/96) is that IPv4 address. A port and a zone are dropped; anything that is not
// an address stays as given.
func RateLimitClient(address string) string {
	bare := address
	if match := bracketedAddress.FindStringSubmatch(address); match != nil {
		bare = match[1]
	} else if match := ipv4WithPort.FindStringSubmatch(address); match != nil {
		bare = match[1]
	}
	bare, _, _ = strings.Cut(bare, "%")
	ip, err := netip.ParseAddr(bare)
	if err != nil {
		return address
	}
	if ip.Is4() {
		return bare
	}
	b := ip.As16()
	zero := func(from, to int) bool {
		for _, x := range b[from:to] {
			if x != 0 {
				return false
			}
		}
		return true
	}
	mapped := zero(0, 10) && b[10] == 0xff && b[11] == 0xff
	compatible := zero(0, 12) && (b[12] != 0 || b[13] != 0)
	nat64 := [4]byte(b[0:4]) == nat64Prefix && zero(4, 12)
	if mapped || compatible || nat64 {
		return netip.AddrFrom4([4]byte(b[12:16])).String()
	}
	words := make([]string, 4)
	for i := range words {
		words[i] = strconv.FormatUint(uint64(b[2*i])<<8|uint64(b[2*i+1]), 16)
	}
	return strings.Join(words, ":") + prefix64Suffix
}

// RateLimitBuckets lists the buckets one attempt counts against, in the order they are taken: the /48
// network of an IPv6 client, the client, then the identifier unless it is the client. A limited source
// stops early, so it cannot add identifier rows.
func RateLimitBuckets(clientKey, identifier, purpose string) ([]Bucket, error) {
	if length := utf8.RuneCountInString(clientKey); length < 1 || length > maxClientKey {
		return nil, apperror.ErrAuthenticationFailed
	}
	client := RateLimitClient(clientKey)
	var buckets []Bucket
	if strings.HasSuffix(client, prefix64Suffix) {
		network := strings.Join(strings.Split(client, ":")[:3], ":") + "::/48"
		buckets = append(buckets, Bucket{SecretDigest("net:" + network), networkLimit})
	}
	buckets = append(buckets, Bucket{SecretDigest(purpose + ":ip:" + client), clientLimit})
	if identifier != client {
		buckets = append(buckets, Bucket{SecretDigest(purpose + ":login:" + identifier), identityLimit})
	}
	return buckets, nil
}
