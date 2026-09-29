package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAdmissionRequestAndGrantAreTargetBound(t *testing.T) {
	target := "backend.internal:443"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("unexpected admission request: %s %s", r.Method, r.URL.String())
		}
		var request admissionRequest
		if err := decodeStrictJSON(readBody(t, r), &request); err != nil {
			t.Fatal(err)
		}
		if request != (admissionRequest{Version: 1, Credential: "secret.jwt", Target: target}) {
			t.Fatalf("unexpected request: %#v", request)
		}
		_ = json.NewEncoder(w).Encode(admissionResponse{
			Version: 1, Subject: "tenant/user-7", Target: target, ExpiresAt: time.Now().Add(2 * time.Minute).Unix(),
		})
	}))
	defer server.Close()
	g := newGateway(config{maxConnections: 1, admissionURL: server.URL})
	grant, status := g.authorizeTarget(context.Background(), "secret.jwt", target)
	if status != 0 || grant.subject != "tenant/user-7" || !grant.expires.After(time.Now()) {
		t.Fatalf("grant was not accepted: %#v %d", grant, status)
	}
}

func TestAdmissionRejectsMalformedAndOutOfScopeGrants(t *testing.T) {
	target := "backend.internal:443"
	validExpiry := time.Now().Add(30 * time.Second).Unix()
	cases := []struct {
		name string
		body string
	}{
		{"wrong target", fmt.Sprintf(`{"version":1,"subject":"u","target":"other.internal:443","expires_at":%d}`, validExpiry)},
		{"missing expiry", `{"version":1,"subject":"u","target":"backend.internal:443"}`},
		{"expired", `{"version":1,"subject":"u","target":"backend.internal:443","expires_at":1}`},
		{"too long", fmt.Sprintf(`{"version":1,"subject":"u","target":"backend.internal:443","expires_at":%d}`, time.Now().Add(2*time.Hour).Unix())},
		{"unknown key", fmt.Sprintf(`{"version":1,"subject":"u","target":"backend.internal:443","expires_at":%d,"admin":true}`, validExpiry)},
		{"duplicate key", fmt.Sprintf(`{"version":1,"subject":"u","subject":"v","target":"backend.internal:443","expires_at":%d}`, validExpiry)},
		{"case shadow", fmt.Sprintf(`{"version":1,"subject":"u","SUBJECT":"v","target":"backend.internal:443","expires_at":%d}`, validExpiry)},
		{"invalid subject", fmt.Sprintf(`{"version":1,"subject":"u\nadmin","target":"backend.internal:443","expires_at":%d}`, validExpiry)},
		{"multiple values", fmt.Sprintf(`{"version":1,"subject":"u","target":"backend.internal:443","expires_at":%d} {}`, validExpiry)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			g := newGateway(config{maxConnections: 1, admissionURL: server.URL, maxGrantLifetime: time.Minute})
			if grant, status := g.authorizeTarget(context.Background(), "jwt", target); status != http.StatusForbidden || grant.subject != "" {
				t.Fatalf("invalid grant accepted: %#v status %d", grant, status)
			}
		})
	}
}

func TestAdmissionFailureStatusRedirectAndBodyLimit(t *testing.T) {
	var redirected atomic.Bool
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Store(true) }))
	defer second.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, second.URL, http.StatusFound)
	}))
	defer redirect.Close()
	g := newGateway(config{maxConnections: 1, admissionURL: redirect.URL})
	if _, status := g.authorizeTarget(context.Background(), "jwt", "target:1"); status != http.StatusServiceUnavailable || redirected.Load() {
		t.Fatalf("redirect was followed or not treated as outage: %d %t", status, redirected.Load())
	}

	large := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("x", maxAdmissionBody+1))
	}))
	defer large.Close()
	g.admissionURL = large.URL
	if _, status := g.authorizeTarget(context.Background(), "jwt", "target:1"); status != http.StatusServiceUnavailable {
		t.Fatalf("oversized response accepted: %d", status)
	}
}

