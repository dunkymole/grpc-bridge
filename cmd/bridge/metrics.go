package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
)

// Fixed labels and buckets keep metrics memory independent of client input.
var failureReasons = [...]string{"handshake", "origin", "auth", "profile", "capacity", "destination", "destination_denied", "policy", "dial", "upgrade", "shutdown"}
var dialBounds = [...]float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10}

type metrics struct {
	attempts, opened, closed, toBackend, toClient atomic.Uint64
	drainCompletions, forcedClosures              atomic.Uint64
	forcedShutdowns                               atomic.Uint64
	draining                                      atomic.Int64
	established                                   atomic.Int64
	failures                                      [len(failureReasons)]atomic.Uint64
	dial                                          histogram
}

func (m *metrics) fail(reason string) {
	for i, label := range failureReasons {
		if label == reason {
			m.failures[i].Add(1)
			return
		}
	}
}

type histogram struct {
	mu      sync.Mutex
	buckets [len(dialBounds)]uint64
	count   uint64
	sum     float64
}

func (h *histogram) observe(seconds float64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.count++
	h.sum += seconds
	for i, bound := range dialBounds {
		if seconds <= bound {
			h.buckets[i]++
		}
	}
}

// Count bytes accepted by the destination writer, including partial writes.
// This measures payload forwarding, not peer consumption or TCP/TLS overhead.
type countedWriter struct {
	io.Writer
	bytes *atomic.Uint64
}

func (w countedWriter) Write(p []byte) (int, error) {
	n, err := w.Writer.Write(p)
	w.bytes.Add(uint64(n))
	return n, err
}

type countedConn struct {
	net.Conn
	bytes *atomic.Uint64
}

func (c *countedConn) Write(p []byte) (int, error) {
	return (countedWriter{c.Conn, c.bytes}).Write(p)
}

func (g *gateway) serveMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	m := &g.metrics
	header := func(name, help, kind string) {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, kind)
	}
	header("bridge_active_tunnels", "Occupied admission slots including backend connection establishment.", "gauge")
	fmt.Fprintf(w, "bridge_active_tunnels %d\n", len(g.slots))
	header("bridge_established_tunnels", "Currently established WebSocket tunnels.", "gauge")
	fmt.Fprintf(w, "bridge_established_tunnels %d\n", m.established.Load())
	header("bridge_tunnel_capacity", "Configured maximum occupied admission slots.", "gauge")
	fmt.Fprintf(w, "bridge_tunnel_capacity %d\n", cap(g.slots))
	header("bridge_draining", "Whether the process has entered tunnel drain and will reject new tunnels.", "gauge")
	fmt.Fprintf(w, "bridge_draining %d\n", m.draining.Load())
	for _, item := range []struct {
		name, help string
		value      uint64
	}{
		{"bridge_drain_graceful_completions_total", "Shutdown drains that completed after active tunnels and handshakes ended before the grace deadline.", m.drainCompletions.Load()},
		{"bridge_drain_forced_closures_total", "Active tunnels closed because the drain grace period expired or a second shutdown signal arrived.", m.forcedClosures.Load()},
		{"bridge_drain_forced_shutdowns_total", "Shutdowns forced by a second signal or an expired drain grace period.", m.forcedShutdowns.Load()},
	} {
		header(item.name, item.help, "counter")
		fmt.Fprintf(w, "%s %d\n", item.name, item.value)
	}
	for _, item := range []struct {
		name, help string
		value      uint64
	}{
		{"bridge_connection_attempts_total", "Requests reaching the tunnel handler, including rejected handshakes.", m.attempts.Load()},
		{"bridge_connections_opened_total", "WebSocket upgrade responses successfully flushed.", m.opened.Load()},
		{"bridge_connections_closed_total", "Established tunnel handlers that have finished, for any reason.", m.closed.Load()},
	} {
		header(item.name, item.help, "counter")
		fmt.Fprintf(w, "%s %d\n", item.name, item.value)
	}
	header("bridge_connection_failures_total", "Failed connection establishments by bounded reason; excludes failures after upgrade.", "counter")
	for i, reason := range failureReasons {
		fmt.Fprintf(w, "bridge_connection_failures_total{reason=%q} %d\n", reason, m.failures[i].Load())
	}
	header("bridge_bytes_forwarded_total", "Inner payload bytes accepted by destination writes, excluding WebSocket framing and controls.", "counter")
	fmt.Fprintf(w, "bridge_bytes_forwarded_total{direction=\"to_backend\"} %d\nbridge_bytes_forwarded_total{direction=\"to_client\"} %d\n", m.toBackend.Load(), m.toClient.Load())
	header("bridge_backend_dial_duration_seconds", "Backend dial latency including DNS and optional TLS/ALPN, for successful and failed tunnel dials; excludes health probes.", "histogram")
	m.dial.mu.Lock()
	buckets, count, sum := m.dial.buckets, m.dial.count, m.dial.sum
	m.dial.mu.Unlock()
	for i, bound := range dialBounds {
		fmt.Fprintf(w, "bridge_backend_dial_duration_seconds_bucket{le=\"%g\"} %d\n", bound, buckets[i])
	}
	fmt.Fprintf(w, "bridge_backend_dial_duration_seconds_bucket{le=\"+Inf\"} %d\nbridge_backend_dial_duration_seconds_sum %g\nbridge_backend_dial_duration_seconds_count %d\n", count, sum, count)
}
