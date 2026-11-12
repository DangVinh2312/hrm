package test

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
)

const (
	messageQuery = 'Q'
	messageParse = 'P'
	messageSync  = 'S'
)

// WireProxy sits between the driver and PostgreSQL and records what the client sends. A round trip is a
// message the client waits on: one Query or one Sync, since the extended protocol ends a batch with Sync.
type WireProxy struct {
	listener net.Listener
	target   string

	mu         sync.Mutex
	statements []string
	roundTrips int
	closed     bool
	conns      []net.Conn
	done       sync.WaitGroup
	// held is open while Hold is in effect; nil means messages flow.
	held chan struct{}
}

// StartWireProxy listens on a free local port. Every connection through it must not use TLS.
func StartWireProxy(target string) (*WireProxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	proxy := &WireProxy{listener: listener, target: target}
	proxy.done.Add(1)
	go proxy.accept()
	return proxy, nil
}

// Address is the host:port to connect to.
func (p *WireProxy) Address() string { return p.listener.Addr().String() }

// Reset forgets what was recorded so far.
func (p *WireProxy) Reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.statements = nil
	p.roundTrips = 0
}

// Statements returns the text of each Query and Parse, in the order the client sent them.
func (p *WireProxy) Statements() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.statements...)
}

// RoundTrips counts the Query and Sync messages since the last Reset.
func (p *WireProxy) RoundTrips() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.roundTrips
}

// Hold stops forwarding in both directions, as a server that stopped answering. What the client sends is
// still recorded.
func (p *WireProxy) Hold() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.held == nil {
		p.held = make(chan struct{})
	}
}

// Release forwards what Hold kept back.
func (p *WireProxy) Release() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.held != nil {
		close(p.held)
		p.held = nil
	}
}

func (p *WireProxy) wait() {
	p.mu.Lock()
	held := p.held
	p.mu.Unlock()
	if held != nil {
		<-held
	}
}

// gate delays each write until the proxy is not held.
type gate struct {
	proxy *WireProxy
	to    io.Writer
}

func (g gate) Write(data []byte) (int, error) {
	g.proxy.wait()
	return g.to.Write(data)
}

// Close stops the listener and every open connection.
func (p *WireProxy) Close() error {
	p.Release()
	p.mu.Lock()
	p.closed = true
	conns := p.conns
	p.conns = nil
	p.mu.Unlock()
	err := p.listener.Close()
	for _, conn := range conns {
		err = errors.Join(err, ignoreClosed(conn.Close()))
	}
	p.done.Wait()
	return err
}

func ignoreClosed(err error) error {
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

func (p *WireProxy) track(conn net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false
	}
	p.conns = append(p.conns, conn)
	return true
}

func (p *WireProxy) accept() {
	defer p.done.Done()
	for {
		client, err := p.listener.Accept()
		if err != nil {
			return
		}
		if !p.track(client) {
			ignore(client.Close())
			return
		}
		p.done.Add(1)
		go p.serve(client)
	}
}

func (p *WireProxy) serve(client net.Conn) {
	defer p.done.Done()
	server, err := net.Dial("tcp", p.target)
	if err != nil {
		ignore(client.Close())
		return
	}
	if !p.track(server) {
		ignore(server.Close())
		return
	}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_, copied := io.Copy(gate{proxy: p, to: client}, server)
		ignore(copied)
		ignore(client.Close())
	}()
	p.record(client, gate{proxy: p, to: server})
	ignore(server.Close())
	<-finished
}

// ignore marks the close of a proxied connection, which the peer may already have ended.
func ignore(error) {}

// record copies client messages to the server. The first one, the startup message, has no type byte.
func (p *WireProxy) record(client io.Reader, server io.Writer) {
	startup, err := readMessage(client, false)
	if err != nil {
		return
	}
	if _, err := server.Write(startup); err != nil {
		return
	}
	for {
		message, err := readMessage(client, true)
		if err != nil {
			return
		}
		p.observe(message)
		if _, err := server.Write(message); err != nil {
			return
		}
	}
}

func readMessage(client io.Reader, typed bool) ([]byte, error) {
	headerLength := 4
	if typed {
		headerLength = 5
	}
	header := make([]byte, headerLength)
	if _, err := io.ReadFull(client, header); err != nil {
		return nil, err
	}
	length := int(binary.BigEndian.Uint32(header[headerLength-4:]))
	if length < 4 {
		return nil, io.ErrUnexpectedEOF
	}
	body := make([]byte, length-4)
	if _, err := io.ReadFull(client, body); err != nil {
		return nil, err
	}
	return append(header, body...), nil
}

func (p *WireProxy) observe(message []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	body := message[5:]
	switch message[0] {
	case messageQuery:
		p.roundTrips++
		p.statements = append(p.statements, cString(body))
	case messageParse:
		_, query, _ := strings.Cut(string(body), "\x00")
		p.statements = append(p.statements, cString([]byte(query)))
	case messageSync:
		p.roundTrips++
	}
}

func cString(body []byte) string {
	text, _, _ := strings.Cut(string(body), "\x00")
	return text
}
