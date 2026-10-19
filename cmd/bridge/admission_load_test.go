package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Exercise the real upgrade/relay path, not only the quota map. This is opaque
// tunnel traffic; RPC-shape/retry safety coverage belongs in the client harness.
func TestAdmissionQuotaStormDuringTrafficAndGrantExpiry(t *testing.T) {
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	var dials atomic.Int32
	go func() {
		for {
			conn, err := backend.Accept()
			if err != nil {
				return
			}
			dials.Add(1)
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	admission := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request admissionRequest
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			http.Error(w, "bad request", 400)
			return
		}
		if request.Credential == "denied" {
			http.Error(w, "denied", 403)
			return
		}
		expiry := time.Now().Add(time.Minute)
		if request.Credential == "alpha" {
			expiry = time.Now().Add(4 * time.Second)
		}
		_ = json.NewEncoder(w).Encode(admissionResponse{Version: 1, Subject: request.Credential, Target: request.Target, ExpiresAt: expiry.Unix()})
	}))
	defer admission.Close()
	g := newGateway(config{upstream: backend.Addr().String(), admissionURL: admission.URL, maxConnections: 128, maxPerPrincipal: 1, maxGrantLifetime: 2 * time.Minute, maxTunnelLifetime: time.Minute})
	server := httptest.NewServer(g)
	defer server.Close()
	alpha, _, response := rawHandshake(t, server.URL, backend.Addr().String(), "alpha")
	defer alpha.Close()
	if response.StatusCode != 101 {
		t.Fatal(response.Status)
	}
	beta, reader, response := rawHandshake(t, server.URL, backend.Addr().String(), "beta")
	defer beta.Close()
	if response.StatusCode != 101 {
		t.Fatal(response.Status)
	}
	var workers sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for attempt := 0; attempt < 8; attempt++ {
				credential, want := "alpha", http.StatusTooManyRequests
				if attempt%2 == 1 {
					credential, want = "denied", http.StatusForbidden
				}
				conn, _, response := rawHandshake(t, server.URL, backend.Addr().String(), credential)
				conn.Close()
				response.Body.Close()
				if response.StatusCode != want {
					t.Errorf("denial returned %d, want %d", response.StatusCode, want)
				}
			}
		}()
	}
	for sequence := 0; sequence < 100; sequence++ {
		payload := []byte(fmt.Sprintf("sibling-%04d", sequence))
		if _, err := beta.Write(clientFrame(2, true, payload)); err != nil {
			t.Fatal(err)
		}
		frame := make([]byte, len(payload)+2)
		if _, err := io.ReadFull(reader, frame); err != nil {
			t.Fatal(err)
		}
		if frame[0] != 0x82 || int(frame[1]) != len(payload) || !bytes.Equal(frame[2:], payload) {
			t.Fatalf("corrupt sibling frame: %x", frame)
		}
	}
	workers.Wait()
	if dials.Load() != 2 {
		t.Fatalf("denials dialed backend: %d", dials.Load())
	}
	alpha.SetReadDeadline(time.Now().Add(6 * time.Second))
	if _, err := alpha.Read(make([]byte, 1)); err == nil {
		t.Fatal("expired grant remained open")
	} else {
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			t.Fatalf("expiry was not observed before read deadline: %v", err)
		}
	}
	deadline := time.Now().Add(time.Second)
	for {
		g.mu.Lock()
		remaining := g.principals["alpha"]
		g.mu.Unlock()
		if remaining == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("expired principal quota leaked")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The sibling must still pass data after the other principal expires.
	if _, err := beta.Write(clientFrame(2, true, []byte("ok"))); err != nil {
		t.Fatal(err)
	}
	beta.SetReadDeadline(time.Now().Add(time.Second))
	frame := make([]byte, 4)
	if _, err := io.ReadFull(reader, frame); err != nil || !bytes.Equal(frame, []byte{0x82, 2, 'o', 'k'}) {
		t.Fatalf("sibling failed after expiry: %x %v", frame, err)
	}
	replacement, _, response := rawHandshake(t, server.URL, backend.Addr().String(), "alpha")
	defer replacement.Close()
	if response.StatusCode != 101 {
		t.Fatalf("released quota could not be reused: %s", response.Status)
	}
	replacement.Close()
	beta.Close()
	deadline = time.Now().Add(2 * time.Second)
	for {
		g.mu.Lock()
		remaining := len(g.principals)
		g.mu.Unlock()
		if remaining == 0 && len(g.slots) == 0 && g.metrics.established.Load() == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("tunnel or principal resources did not recover")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