func TestStrictAdmissionJSONRejectsInvalidBytesAndCaseAliases(t *testing.T) {
	for _, body := range [][]byte{
		[]byte(`{"subject":"a","SUBJECT":"b"}`),
		{'{', '"', 's', 'u', 'b', 'j', 'e', 'c', 't', '"', ':', '"', 0xff, '"', '}'},
	} {
		var value struct {
			Subject string `json:"subject"`
		}
		if err := decodeStrictJSON(body, &value); err == nil {
			t.Fatalf("accepted ambiguous/invalid JSON: %q", body)
		}
	}
}

func TestPrincipalQuotaIsAtomicAndReleasedOnce(t *testing.T) {
	g := newGateway(config{maxConnections: 2, maxPerPrincipal: 1})
	const attempts = 40
	results := make(chan func(), attempts)
	for range attempts {
		go func() {
			release, ok := g.reservePrincipalForTest("tenant/user")
			if !ok {
				results <- nil
				return
			}
			results <- release
		}()
	}
	accepted := 0
	var release func()
	for range attempts {
		if current := <-results; current != nil {
			accepted++
			release = current
		}
	}
	if accepted != 1 {
		t.Fatalf("quota admitted %d simultaneous connections, want one", accepted)
	}
	release()
	if !g.acquirePrincipal("sibling") || g.principals["sibling"] != 1 {
		t.Fatal("sibling principal was not isolated")
	}
	g.releasePrincipal("sibling")
	if g.acquirePrincipal("tenant/user") == false {
		t.Fatal("released quota remained occupied")
	}
	g.releasePrincipal("tenant/user")
	if len(g.principals) != 0 {
		t.Fatalf("principal quota leaked: %#v", g.principals)
	}
}

func (g *gateway) reservePrincipalForTest(subject string) (func(), bool) {
	if !g.acquirePrincipal(subject) {
		return nil, false
	}
	return func() { g.releasePrincipal(subject) }, true
}

func readBody(t *testing.T, r *http.Request) []byte {
	t.Helper()
	data, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestTunnelCredentialRejectsAmbiguity(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "http://bridge/tunnel", nil)
	r.Header.Add("Sec-WebSocket-Protocol", protocol+", auth.one.jwt")
	r.Header.Add("Sec-WebSocket-Protocol", "auth.two.jwt")
	if _, status := tunnelCredential(r, "", true); status != http.StatusBadRequest {
		t.Fatalf("duplicate credentials accepted: %d", status)
	}
	r = httptest.NewRequest(http.MethodGet, "http://bridge/tunnel", nil)
	r.Header.Set("Sec-WebSocket-Protocol", protocol+", auth.bad/token")
	if _, status := tunnelCredential(r, "", true); status != http.StatusUnauthorized {
		t.Fatalf("invalid subprotocol credential accepted: %d", status)
	}
}

func TestAdmissionURLRequiresTLSOutsideLoopback(t *testing.T) {
	for _, tc := range []struct {
		url string
		ok  bool
	}{
		{"https://admission.example/check", true},
		{"http://127.0.0.1:8081/check", true},
		{"http://localhost:8081/check", true},
		{"http://admission.example/check", false},
		{"https://user:secret@admission.example/check", false},
		{"https://admission.example/check#frag", false},
	} {
		err := validateAdmissionURL(tc.url)
		if (err == nil) != tc.ok {
			t.Fatalf("validateAdmissionURL(%q) = %v", tc.url, err)
		}
	}
}

func TestAdmissionDecodeErrorsDoNotLeakCredential(t *testing.T) {
	g := newGateway(config{maxConnections: 1, admissionURL: "://invalid"})
	if _, status := g.authorizeTarget(context.Background(), "top.secret.jwt", "target:1"); status != http.StatusServiceUnavailable {
		t.Fatal(status)
	}
	if err := decodeStrictJSON([]byte(`{"unexpected":true}`), &admissionResponse{}); err == nil || errors.Is(err, context.Canceled) {
		t.Fatal("unknown field was not rejected")
	}
}

