package health

import "sync/atomic"

// Gate fails closed: not ready until the boot marks it.
type Gate struct {
	ready atomic.Bool
}

func (g *Gate) MarkReady() { g.ready.Store(true) }

func (g *Gate) Ready() bool { return g.ready.Load() }
