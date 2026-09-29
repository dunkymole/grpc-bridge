package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"syscall"
)

var processBridgeBinary string

func TestMain(m *testing.M) {
	if runtime.GOOS == "linux" {
		directory, err := os.MkdirTemp("", "grpc-bridge-process-")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		processBridgeBinary = filepath.Join(directory, "bridge")
		build := exec.Command("go", "build", "-o", processBridgeBinary, ".")
		if output, err := build.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "build bridge process test binary: %v\n%s", err, output)
			_ = os.RemoveAll(directory)
			os.Exit(2)
		}
		code := m.Run()
		_ = os.RemoveAll(directory)
		os.Exit(code)
	}
	os.Exit(m.Run())
}

type bridgeChild struct {
	command  *exec.Cmd
	done     chan struct{}
	waitErr  error
	baseURL  string
	readyURL string
	env      []string
}

func startBridgeChild(t *testing.T, upstream, admissionURL, grace string) *bridgeChild {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("process signal tests require Linux")
	}
	listen := freeAddress(t)
	health := freeAddress(t)
	values := map[string]string{
		"LISTEN":                       listen,
		"HEALTH_LISTEN":                health,
		"UPSTREAM":                     upstream,
		"TUNNEL_TOKEN":                 "",
		"ADMISSION_URL":                admissionURL,
		"DRAIN_GRACE_PERIOD":           grace,
		"MAX_TUNNEL_LIFETIME":          "1h",
		"MAX_ADMISSION_GRANT_LIFETIME": "1m",
		"ASSETS":                       filepath.Join("..", "..", "web", "dist"),
	}
	childEnv := replaceEnv(os.Environ(), values)
	command := exec.Command(processBridgeBinary)
	command.Env = childEnv
	command.Stdout = io.Discard
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	child := &bridgeChild{
		command:  command,
		done:     make(chan struct{}),
		baseURL:  "http://" + listen,
		readyURL: "http://" + health + "/readyz",
		env:      childEnv,
	}
	go func() {
		child.waitErr = command.Wait()
		close(child.done)
	}()
	t.Cleanup(func() {
		select {
		case <-child.done:
		default:
			_ = command.Process.Kill()
			<-child.done
		}
	})
	waitHTTPStatus(t, child.readyURL, http.StatusOK, 5*time.Second)
	return child
}

func replaceEnv(base []string, values map[string]string) []string {
	result := make([]string, 0, len(base)+len(values))
	for _, entry := range base {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if _, replaced := values[key]; !replaced {
			result = append(result, entry)
		}
	}
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result
}

func freeAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func waitHTTPStatus(t *testing.T, url string, want int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	client := http.Client{Timeout: 300 * time.Millisecond}
	defer client.CloseIdleConnections()
	var last int
	for time.Now().Before(deadline) {
		response, err := client.Get(url)
		if err == nil {
			last = response.StatusCode
			_ = response.Body.Close()
			if last == want {
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("health endpoint %s did not return HTTP %d (last %d)", url, want, last)
}

func healthcheckCommand(t *testing.T, child *bridgeChild, success bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, processBridgeBinary, "-healthcheck")
	command.Env = child.env
	err := command.Run()
	if success && err != nil {
		t.Fatalf("private healthcheck failed for custom listener: %v", err)
	}
	if !success && err == nil {
		t.Fatal("healthcheck reported ready after drain began")
	}
}

func signalChild(t *testing.T, child *bridgeChild) {
	t.Helper()
	if err := child.command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("send SIGTERM: %v", err)
	}
}

func waitChildExit(t *testing.T, child *bridgeChild, timeout time.Duration) error {
	t.Helper()
	select {
	case <-child.done:
		return child.waitErr
	case <-time.After(timeout):
		t.Fatal("bridge process did not exit before timeout")
		return nil
	}
}

func startEchoBackend(t *testing.T) (string, <-chan struct{}) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{}, 8)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
				closed <- struct{}{}
			}()
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return listener.Addr().String(), closed
}

