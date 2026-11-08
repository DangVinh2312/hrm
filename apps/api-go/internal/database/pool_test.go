package database_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"hrm/api-go/internal/database"
)

const poolURL = "postgres://product_data:synthetic@db.example.test:5433/product"

func TestTLSFollowsTheEnvironmentOnly(t *testing.T) {
	if got := database.TLSForEnvironment("production"); got != database.TLSVerifyFull {
		t.Fatalf("production: %v", got)
	}
	for _, nodeEnv := range []string{"development", "test"} {
		if got := database.TLSForEnvironment(nodeEnv); got != database.TLSDisabled {
			t.Fatalf("%s: %v", nodeEnv, got)
		}
	}
}

func TestVerifyFullIsNotLoweredByTheURLOrTheEnvironment(t *testing.T) {
	queries := []string{
		"", "?sslmode=disable", "?sslmode=prefer", "?sslmode=allow", "?sslmode=require", "?sslmode=verify-ca",
		"?ssl=false", "?sslmode=disable&sslnegotiation=direct", "?host=elsewhere.example.test",
	}
	for _, query := range queries {
		t.Run(query, func(t *testing.T) {
			config, err := database.NewPoolConfig(database.PurposeData, poolURL+query, database.TLSVerifyFull)
			if err != nil {
				t.Fatal(err)
			}
			assertVerifyFull(t, config.ConnConfig.TLSConfig, "db.example.test")
			if len(config.ConnConfig.Fallbacks) != 0 {
				t.Fatalf("%d fallbacks: a failed TLS attempt could go on without TLS", len(config.ConnConfig.Fallbacks))
			}
			if config.ConnConfig.Host != "db.example.test" {
				t.Fatalf("host %q", config.ConnConfig.Host)
			}
		})
	}
	t.Run("PGSSLMODE", func(t *testing.T) {
		t.Setenv("PGSSLMODE", "disable")
		config, err := database.NewPoolConfig(database.PurposeData, poolURL, database.TLSVerifyFull)
		if err != nil {
			t.Fatal(err)
		}
		assertVerifyFull(t, config.ConnConfig.TLSConfig, "db.example.test")
	})
}

func assertVerifyFull(t *testing.T, config *tls.Config, host string) {
	t.Helper()
	if config == nil {
		t.Fatal("no TLS")
	}
	if config.InsecureSkipVerify || config.VerifyPeerCertificate != nil {
		t.Fatal("the certificate or the host name is not verified")
	}
	if config.ServerName != host {
		t.Fatalf("server name %q", config.ServerName)
	}
}

func TestDisabledTLSStaysOffWhateverTheURLSays(t *testing.T) {
	for _, query := range []string{"", "?sslmode=require", "?sslmode=verify-full", "?sslmode=prefer"} {
		config, err := database.NewPoolConfig(database.PurposeData, poolURL+query, database.TLSDisabled)
		if err != nil {
			t.Fatal(err)
		}
		if config.ConnConfig.TLSConfig != nil || len(config.ConnConfig.Fallbacks) != 0 {
			t.Fatalf("%s: TLS is on", query)
		}
	}
}

func TestTheZeroTLSModeIsRefused(t *testing.T) {
	var unset database.TLSMode
	if _, err := database.NewPoolConfig(database.PurposeData, poolURL, unset); err == nil {
		t.Fatal("expected an error")
	}
}

func TestPoolSizes(t *testing.T) {
	for purpose, want := range map[database.Purpose]int32{
		database.PurposeData:      5,
		database.PurposeIdentity:  2,
		database.PurposeAuthority: 2,
		database.PurposeSync:      1,
	} {
		config, err := database.NewPoolConfig(purpose, poolURL, database.TLSDisabled)
		if err != nil {
			t.Fatal(err)
		}
		if config.MaxConns != want {
			t.Errorf("%s: %d connections, want %d", purpose, config.MaxConns, want)
		}
		if config.ConnConfig.ConnectTimeout != 2*time.Second {
			t.Errorf("%s: connect timeout %s", purpose, config.ConnConfig.ConnectTimeout)
		}
		if config.ConnConfig.DefaultQueryExecMode != pgx.QueryExecModeExec {
			t.Errorf("%s: exec mode %s", purpose, config.ConnConfig.DefaultQueryExecMode)
		}
	}
	if _, err := database.NewPoolConfig(database.Purpose("migration"), poolURL, database.TLSDisabled); err == nil {
		t.Fatal("a login without a pool got one")
	}
}

func TestInvalidURLDoesNotEchoThePassword(t *testing.T) {
	for _, raw := range []string{
		"postgres://product_data:do-not-print-me%zz@localhost/product",
		"postgres://product_data:do-not-print-me@a,b/product",
		"mysql://product_data:do-not-print-me@localhost/product",
	} {
		_, err := database.NewPoolConfig(database.PurposeData, raw, database.TLSDisabled)
		if err == nil {
			t.Fatalf("no error for %q", strings.SplitN(raw, ":", 2)[0])
		}
		if strings.Contains(err.Error(), "do-not-print-me") {
			t.Fatal("the error echoes the password")
		}
	}
}

