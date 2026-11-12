package httpapi

import (
	"net"
	"net/netip"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"
)

// ClientIP is the client under trustProxy hops: the socket, then X-Forwarded-For from the nearest hop
// outwards, taking the first entry past the trusted hops. A value that is not an address gives the
// socket, so what a limiter keys on is never text a client chose; an address has one spelling here, so a
// client cannot get a second bucket by writing it another way.
func ClientIP(c *gin.Context, trustProxy int) string {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		host = c.Request.RemoteAddr
	}
	socket := host
	if address, err := netip.ParseAddr(host); err == nil {
		socket = canonicalAddress(address)
	}
	forwarded := forwardedFor(c.Request.Header.Values("X-Forwarded-For"))
	if trustProxy <= 0 || len(forwarded) == 0 {
		return socket
	}
	address, err := netip.ParseAddr(forwarded[min(trustProxy, len(forwarded))-1])
	if err != nil {
		return socket
	}
	return canonicalAddress(address)
}

func canonicalAddress(address netip.Addr) string {
	return address.Unmap().WithZone("").String()
}

// forwardedFor lists the entries nearest hop first; a later header line came from a nearer hop.
func forwardedFor(lines []string) []string {
	var entries []string
	for _, entry := range slices.Backward(strings.Split(strings.Join(lines, ","), ",")) {
		if entry = strings.Trim(entry, " \t"); entry != "" {
			entries = append(entries, entry)
		}
	}
	return entries
}