func establishChildTunnel(t *testing.T, child *bridgeChild, target string) (net.Conn, *bufio.Reader) {
	t.Helper()
	conn, reader, response := rawHandshake(t, child.baseURL, target, "")
	if response.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		t.Fatalf("tunnel handshake returned %s", response.Status)
	}
	return conn, reader
}

func echoThroughTunnel(t *testing.T, conn net.Conn, reader *bufio.Reader, value string) {
	t.Helper()
	if _, err := conn.Write(clientFrame(2, true, []byte(value))); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var head [2]byte
	if _, err := io.ReadFull(reader, head[:]); err != nil {
		t.Fatal(err)
	}
	if head[0] != 0x82 || int(head[1]&0x7f) != len(value) {
		t.Fatalf("unexpected echo frame header %x", head)
	}
	data := make([]byte, len(value))
	if _, err := io.ReadFull(reader, data); err != nil || string(data) != value {
		t.Fatalf("echo mismatch: %q, %v", data, err)
	}
}

func TestProcessGracefulDrainKeepsLivenessAndActiveTunnel(t *testing.T) {
	backend, backendClosed := startEchoBackend(t)
	child := startBridgeChild(t, backend, "", "5s")
	healthcheckCommand(t, child, true)
	conn, reader := establishChildTunnel(t, child, backend)
	signalChild(t, child)
	waitHTTPStatus(t, child.readyURL, http.StatusServiceUnavailable, 2*time.Second)
	waitHTTPStatus(t, child.baseURL+"/livez", http.StatusOK, time.Second)
	waitHTTPStatus(t, child.baseURL+"/readyz", http.StatusServiceUnavailable, time.Second)
	healthcheckCommand(t, child, false)
	metricsResponse, err := http.Get(child.baseURL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	metricsData, err := io.ReadAll(metricsResponse.Body)
	_ = metricsResponse.Body.Close()
	if err != nil || !bytes.Contains(metricsData, []byte("bridge_draining 1\n")) {
		t.Fatalf("drain state missing from metrics: %v\n%s", err, metricsData)
	}
	rejectedConn, _, response := rawHandshake(t, child.baseURL, backend, "")
	_ = response.Body.Close()
	_ = rejectedConn.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("new tunnel was not rejected during drain: HTTP %d", response.StatusCode)
	}
	echoThroughTunnel(t, conn, reader, "existing tunnel completes during grace")
	started := time.Now()
	_ = conn.Close()
	select {
	case <-backendClosed:
	case <-time.After(time.Second):
		t.Fatal("upstream leg remained open after the client tunnel closed")
	}
	if err := waitChildExit(t, child, 4*time.Second); err != nil {
		t.Fatalf("graceful process exit failed: %v", err)
	}
	if elapsed := time.Since(started); elapsed >= 5*time.Second {
		t.Fatalf("empty drain waited for grace deadline: %s", elapsed)
	}
}

func TestProcessDrainDeadlineForcesBothTunnelLegsClosed(t *testing.T) {
	backend, backendClosed := startEchoBackend(t)
	child := startBridgeChild(t, backend, "", "700ms")
	conn, reader := establishChildTunnel(t, child, backend)
	signalChild(t, child)
	waitHTTPStatus(t, child.readyURL, http.StatusServiceUnavailable, 2*time.Second)
	echoThroughTunnel(t, conn, reader, "still alive during grace")
	select {
	case <-child.done:
		t.Fatalf("process exited before grace period: %v", child.waitErr)
	case <-time.After(150 * time.Millisecond):
	}
	if err := waitChildExit(t, child, 2*time.Second); err != nil {
		t.Fatalf("forced shutdown returned an error: %v", err)
	}
	select {
	case <-backendClosed:
	case <-time.After(time.Second):
		t.Fatal("forced shutdown leaked its upstream leg")
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("forced shutdown left the client leg open")
	}
}