// serverRefusingTLS answers the SSLRequest with 'N' and records anything that follows it, which would be
// a startup message sent without encryption.
func serverRefusingTLS(t *testing.T) (string, func() []byte) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan []byte, 8)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				close(received)
				return
			}
			var request [8]byte
			if _, err := io.ReadFull(conn, request[:]); err == nil {
				if binary.BigEndian.Uint32(request[4:]) == 80877103 {
					if _, err := conn.Write([]byte{'N'}); err == nil {
						if err := conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond)); err == nil {
							var plain bytes.Buffer
							if _, err := io.Copy(&plain, conn); err == nil || plain.Len() > 0 {
								received <- plain.Bytes()
							}
						}
					}
				} else {
					received <- request[:]
				}
			}
			if conn.Close() != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		if err := listener.Close(); err != nil {
			t.Error(err)
		}
	})
	return listener.Addr().String(), func() []byte {
		select {
		case data := <-received:
			return data
		default:
			return nil
		}
	}
}

func TestVerifyFullDoesNotFallBackToPlainText(t *testing.T) {
	address, plainText := serverRefusingTLS(t)
	config, err := database.NewPoolConfig(database.PurposeData, "postgres://product_data:synthetic@"+address+"/product?sslmode=prefer", database.TLSVerifyFull)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, config.ConnConfig)
	if err == nil {
		t.Fatalf("connected to a server that refused TLS (close: %v)", conn.Close(ctx))
	}
	if got := plainText(); len(got) > 0 {
		t.Fatalf("sent %d bytes without TLS", len(got))
	}
}

func selfSignedServer(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "db.example.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			defer func() {
				if conn.Close() != nil {
					return
				}
			}()
			var request [8]byte
			if _, err := io.ReadFull(conn, request[:]); err == nil {
				if _, err := conn.Write([]byte{'S'}); err == nil {
					server := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})
					if err := server.Handshake(); err == nil {
						if _, err := io.Copy(io.Discard, server); err != nil {
							return
						}
					}
				}
			}
		}
	}()
	t.Cleanup(func() {
		if err := listener.Close(); err != nil {
			t.Error(err)
		}
	})
	return listener.Addr().String()
}

func TestVerifyFullRefusesAnUntrustedCertificate(t *testing.T) {
	address := selfSignedServer(t)
	config, err := database.NewPoolConfig(database.PurposeData, "postgres://product_data:synthetic@"+address+"/product?sslmode=require", database.TLSVerifyFull)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, config.ConnConfig)
	if err == nil {
		t.Fatalf("connected to a server with an untrusted certificate (close: %v)", conn.Close(ctx))
	}
	var unknown x509.UnknownAuthorityError
	if !errors.As(err, &unknown) {
		t.Fatalf("not refused for its certificate: %T", err)
	}
}

func TestAConnectionFailureIsUnavailable(t *testing.T) {
	config, err := database.NewPoolConfig(database.PurposeData, "postgres://product_data:synthetic@127.0.0.1:1/product", database.TLSDisabled)
	if err != nil {
		t.Fatal(err)
	}
	pool, err := database.NewPool(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	runner, err := database.NewRunner(database.Pools{database.PurposeData: pool}, database.RunnerOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Run(context.Background(), runner, database.ModeRead, func(context.Context, *database.Tx) (int, error) {
		t.Error("the transaction started")
		return 0, nil
	}, database.RunOptions{})
	var unavailable *database.UnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("got %T, want UnavailableError", err)
	}
}

func openPoolsCode(t *testing.T, address string) string {
	t.Helper()
	pools, err := database.OpenPools(t.Context(), map[database.Purpose]string{
		database.PurposeData: "postgres://product_data:synthetic@" + address + "/product",
	}, database.TLSDisabled)
	if err == nil {
		pools.Close()
		t.Fatal("opened")
	}
	if pools != nil {
		t.Errorf("%v", pools)
	}
	var unavailable *database.UnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("got %T, want UnavailableError", err)
	}
	return unavailable.Code
}

func TestOpenPoolsTellsARefusalFromAServerThatDidNotAnswerInTime(t *testing.T) {
	if code := openPoolsCode(t, "127.0.0.1:1"); code != "connection" {
		t.Errorf("refused: %s", code)
	}
	silent, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := silent.Close(); err != nil {
			t.Error(err)
		}
	}()
	started := time.Now()
	if code := openPoolsCode(t, silent.Addr().String()); code != "deadline" {
		t.Errorf("silent: %s", code)
	}
	if took := time.Since(started); took < time.Second || took > 30*time.Second {
		t.Errorf("gave up after %s", took)
	}
}
