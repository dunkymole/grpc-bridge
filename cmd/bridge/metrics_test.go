package main

import (
	"errors"
	"io"
	"net"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type partialWriter struct{}

func (partialWriter) Write(p []byte) (int, error) { return 2, io.ErrClosedPipe }

func TestMetricPayloadAccounting(t *testing.T) {
	var count atomic.Uint64
	if err := writeAll(countedWriter{partialWriter{}, &count}, []byte("hello")); !errors.Is(err, io.ErrClosedPipe) || count.Load() != 2 {
		t.Fatalf("partial write: %v, %d", err, count.Load())
	}
	count.Store(0)
	s := socket{conn: &memoryConn{}, downstreamBytes: &count}
	for _, op := range []byte{9, 10} {
		if err := s.writeFrame(op, []byte("control")); err != nil {
			t.Fatal(err)
		}
	}
	if count.Load() != 0 {
		t.Fatal("counted control payload")
	}
	if err := s.writeFrame(2, []byte("payload")); err != nil {
		t.Fatal(err)
	}
	if count.Load() != 7 {
		t.Fatal("counted framing or omitted payload")
	}
}

func TestFailedDialAndRejectionMetrics(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	g := newGateway(config{upstream: address, maxConnections: 1})
	w := httptest.NewRecorder()
	g.ServeHTTP(w, request())
	if w.Code != 502 {
		t.Fatal(w.Code)
	}
	g.token = "secret"
	g.ServeHTTP(httptest.NewRecorder(), request())
	metrics := httptest.NewRecorder()
	g.serveMetrics(metrics, httptest.NewRequest("GET", "/metrics", nil))
	for _, line := range []string{
		"bridge_active_tunnels 0\n", "bridge_established_tunnels 0\n",
		"bridge_connection_attempts_total 2\n", "bridge_connections_opened_total 0\n",
		"bridge_connection_failures_total{reason=\"dial\"} 1\n",
		"bridge_connection_failures_total{reason=\"auth\"} 1\n",
		"bridge_backend_dial_duration_seconds_count 1\n",
		"bridge_backend_dial_duration_seconds_bucket{le=\"+Inf\"} 1\n",
	} {
		if !strings.Contains(metrics.Body.String(), line) {
			t.Errorf("missing %s", line)
		}
	}
	if strings.Contains(metrics.Body.String(), address) || strings.Contains(metrics.Body.String(), "secret") {
		t.Fatal("metrics leaked configuration")
	}
}

func TestHistogramConcurrentScrapes(t *testing.T) {
	g := newGateway(config{maxConnections: 2})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				g.metrics.dial.observe(.025)
				g.metrics.attempts.Add(1)
				g.serveMetrics(httptest.NewRecorder(), httptest.NewRequest("GET", "/metrics", nil))
			}
		}()
	}
	wg.Wait()
	w := httptest.NewRecorder()
	g.serveMetrics(w, httptest.NewRequest("GET", "/metrics", nil))
	for _, line := range []string{
		"# TYPE bridge_backend_dial_duration_seconds histogram\n",
		"bridge_backend_dial_duration_seconds_bucket{le=\"0.01\"} 0\n",
		"bridge_backend_dial_duration_seconds_bucket{le=\"0.025\"} 400\n",
		"bridge_backend_dial_duration_seconds_bucket{le=\"+Inf\"} 400\n",
		"bridge_backend_dial_duration_seconds_count 400\n",
	} {
		if !strings.Contains(w.Body.String(), line) {
			t.Errorf("missing %s", line)
		}
	}
}