func TestProcessSecondSignalForcesDrainImmediately(t *testing.T) {
	backend, backendClosed := startEchoBackend(t)
	child := startBridgeChild(t, backend, "", "1m")
	conn, reader := establishChildTunnel(t, child, backend)
	signalChild(t, child)
	waitHTTPStatus(t, child.readyURL, http.StatusServiceUnavailable, 2*time.Second)
	echoThroughTunnel(t, conn, reader, "before second signal")
	started := time.Now()
	signalChild(t, child)
	if err := waitChildExit(t, child, 2*time.Second); err != nil {
		t.Fatalf("second-signal shutdown returned an error: %v", err)
	}
	if elapsed := time.Since(started); elapsed >= 2*time.Second {
		t.Fatalf("second signal did not force prompt exit: %s", elapsed)
	}
	select {
	case <-backendClosed:
	case <-time.After(time.Second):
		t.Fatal("second signal leaked its upstream leg")
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("second signal left the client leg open")
	}
}

func TestProcessSecondSignalCancelsBlockedAdmissionImmediately(t *testing.T) {
	backend, backendClosed := startEchoBackend(t)
	entered := make(chan struct{}, 1)
	blocked := make(chan struct{})
	var admissions atomic.Int32
	admission := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if admissions.Add(1) > 1 {
			entered <- struct{}{}
			select {
			case <-blocked:
			case <-r.Context().Done():
			}
		}
		_, _ = fmt.Fprintf(w, `{"version":1,"subject":"process-test","target":%q,"expires_at":%d}`, backend, time.Now().Add(30*time.Second).Unix())
	}))
	defer admission.Close()
	defer close(blocked)
	child := startBridgeChild(t, backend, admission.URL, "1m")
	tunnelConn, tunnelReader, response := rawHandshake(t, child.baseURL, backend, "accepted.jwt")
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("initial tunnel handshake returned %s", response.Status)
	}
	result := make(chan int, 1)
	go func() {
		conn, _, response := rawHandshake(t, child.baseURL, backend, "process.jwt")
		defer conn.Close()
		result <- response.StatusCode
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("handshake did not reach admission verifier")
	}
	signalChild(t, child)
	waitHTTPStatus(t, child.readyURL, http.StatusServiceUnavailable, 2*time.Second)
	started := time.Now()
	signalChild(t, child)
	if err := waitChildExit(t, child, time.Second); err != nil {
		t.Fatalf("second signal did not cancel a pending admission: %v", err)
	}
	if time.Since(started) >= time.Second {
		t.Fatal("second signal waited for the graceful deadline")
	}
	_ = tunnelConn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := tunnelReader.ReadByte(); err == nil {
		t.Fatal("second signal left the established tunnel open")
	}
	_ = tunnelConn.Close()
	select {
	case status := <-result:
		if status == http.StatusSwitchingProtocols {
			t.Fatal("pending admission upgraded after forced shutdown")
		}
	case <-time.After(time.Second):
		t.Fatal("pending client request did not observe cancellation")
	}
	select {
	case <-backendClosed:
	case <-time.After(time.Second):
		t.Fatal("forced shutdown leaked the established upstream leg")
	}
}

func TestForcedCloseBypassesTLSCloseNotifyDeadlines(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	certificate := server.TLS.Certificates[0]
	defer server.Close()
	newUnreadTLSLeg := func() net.Conn {
		clientPipe, peerPipe := net.Pipe()
		peer := tls.Server(peerPipe, &tls.Config{Certificates: []tls.Certificate{certificate}})
		client := tls.Client(clientPipe, &tls.Config{InsecureSkipVerify: true, ServerName: "localhost"})
		peerHandshake := make(chan error, 1)
		go func() { peerHandshake <- peer.Handshake() }()
		if err := client.Handshake(); err != nil {
			t.Fatal(err)
		}
		if err := <-peerHandshake; err != nil {
			t.Fatal(err)
		}
		return client
	}
	clientTLS := newUnreadTLSLeg()
	upstreamTLS := newUnreadTLSLeg()
	tunnel := &activeTunnel{client: clientTLS, upstream: &countedConn{Conn: upstreamTLS}}
	done := make(chan struct{})
	go func() {
		tunnel.close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("forced close waited for TLS close_notify peers to read")
	}
}

type singleConnListener struct {
	conn    net.Conn
	mu      sync.Mutex
	used    bool
	closed  chan struct{}
	closeMu sync.Once
}

