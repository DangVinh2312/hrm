// Package test holds the disposable PostgreSQL of the integration tests and the checks of module conventions.
package test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/exec"
	"github.com/testcontainers/testcontainers-go/wait"
)

const (
	// PostgresImage is the pinned image; bump it together with apps/api/test/setup-postgres.ts and compose.yaml.
	PostgresImage = "postgres:18.6-bookworm"

	superuserName    = "fixture_superuser"
	postgresPort     = "5432/tcp"
	maintenanceDB    = "postgres"
	containerStartup = 2 * time.Minute
	readyMessage     = "database system is ready to accept connections"
)

// Postgres is one disposable cluster with synthetic credentials.
type Postgres struct {
	container testcontainers.Container
	host      string
	port      int
	password  string
}

// RandomSecret gives a synthetic password that holds no character a URL or a literal would need to escape.
func RandomSecret() (string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// StartPostgres starts its own cluster; roles are per cluster, so tests that change them do not share one.
func StartPostgres(ctx context.Context) (*Postgres, error) {
	password, err := RandomSecret()
	if err != nil {
		return nil, err
	}
	container, err := testcontainers.Run(ctx, PostgresImage,
		testcontainers.WithEnv(map[string]string{
			"POSTGRES_USER":     superuserName,
			"POSTGRES_PASSWORD": password,
			"POSTGRES_DB":       maintenanceDB,
		}),
		testcontainers.WithExposedPorts(postgresPort),
		testcontainers.WithWaitStrategyAndDeadline(containerStartup, postgresReady()...),
	)
	if err != nil {
		return nil, errors.New("start the container: " + strings.ReplaceAll(err.Error(), password, "<redacted>"))
	}
	postgres, err := describe(ctx, container, password)
	if err != nil {
		return nil, errors.Join(err, container.Terminate(ctx))
	}
	return postgres, nil
}

func postgresReady() []wait.Strategy {
	return []wait.Strategy{
		wait.ForLog(readyMessage).WithOccurrence(2).WithStartupTimeout(containerStartup),
		wait.ForListeningPort(postgresPort).WithStartupTimeout(containerStartup),
	}
}

func describe(ctx context.Context, container testcontainers.Container, password string) (*Postgres, error) {
	host, err := container.Host(ctx)
	if err != nil {
		return nil, err
	}
	mapped, err := container.MappedPort(ctx, postgresPort)
	if err != nil {
		return nil, err
	}
	return &Postgres{container: container, host: host, port: int(mapped.Num()), password: password}, nil
}

// attachPostgres describes the cluster the integration runner started for every package of its run; the
// runner removes it, so it has no container here. The error never carries the URL.
func attachPostgres(target string) (*Postgres, error) {
	parsed, err := url.Parse(target)
	if err != nil {
		return nil, errors.New("test: the runner cluster is not a URL")
	}
	port, err := strconv.Atoi(parsed.Port())
	password, _ := parsed.User.Password()
	if err != nil || parsed.User.Username() != superuserName || password == "" || parsed.Hostname() == "" {
		return nil, errors.New("test: the runner cluster needs the fixture superuser, a host and a port")
	}
	return &Postgres{host: parsed.Hostname(), port: port, password: password}, nil
}

// Stop removes the container and its data.
func (p *Postgres) Stop(ctx context.Context) error {
	if p.container == nil {
		return nil
	}
	return p.container.Terminate(ctx)
}

// Address is the host:port tests connect to.
func (p *Postgres) Address() string {
	return net.JoinHostPort(p.host, strconv.Itoa(p.port))
}

// Host is the host name of the mapped port.
func (p *Postgres) Host() string { return p.host }

// Port is the mapped port.
func (p *Postgres) Port() int { return p.port }

// Superuser is the name of the login behind SuperuserURL.
func Superuser() string { return superuserName }

// SuperuserPassword is the synthetic password of the superuser of this cluster.
func (p *Postgres) SuperuserPassword() string { return p.password }

// SuperuserURL is a connection URL with a synthetic password; never print it.
func (p *Postgres) SuperuserURL(database string) string {
	return p.LoginURL(superuserName, p.password, database)
}

// LoginURL is a connection URL with a synthetic password; never print it.
func (p *Postgres) LoginURL(login, password, database string) string {
	target := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(login, password),
		Host:   p.Address(),
		Path:   "/" + database,
	}
	return target.String()
}

// ConnectSuperuser opens a plain connection for fixtures and catalog reads.
func (p *Postgres) ConnectSuperuser(ctx context.Context, database string) (*pgx.Conn, error) {
	return pgx.Connect(ctx, p.SuperuserURL(database)+"?sslmode=disable")
}

// Exec runs a command inside the container, so pg_dump has the version of the server. The socket uses
// trust authentication, so no password appears on a command line.
func (p *Postgres) Exec(ctx context.Context, command ...string) (string, error) {
	if p.container == nil {
		return "", errors.New("test: the runner cluster has no container to run a command in")
	}
	code, reader, err := p.container.Exec(ctx, command, exec.Multiplexed())
	if err != nil {
		return "", err
	}
	var output bytes.Buffer
	if _, err := io.Copy(&output, reader); err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("%s exited with %d", command[0], code)
	}
	return output.String(), nil
}
