package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func loadEchoBackend(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	dials := new(atomic.Int32)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			dials.Add(1)
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	return listener.Addr().String(), dials
}

func loadEcho(conn net.Conn, reader *bufio.Reader) error {
	if err := conn.SetDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	if _, err := conn.Write(clientFrame(2, true, []byte("ok"))); err != nil {
		return err
	}
	frame := make([]byte, 4)
	if _, err := io.ReadFull(reader, frame); err != nil {
		return err
	}
	if !bytes.Equal(frame, []byte{0x82, 2, 'o', 'k'}) {
		return errors.New("invalid echo frame")
	}
	return nil
}

func awaitLoadCleanup(t *testing.T, g *gateway) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		g.mu.Lock()
		remaining := len(g.principals)
		g.mu.Unlock()
		if remaining == 0 && len(g.slots) == 0 && g.metrics.established.Load() == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("principal/tunnel accounting did not recover")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestAdmissionOutageDuringEstablishedTraffic(t *testing.T) {
	for _, mode := range []string{"unavailable", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			target, dials := loadEchoBackend(t)
			var outage atomic.Bool
			entered := make(chan struct{}, 8)
			admission := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if outage.Load() {
					entered <- struct{}{}
					if mode == "timeout" {
						<-r.Context().Done()
						return
					}
					http.Error(w, "unavailable", 503)
					return
				}
				_ = json.NewEncoder(w).Encode(admissionResponse{Version: 1, Subject: "healthy", Target: "demo", ExpiresAt: time.Now().Add(time.Minute).Unix()})
			}))
			defer admission.Close()
			g := newGateway(config{defaultTarget: "demo", targetsFile: testTargetsFile(t, target, false), admissionURL: admission.URL, maxConnections: 32, maxPerPrincipal: 2, maxGrantLifetime: 2 * time.Minute, maxTunnelLifetime: time.Minute})
			server := httptest.NewServer(g)
			defer server.Close()
			conn, reader, response := rawHandshake(t, server.URL, "demo", "healthy")
			defer conn.Close()
			if response.StatusCode != 101 {
				t.Fatal(response.Status)
			}
			outage.Store(true)
			var workers sync.WaitGroup
			for worker := 0; worker < 8; worker++ {
				workers.Add(1)
				go func() {
					defer workers.Done()
					failed, _, response := rawHandshake(t, server.URL, "demo", "new")
					defer failed.Close()
					defer response.Body.Close()
					if response.StatusCode != 503 {
						t.Errorf("outage returned %d, want 503", response.StatusCode)
					}
				}()
			}
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("outage requests did not start")
			}
			for frame := 0; frame < 100; frame++ {
				if err := loadEcho(conn, reader); err != nil {
					t.Fatal(err)
				}
			}
			workers.Wait()
			for index, reason := range failureReasons {
				if reason == "admission" && g.metrics.failures[index].Load() != 8 {
					t.Fatalf("admission failure metric = %d, want 8", g.metrics.failures[index].Load())
				}
			}
			if dials.Load() != 1 {
				t.Fatalf("failed admission dialed upstream: %d", dials.Load())
			}
			if err := loadEcho(conn, reader); err != nil {
				t.Fatal(err)
			}
			outage.Store(false)
			replacement, replacementReader, response := rawHandshake(t, server.URL, "demo", "recovered")
			defer replacement.Close()
			if response.StatusCode != 101 {
				t.Fatalf("admission failed after recovery: %s", response.Status)
			}
			if err := loadEcho(replacement, replacementReader); err != nil {
				t.Fatal(err)
			}
			replacement.Close()
			conn.Close()
			awaitLoadCleanup(t, g)
		})
	}
}

func TestTunnelLifetimeExpiresDuringContinuousTraffic(t *testing.T) {
	target, _ := loadEchoBackend(t)
	g := newGateway(config{defaultTarget: "demo", targetsFile: testTargetsFile(t, target, false), token: "token", maxConnections: 4, maxPerPrincipal: 1, maxTunnelLifetime: 500 * time.Millisecond})
	server := httptest.NewServer(g)
	defer server.Close()
	for cycle := 0; cycle < 3; cycle++ {
		started := time.Now()
		conn, reader, response := rawHandshake(t, server.URL, "demo", "token")
		t.Cleanup(func() { conn.Close() })
		if response.StatusCode != 101 {
			conn.Close()
			t.Fatal(response.Status)
		}
		deadline := time.Now().Add(3 * time.Second)
		frames := 0
		for {
			err := loadEcho(conn, reader)
			if err != nil {
				if time.Since(started) < 400*time.Millisecond {
					t.Fatalf("tunnel closed before its lifetime: %v", err)
				}
				var networkError net.Error
				if errors.As(err, &networkError) && networkError.Timeout() {
					t.Fatalf("traffic stalled instead of expiring: %v", err)
				}
				break
			}
			frames++
			if time.Now().After(deadline) {
				conn.Close()
				t.Fatal("traffic extended maximum tunnel lifetime")
			}
			time.Sleep(5 * time.Millisecond)
		}
		conn.Close()
		if frames == 0 {
			t.Fatal("no successful traffic before expiry")
		}
		awaitLoadCleanup(t, g)
	}
	for index, source := range expirationSources {
		if source == "lifetime" && g.metrics.expirations[index].Load() != 3 {
			t.Fatalf("lifetime expiry metric = %d, want 3", g.metrics.expirations[index].Load())
		}
	}
}