func (l *singleConnListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if !l.used {
		l.used = true
		conn := l.conn
		l.mu.Unlock()
		return conn, nil
	}
	l.mu.Unlock()
	<-l.closed
	return nil, net.ErrClosed
}
func (l *singleConnListener) Close() error {
	l.closeMu.Do(func() { close(l.closed) })
	return nil
}
func (l *singleConnListener) Addr() net.Addr { return l.conn.LocalAddr() }

func TestHTTPServerDrainRawClosesIdleTLSConnection(t *testing.T) {
	certificateServer := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	certificate := certificateServer.TLS.Certificates[0]
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(leaf)
	serverName := leaf.DNSNames[0]
	certificateServer.Close()

	serverPipe, clientPipe := net.Pipe()
	listener := &singleConnListener{conn: tls.Server(serverPipe, &tls.Config{Certificates: []tls.Certificate{certificate}}), closed: make(chan struct{})}
	g := newGateway(config{maxConnections: 2})
	g.setServing()
	mux := http.NewServeMux()
	healthRoutes(mux, g, "127.0.0.1:1")
	server := &http.Server{Handler: mux, ConnState: g.httpConnState}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	client := tls.Client(clientPipe, &tls.Config{RootCAs: roots, ServerName: serverName})
	if err := client.Handshake(); err != nil {
		t.Fatal(err)
	}
	request := "GET /livez HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n"
	if _, err := io.WriteString(client, request); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(client), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		g.mu.Lock()
		idle := false
		for _, state := range g.httpConns {
			idle = idle || state == http.StateIdle
		}
		g.mu.Unlock()
		if idle {
			break
		}
		time.Sleep(time.Millisecond)
	}
	g.mu.Lock()
	idle := false
	for _, state := range g.httpConns {
		idle = idle || state == http.StateIdle
	}
	g.mu.Unlock()
	if !idle {
		t.Fatal("TLS HTTP connection never became idle")
	}
	signals := make(chan os.Signal, 1)
	signals <- syscall.SIGTERM
	started := time.Now()
	shutdownOnSignal(g, server, &http.Server{}, signals, time.Second)
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("idle TLS close blocked shutdown for %s", elapsed)
	}
	select {
	case err := <-serveDone:
		if !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("Serve returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("HTTP Serve did not stop after drain")
	}
	_ = client.Close()
}

type delayedHijacker struct {
	entered chan struct{}
	release chan struct{}
	conn    net.Conn
	header  http.Header
}

func (w *delayedHijacker) Header() http.Header { return w.header }
func (w *delayedHijacker) WriteHeader(int)     {}
func (w *delayedHijacker) Write(p []byte) (int, error) {
	return len(p), nil
}
func (w *delayedHijacker) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	close(w.entered)
	<-w.release
	return w.conn, bufio.NewReadWriter(bufio.NewReader(strings.NewReader("")), bufio.NewWriter(io.Discard)), nil
}

func TestDrainClosesClientReturnedAfterForcedHijack(t *testing.T) {
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	backendPeer := make(chan net.Conn, 1)
	go func() {
		conn, acceptErr := backend.Accept()
		if acceptErr == nil {
			backendPeer <- conn
		}
	}()
	g := newGateway(config{upstream: backend.Addr().String(), maxConnections: 2})
	g.setServing()
	client, returnedConn := net.Pipe()
	writer := &delayedHijacker{entered: make(chan struct{}), release: make(chan struct{}), conn: returnedConn, header: make(http.Header)}
	request := httptest.NewRequest(http.MethodGet, "http://bridge/tunnel", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Key", "MDEyMzQ1Njc4OWFiY2RlZg==")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Protocol", protocol)
	served := make(chan struct{})
	go func() {
		g.ServeHTTP(writer, request)
		close(served)
	}()
	select {
	case <-writer.entered:
	case <-time.After(time.Second):
		t.Fatal("handler did not reach delayed hijacker")
	}
	var backendConn net.Conn
	select {
	case backendConn = <-backendPeer:
	case <-time.After(time.Second):
		t.Fatal("handler did not acquire upstream before hijack")
	}
	g.stop()
	close(writer.release)
	select {
	case <-served:
	case <-time.After(time.Second):
		t.Fatal("handler did not finish after the delayed hijack returned")
	}
	defer backendConn.Close()
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := client.Read(make([]byte, 1)); err == nil {
		t.Fatal("client socket returned after force-close was not closed")
	}
	_ = backendConn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := backendConn.Read(make([]byte, 1)); err == nil {
		t.Fatal("upstream socket was not closed")
	}
	g.mu.Lock()
	active, pending, principals := len(g.active), len(g.handshakes), len(g.principals)
	g.mu.Unlock()
	if active != 0 || pending != 0 || principals != 0 || len(g.slots) != 0 {
		t.Fatalf("forced cleanup incomplete: active=%d handshakes=%d principals=%d slots=%d", active, pending, principals, len(g.slots))
	}
}