func TestAdmissionDenialAndUnauthorizedDestinationNeverDialOrUpgrade(t *testing.T) {
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	policy := filepath.Join(t.TempDir(), "targets.json")
	if err := os.WriteFile(policy, []byte(fmt.Sprintf(`{"targets":{%q:{"tls":false}}}`, backend.Addr().String())), 0600); err != nil {
		t.Fatal(err)
	}
	var admissionCalls atomic.Int32
	denied := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		admissionCalls.Add(1)
		http.Error(w, "denied", http.StatusUnauthorized)
	}))
	defer denied.Close()
	g := newGateway(config{upstream: "default.internal:50051", targetsFile: policy, admissionURL: denied.URL, maxConnections: 2})
	server := httptest.NewServer(g)
	defer server.Close()

	for _, tc := range []struct {
		name, target string
		status       int
		calls        int32
	}{
		{"verifier denied", backend.Addr().String(), http.StatusUnauthorized, 1},
		{"static allowlist denied", "127.0.0.1:1", http.StatusForbidden, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn, _, response := rawHandshake(t, server.URL, tc.target, "secret.jwt")
			defer conn.Close()
			if response.StatusCode != tc.status {
				t.Fatalf("got HTTP %d, want %d", response.StatusCode, tc.status)
			}
			body, _ := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if strings.Contains(response.Header.Get("Sec-WebSocket-Protocol"), "secret") || strings.Contains(string(body), "secret") {
				t.Fatal("credential was reflected in the response")
			}
			if got := admissionCalls.Load(); got != tc.calls {
				t.Fatalf("admission call count %d, want %d", got, tc.calls)
			}
		})
	}
	accepted := make(chan net.Conn, 1)
	acceptErr := make(chan error, 1)
	go func() {
		conn, err := backend.Accept()
		if err != nil {
			acceptErr <- err
			return
		}
		accepted <- conn
	}()
	select {
	case conn := <-accepted:
		conn.Close()
		t.Fatal("unauthorized handshake dialed the backend")
	case err := <-acceptErr:
		t.Fatalf("unexpected backend accept error: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestAdmissionQuotaIsolatedAndGrantExpiryClosesBothTunnelLegs(t *testing.T) {
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	var backendDials atomic.Int32
	go func() {
		for {
			conn, err := backend.Accept()
			if err != nil {
				return
			}
			backendDials.Add(1)
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	policy := filepath.Join(t.TempDir(), "targets.json")
	if err := os.WriteFile(policy, []byte(fmt.Sprintf(`{"targets":{%q:{"tls":false}}}`, backend.Addr().String())), 0600); err != nil {
		t.Fatal(err)
	}
	admission := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request admissionRequest
		if err := decodeStrictJSON(readBody(t, r), &request); err != nil {
			t.Errorf("bad admission request: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		subject := "tenant/alpha"
		if request.Credential == "beta.jwt" {
			subject = "tenant/beta"
		}
		_ = json.NewEncoder(w).Encode(admissionResponse{Version: 1, Subject: subject, Target: request.Target, ExpiresAt: time.Now().Add(4 * time.Second).Unix()})
	}))
	defer admission.Close()
	g := newGateway(config{upstream: "default.internal:50051", targetsFile: policy, admissionURL: admission.URL, maxConnections: 4, maxPerPrincipal: 1, maxGrantLifetime: 10 * time.Second, maxTunnelLifetime: time.Minute})
	server := httptest.NewServer(g)
	defer server.Close()

	alpha, _, response := rawHandshake(t, server.URL, backend.Addr().String(), "alpha.jwt")
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("initial admission failed: %s", response.Status)
	}
	if got := response.Header.Get("Sec-WebSocket-Protocol"); got != protocol {
		t.Fatalf("server reflected credential or selected wrong protocol: %q", got)
	}
	second, _, response := rawHandshake(t, server.URL, backend.Addr().String(), "alpha.jwt")
	second.Close()
	if response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("same principal quota not enforced: %s", response.Status)
	}
	beta, _, response := rawHandshake(t, server.URL, backend.Addr().String(), "beta.jwt")
	if response.StatusCode != http.StatusSwitchingProtocols {
		beta.Close()
		t.Fatalf("sibling principal was blocked: %s", response.Status)
	}
	defer beta.Close()

	if _, err := alpha.Write(clientFrame(2, true, []byte("echo"))); err != nil {
		t.Fatal(err)
	}
	alpha.SetReadDeadline(time.Now().Add(6 * time.Second))
	reader := bufio.NewReader(alpha)
	_ = reader
	var frameHeader [2]byte
	if _, err := io.ReadFull(reader, frameHeader[:]); err != nil {
		t.Fatalf("unexpired tunnel stopped before grant deadline: %v", err)
	}
	if frameHeader[0] != 0x82 || frameHeader[1] != 4 {
		t.Fatalf("backend did not echo opaque data: %x", frameHeader)
	}
	var echoed [4]byte
	if _, err := io.ReadFull(reader, echoed[:]); err != nil || string(echoed[:]) != "echo" {
		t.Fatalf("invalid backend echo %q: %v", echoed, err)
	}
	if _, err := io.ReadFull(reader, frameHeader[:]); err == nil {
		t.Fatal("grant expiry did not close the active tunnel")
	}
	alpha.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		g.mu.Lock()
		principals := len(g.principals)
		g.mu.Unlock()
		if principals == 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	g.mu.Lock()
	remaining := len(g.principals)
	g.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("principal quotas leaked after grant expiry: %#v", g.principals)
	}
	if backendDials.Load() != 2 {
		t.Fatalf("same-principal denial dialed backend or sibling was not admitted: %d dials", backendDials.Load())
	}
}

func TestAdmissionQuotaReleasesAfterUpstreamDialFailure(t *testing.T) {
	// Select an address with no listener, while retaining it in the static
	// destination policy. Each request reaches admission and then fails its
	// upstream dial; the same subject must be able to retry immediately.
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	target := probe.Addr().String()
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}
	policy := filepath.Join(t.TempDir(), "targets.json")
	if err := os.WriteFile(policy, []byte(fmt.Sprintf(`{"targets":{%q:{"tls":false}}}`, target)), 0600); err != nil {
		t.Fatal(err)
	}
	var admissionCalls atomic.Int32
	admission := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		admissionCalls.Add(1)
		var request admissionRequest
		if err := decodeStrictJSON(readBody(t, r), &request); err != nil {
			t.Errorf("bad admission request: %v", err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(admissionResponse{Version: 1, Subject: "retryable", Target: request.Target, ExpiresAt: time.Now().Add(time.Minute).Unix()})
	}))
	defer admission.Close()
	g := newGateway(config{upstream: "default.internal:50051", targetsFile: policy, admissionURL: admission.URL, maxConnections: 2, maxPerPrincipal: 1, maxGrantLifetime: 2 * time.Minute, maxTunnelLifetime: time.Minute})
	server := httptest.NewServer(g)
	defer server.Close()

	for attempt := 0; attempt < 2; attempt++ {
		conn, _, response := rawHandshake(t, server.URL, target, "retry.jwt")
		conn.Close()
		if response.StatusCode != http.StatusBadGateway {
			t.Fatalf("attempt %d returned %s, want upstream failure", attempt+1, response.Status)
		}
	}
	if got := admissionCalls.Load(); got != 2 {
		t.Fatalf("admission calls %d, want 2 (principal slot leaked after failed dial)", got)
	}
	g.mu.Lock()
	remaining := len(g.principals)
	g.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("principal quota leaked after failed dials: %#v", g.principals)
	}
}

func rawHandshake(t *testing.T, serverURL, target, credential string) (net.Conn, *bufio.Reader, *http.Response) {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.DialTimeout("tcp", parsed.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	targetQuery := url.QueryEscape(target)
	_, _ = fmt.Fprintf(conn, "GET /tunnel?target=%s HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: %s, auth.%s\r\n\r\n", targetQuery, parsed.Host, protocol, credential)
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		conn.Close()
		t.Fatal(err)
	}
	return conn, reader, response
}