func TestProcessDrainRechecksPendingAdmissionBeforeUpgrade(t *testing.T) {
	backend, backendClosed := startEchoBackend(t)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	admission := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-release
		_, _ = fmt.Fprintf(w, `{"version":1,"subject":"process-test","target":%q,"expires_at":%d}`, backend, time.Now().Add(30*time.Second).Unix())
	}))
	defer admission.Close()
	defer close(release)
	child := startBridgeChild(t, backend, admission.URL, "3s")
	result := make(chan struct {
		conn     net.Conn
		response *http.Response
	}, 1)
	go func() {
		conn, _, response := rawHandshake(t, child.baseURL, backend, "process.jwt")
		result <- struct {
			conn     net.Conn
			response *http.Response
		}{conn, response}
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("handshake did not reach admission verifier")
	}
	signalChild(t, child)
	select {
	case attempt := <-result:
		defer attempt.conn.Close()
		if attempt.response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("pending handshake upgraded after drain began: HTTP %d", attempt.response.StatusCode)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("pending handshake did not finish")
	}
	if err := waitChildExit(t, child, 2*time.Second); err != nil {
		t.Fatalf("drain did not finish after pending handshake ended: %v", err)
	}
	select {
	case <-backendClosed:
		t.Fatal("pending handshake dialed upstream after drain began")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestDrainWaitsForBothInflightAndActiveState(t *testing.T) {
	g := newGateway(config{maxConnections: 2})
	_, handshake, ok := g.beginHandshake(context.Background())
	if !ok {
		t.Fatal("initial handshake was rejected")
	}
	first, second := &memoryConn{}, &memoryConn{}
	tunnel := &activeTunnel{client: first, upstream: second}
	if !g.registerTunnel(tunnel) {
		t.Fatal("active tunnel was not registered")
	}
	g.beginDrain()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if g.waitForDrain(ctx) {
		t.Fatal("drain completed while a tunnel remained active")
	}
	g.forceCloseActive()
	g.unregisterTunnel(tunnel)
	g.finishHandshake(handshake)
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if !g.waitForDrain(ctx2) {
		t.Fatal("drain stayed blocked after both legs closed and tunnel unregistered")
	}
	g.mu.Lock()
	active, pending, principals := len(g.active), len(g.handshakes), len(g.principals)
	g.mu.Unlock()
	if active != 0 || pending != 0 || principals != 0 || len(g.slots) != 0 || g.metrics.forcedClosures.Load() != 1 {
		t.Fatalf("forced tunnel cleanup incomplete: active=%d handshakes=%d principals=%d slots=%d closures=%d", active, pending, principals, len(g.slots), g.metrics.forcedClosures.Load())
	}
}

func readFramePayload(reader *bufio.Reader) ([]byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(reader, head[:]); err != nil {
		return nil, err
	}
	length := uint64(head[1] & 0x7f)
	if length == 126 {
		var extended [2]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			return nil, err
		}
		length = uint64(binary.BigEndian.Uint16(extended[:]))
	} else if length == 127 {
		var extended [8]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			return nil, err
		}
		length = binary.BigEndian.Uint64(extended[:])
	}
	if length > maxFrame {
		return nil, fmt.Errorf("frame too large for test read: %d", length)
	}
	payload := make([]byte, int(length))
	_, err := io.ReadFull(reader, payload)
	return payload, err
}
