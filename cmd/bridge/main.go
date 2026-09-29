// grpc-bridge is an application-blind WebSocket to TCP tunnel.
package main

import (
	"bufio"
	"context"
	"crypto/sha1"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

const protocol = "grpc-tunnel.v1"
const bufferSize = 16 * 1024
const maxFrame = 1 << 20

type config struct {
	upstream, origin, token string
	maxConnections          int
	upstreamTLS             bool
	targetsFile             string
	admissionURL            string
	maxPerPrincipal         int
	maxGrantLifetime        time.Duration
	maxTunnelLifetime       time.Duration
	admissionClient         *http.Client
	upstreamRoots           *x509.CertPool
}

type targetPolicy struct {
	TLS bool `json:"tls"`
}

// Read a bounded policy snapshot for each new destination selection. Operators
// can atomically replace the file without restarting existing connections.
func (g *gateway) destination(r *http.Request) (string, bool, int) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query["target"]) > 1 {
		return "", false, 400
	}
	target := query.Get("target")
	if target == "" {
		target = g.upstream
	}
	if len(target) > 320 {
		return "", false, 400
	}
	host, port, err := net.SplitHostPort(target)
	p, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || p < 1 || p > 65535 || host == "" || strings.ContainsAny(host, "/@?#\\ \t\r\n") {
		return "", false, 400
	}
	if target == g.upstream {
		return target, g.upstreamTLS, 0
	}
	if g.targetsFile == "" {
		return "", false, 403
	}
	file, err := os.Open(g.targetsFile)
	if err != nil {
		return "", false, 503
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(data) > 65536 {
		return "", false, 503
	}
	var policy struct {
		Targets map[string]targetPolicy `json:"targets"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&policy) != nil {
		return "", false, 503
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return "", false, 503
	}
	allowed, ok := policy.Targets[target]
	if !ok {
		return "", false, 403
	}
	return target, allowed.TLS, 0
}

type gateway struct {
	config
	slots       chan struct{}
	mu          sync.Mutex
	active      map[*activeTunnel]struct{}
	handshakes  map[*pendingHandshake]struct{}
	principals  map[string]int
	httpConns   map[net.Conn]http.ConnState
	httpClosing bool
	metrics     metrics
	draining    bool
	serving     bool
	changed     chan struct{}
}

type pendingHandshake struct {
	cancel context.CancelFunc
}

type activeTunnel struct {
	client, upstream net.Conn
	connMu           sync.Mutex
	closed           bool
	forced           atomic.Bool
}

func (t *activeTunnel) close() {
	t.connMu.Lock()
	t.closed = true
	client, upstream := t.client, t.upstream
	t.connMu.Unlock()
	closeTransportConn(client)
	closeTransportConn(upstream)
}

func (t *activeTunnel) setClient(client net.Conn) bool {
	t.connMu.Lock()
	defer t.connMu.Unlock()
	if t.closed {
		return false
	}
	t.client = client
	return true
}

// Close the transport socket directly. tls.Conn.Close may send close_notify
// using its own five-second write deadline, which would serialize forced
// shutdown across tunnels whose peers stopped reading.
func closeTransportConn(conn net.Conn) {
	switch c := conn.(type) {
	case nil:
		return
	case *countedConn:
		closeTransportConn(c.Conn)
	case *tls.Conn:
		_ = c.NetConn().Close()
	default:
		_ = c.Close()
	}
}

func newGateway(c config) *gateway {
	if c.maxPerPrincipal < 1 {
		c.maxPerPrincipal = 8
	}
	if c.maxGrantLifetime <= 0 {
		c.maxGrantLifetime = 15 * time.Minute
	}
	if c.maxTunnelLifetime <= 0 {
		c.maxTunnelLifetime = time.Hour
	}
	if c.admissionClient == nil {
		c.admissionClient = newAdmissionHTTPClient()
	}
	return &gateway{config: c, slots: make(chan struct{}, c.maxConnections), active: make(map[*activeTunnel]struct{}), handshakes: make(map[*pendingHandshake]struct{}), principals: make(map[string]int), httpConns: make(map[net.Conn]http.ConnState), changed: make(chan struct{})}
}

func (g *gateway) httpConnState(conn net.Conn, state http.ConnState) {
	g.mu.Lock()
	closeNow := false
	switch state {
	case http.StateNew, http.StateActive, http.StateIdle:
		if g.httpClosing {
			closeNow = true
		} else {
			g.httpConns[conn] = state
		}
	case http.StateHijacked, http.StateClosed:
		delete(g.httpConns, conn)
	}
	g.mu.Unlock()
	if closeNow {
		closeTransportConn(conn)
	}
}

func (g *gateway) closeHTTPConnections(idleOnly bool) {
	g.mu.Lock()
	if !idleOnly {
		g.httpClosing = true
	}
	connections := make([]net.Conn, 0, len(g.httpConns))
	for conn, state := range g.httpConns {
		if !idleOnly || state == http.StateIdle {
			connections = append(connections, conn)
		}
	}
	g.mu.Unlock()
	for _, conn := range connections {
		closeTransportConn(conn)
	}
}

func (g *gateway) signalStateLocked() {
	close(g.changed)
	g.changed = make(chan struct{})
}

func (g *gateway) beginHandshake(parent context.Context) (context.Context, *pendingHandshake, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.draining {
		return nil, nil, false
	}
	ctx, cancel := context.WithCancel(parent)
	handshake := &pendingHandshake{cancel: cancel}
	g.handshakes[handshake] = struct{}{}
	g.signalStateLocked()
	return ctx, handshake, true
}

func (g *gateway) finishHandshake(handshake *pendingHandshake) {
	g.mu.Lock()
	delete(g.handshakes, handshake)
	g.signalStateLocked()
	g.mu.Unlock()
	handshake.cancel()
}

func (g *gateway) isDraining() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.draining
}

func (g *gateway) setServing() {
	g.mu.Lock()
	g.serving = true
	g.signalStateLocked()
	g.mu.Unlock()
}

func (g *gateway) isReady() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.serving && !g.draining
}

func (g *gateway) beginDrain() {
	g.mu.Lock()
	var cancels []context.CancelFunc
	if !g.draining {
		g.draining = true
		g.metrics.draining.Store(1)
		for handshake := range g.handshakes {
			cancels = append(cancels, handshake.cancel)
		}
		g.signalStateLocked()
	}
	g.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (g *gateway) registerTunnel(tunnel *activeTunnel) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.draining {
		return false
	}
	g.active[tunnel] = struct{}{}
	g.signalStateLocked()
	return true
}

func (g *gateway) completeHandshake(handshake *pendingHandshake) bool {
	g.mu.Lock()
	if g.draining {
		g.mu.Unlock()
		return false
	}
	delete(g.handshakes, handshake)
	g.signalStateLocked()
	g.mu.Unlock()
	handshake.cancel()
	return true
}

func (g *gateway) unregisterTunnel(tunnel *activeTunnel) {
	g.mu.Lock()
	delete(g.active, tunnel)
	g.signalStateLocked()
	g.mu.Unlock()
}

func (g *gateway) waitForDrain(ctx context.Context) bool {
	for {
		g.mu.Lock()
		if len(g.active) == 0 && len(g.handshakes) == 0 {
			g.mu.Unlock()
			return true
		}
		changed := g.changed
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			return false
		case <-changed:
		}
	}
}

func (g *gateway) forceCloseActive() {
	g.mu.Lock()
	tunnels := make([]*activeTunnel, 0, len(g.active))
	for tunnel := range g.active {
		if tunnel.forced.CompareAndSwap(false, true) {
			tunnels = append(tunnels, tunnel)
		}
	}
	g.mu.Unlock()
	g.metrics.forcedClosures.Add(uint64(len(tunnels)))
	for _, tunnel := range tunnels {
		tunnel.close()
	}
}
func contains(value, token string) bool {
	for _, v := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(v), token) {
			return true
		}
	}
	return false
}

func tunnelCredential(r *http.Request, expectedToken string, admission bool) (string, int) {
	profiles, credentials := 0, 0
	credential := ""
	for _, value := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, item := range strings.Split(value, ",") {
			item = strings.TrimSpace(item)
			if item == protocol {
				profiles++
				continue
			}
			if strings.HasPrefix(item, "auth.") {
				credentials++
				credential = strings.TrimPrefix(item, "auth.")
			}
		}
	}
	if profiles != 1 || credentials > 1 {
		return "", http.StatusBadRequest
	}
	if admission {
		if credentials != 1 || !validTunnelCredential(credential) {
			return "", http.StatusUnauthorized
		}
		return credential, 0
	}
	if expectedToken != "" {
		if credentials != 1 || subtle.ConstantTimeCompare([]byte(credential), []byte(expectedToken)) != 1 {
			return "", http.StatusUnauthorized
		}
	}
	return credential, 0
}

func validTunnelCredential(credential string) bool {
	if credential == "" || len(credential) > maxCredentialBytes {
		return false
	}
	for _, char := range credential {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || strings.ContainsRune("-._~", char)) {
			return false
		}
	}
	return true
}

func (g *gateway) acquirePrincipal(subject string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.draining || g.principals[subject] >= g.maxPerPrincipal {
		return false
	}
	g.principals[subject]++
	return true
}

func (g *gateway) releasePrincipal(subject string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.principals[subject] <= 1 {
		delete(g.principals, subject)
		return
	}
	g.principals[subject]--
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/tunnel" {
		http.NotFound(w, r)
		return
	}
	g.metrics.attempts.Add(1)
	handshakeCtx, handshake, allowed := g.beginHandshake(r.Context())
	if !allowed {
		g.metrics.fail("shutdown")
		http.Error(w, "bridge is draining", http.StatusServiceUnavailable)
		return
	}
	handshakePending := true
	var heldSlot, heldPrincipal, activeRegistered bool
	var principal string
	var tunnel *activeTunnel
	var clientConn net.Conn
	var upstream net.Conn
	defer func() {
		if tunnel != nil {
			tunnel.close()
		} else {
			closeTransportConn(clientConn)
			closeTransportConn(upstream)
		}
		if heldPrincipal {
			g.releasePrincipal(principal)
		}
		if heldSlot {
			<-g.slots
		}
		if activeRegistered {
			g.unregisterTunnel(tunnel)
		}
		if handshakePending {
			g.finishHandshake(handshake)
		}
	}()
	failure := "upgrade"
	defer func() {
		if failure != "" {
			g.metrics.fail(failure)
		}
	}()
	reject := func(message string, status int, reason string) {
		failure = reason
		http.Error(w, message, status)
	}
	if r.Method != "GET" || !contains(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		reject("WebSocket upgrade required", http.StatusBadRequest, "handshake")
		return
	}
	key, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	if err != nil || len(key) != 16 || r.Header.Get("Sec-WebSocket-Version") != "13" {
		reject("invalid WebSocket handshake", 400, "handshake")
		return
	}
	// Exact origin allowlist, including scheme and port. Native clients omit Origin.
	if origin := r.Header.Get("Origin"); origin != "" && origin != g.origin {
		reject("origin denied", 403, "origin")
		return
	}
	credential, status := tunnelCredential(r, g.token, g.admissionURL != "")
	if status != 0 {
		reason := "auth"
		if status == http.StatusBadRequest {
			reason = "profile"
		}
		reject("invalid tunnel credentials or profile", status, reason)
		return
	}
	select {
	case g.slots <- struct{}{}:
		heldSlot = true
	default:
		reject("connection capacity reached", 503, "capacity")
		return
	}
	destination, useTLS, status := g.destination(r)
	if status != 0 {
		reject("destination unavailable or not allowed", status, map[int]string{400: "destination", 403: "destination_denied", 503: "policy"}[status])
		return
	}
	if g.isDraining() {
		reject("bridge is draining", http.StatusServiceUnavailable, "shutdown")
		return
	}
	principal = "anonymous"
	var grantExpiry time.Time
	if g.admissionURL != "" {
		grant, grantStatus := g.authorizeTarget(handshakeCtx, credential, destination)
		if grantStatus != 0 {
			failureReason := "admission"
			if grantStatus == http.StatusUnauthorized || grantStatus == http.StatusForbidden {
				failureReason = "auth"
			}
			reject("tunnel admission denied", grantStatus, failureReason)
			return
		}
		principal = grant.subject
		grantExpiry = grant.expires
	} else if g.token != "" {
		principal = "static"
	}
	if g.isDraining() {
		reject("bridge is draining", http.StatusServiceUnavailable, "shutdown")
		return
	}
	if !g.acquirePrincipal(principal) {
		reject("principal connection capacity reached", 429, "capacity")
		return
	}
	heldPrincipal = true
	authorizedAt := time.Now()
	tunnelDeadline := authorizedAt.Add(g.maxTunnelLifetime)
	if !grantExpiry.IsZero() && grantExpiry.Before(tunnelDeadline) {
		tunnelDeadline = grantExpiry
	}
	dialDeadline := time.Now().Add(5 * time.Second)
	if tunnelDeadline.Before(dialDeadline) {
		dialDeadline = tunnelDeadline
	}
	ctx, cancel := context.WithDeadline(handshakeCtx, dialDeadline)
	defer cancel()
	dialStart := time.Now()
	if useTLS {
		tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"h2"}, RootCAs: g.upstreamRoots}
		d := &tls.Dialer{NetDialer: &net.Dialer{}, Config: tlsConfig}
		upstream, err = d.DialContext(ctx, "tcp", destination)
		if err == nil && upstream.(*tls.Conn).ConnectionState().NegotiatedProtocol != "h2" {
			closeTransportConn(upstream)
			err = errors.New("upstream did not negotiate h2")
		}
	} else {
		upstream, err = (&net.Dialer{}).DialContext(ctx, "tcp", destination)
	}
	g.metrics.dial.observe(time.Since(dialStart).Seconds())
	if err != nil {
		reject("upstream unavailable", 502, "dial")
		return
	}
	upstream = &countedConn{Conn: upstream, bytes: &g.metrics.toBackend}
	tunnel = &activeTunnel{upstream: upstream}
	if !g.registerTunnel(tunnel) {
		failure = "shutdown"
		return
	}
	activeRegistered = true
	if !time.Now().Before(tunnelDeadline) {
		reject("tunnel grant expired", http.StatusForbidden, "auth")
		return
	}
	if g.isDraining() {
		reject("bridge is draining", http.StatusServiceUnavailable, "shutdown")
		return
	}
	h, ok := w.(http.Hijacker)
	if !ok {
		reject("upgrade unavailable", 500, "upgrade")
		return
	}
	conn, rw, err := h.Hijack()
	if err != nil {
		return
	}
	clientConn = conn
	if !tunnel.setClient(conn) {
		closeTransportConn(conn)
		clientConn = nil
		failure = "shutdown"
		return
	}
	clientConn = nil // the active tunnel now owns this socket
	if !time.Now().Before(tunnelDeadline) {
		// The peer can stall a response flush indefinitely here. The grant has
		// already expired, so closing is sufficient and releases both legs and
		// the admission slot through the normal defers.
		return
	}
	if !g.completeHandshake(handshake) {
		failure = "shutdown"
		return
	}
	handshakePending = false
	lifetimeTimer := time.AfterFunc(time.Until(tunnelDeadline), func() {
		tunnel.close()
	})
	defer lifetimeTimer.Stop()
	if !time.Now().Before(tunnelDeadline) {
		return
	}
	sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	writeDeadline := time.Now().Add(10 * time.Second)
	if tunnelDeadline.Before(writeDeadline) {
		writeDeadline = tunnelDeadline
	}
	conn.SetWriteDeadline(writeDeadline)
	fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\nSec-WebSocket-Protocol: %s\r\n\r\n", base64.StdEncoding.EncodeToString(sum[:]), protocol)
	if rw.Flush() != nil {
		return
	}
	if !time.Now().Before(tunnelDeadline) {
		return
	}
	failure = ""
	g.metrics.opened.Add(1)
	g.metrics.established.Add(1)
	defer func() { g.metrics.established.Add(-1); g.metrics.closed.Add(1) }()
	conn.SetDeadline(time.Time{})
	ws := &socket{conn: conn, reader: rw.Reader, downstreamBytes: &g.metrics.toClient}
	done := make(chan struct{})
	defer close(done)
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if ws.writeFrame(9, []byte("alive")) != nil {
					tunnel.close()
					return
				}
			}
		}
	}()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		defer tunnel.close()
		buf := make([]byte, bufferSize)
		for {
			n, e := upstream.Read(buf)
			if n > 0 {
				if ws.writeFrame(2, buf[:n]) != nil {
					return
				}
			}
			if e != nil {
				_ = ws.closeWith(1011)
				return
			}
		}
	}()
	err = ws.relay(upstream)
	if err != nil && !errors.Is(err, io.EOF) {
		_ = ws.closeWith(1002)
	}
	tunnel.close()
	<-finished
}

func (g *gateway) stop() {
	g.beginDrain()
	g.forceCloseActive()
}

type socket struct {
	conn            net.Conn
	reader          *bufio.Reader
	writeMu         sync.Mutex
	closeSent       bool
	downstreamBytes *atomic.Uint64
}

func (s *socket) writeFrame(op byte, p []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	// A close frame ends the WebSocket write side. In particular, the
	// upstream reader may observe EOF after relay has echoed a peer close; it
	// must not append a spurious 1011 (or data/pong) after the close handshake.
	if s.closeSent {
		return net.ErrClosed
	}
	if op == 8 {
		s.closeSent = true
	}
	s.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	var header [10]byte
	header[0] = 0x80 | op
	n := 2
	if len(p) < 126 {
		header[1] = byte(len(p))
	} else if len(p) <= 65535 {
		header[1] = 126
		binary.BigEndian.PutUint16(header[2:4], uint16(len(p)))
		n = 4
	} else {
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:10], uint64(len(p)))
		n = 10
	}
	if err := writeAll(s.conn, header[:n]); err != nil {
		return err
	}
	if op == 2 && s.downstreamBytes != nil {
		return writeAll(countedWriter{s.conn, s.downstreamBytes}, p)
	}
	return writeAll(s.conn, p)
}
func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, e := w.Write(p)
		if e != nil {
			return e
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}
func (s *socket) closeWith(code uint16) error {
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], code)
	return s.writeFrame(8, p[:])
}

// Payloads are unmasked and forwarded in fixed chunks, never buffered as messages.
// Fragment boundaries are irrelevant to the inner byte stream. Control frames
// remain outside it and may be interleaved between fragments.
func (s *socket) relay(upstream net.Conn) error {
	buf := make([]byte, bufferSize)
	fragmented := false
	for {
		var h [2]byte
		if _, e := io.ReadFull(s.reader, h[:]); e != nil {
			return e
		}
		fin, op := h[0]&0x80 != 0, h[0]&15
		if h[0]&0x70 != 0 || h[1]&0x80 == 0 {
			return errors.New("reserved bits or missing mask")
		}
		length := uint64(h[1] & 127)
		if length == 126 {
			var p [2]byte
			if _, e := io.ReadFull(s.reader, p[:]); e != nil {
				return e
			}
			length = uint64(binary.BigEndian.Uint16(p[:]))
			if length < 126 {
				return errors.New("noncanonical length")
			}
		} else if length == 127 {
			var p [8]byte
			if _, e := io.ReadFull(s.reader, p[:]); e != nil {
				return e
			}
			length = binary.BigEndian.Uint64(p[:])
			if length < 65536 {
				return errors.New("noncanonical length")
			}
		}
		if length > maxFrame {
			return errors.New("frame limit")
		}
		control := op >= 8
		if control && (!fin || length > 125) {
			return errors.New("invalid control frame")
		}
		switch op {
		case 0:
			if !fragmented {
				return errors.New("unexpected continuation")
			}
			if fin {
				fragmented = false
			}
		case 2:
			if fragmented {
				return errors.New("interleaved data message")
			}
			fragmented = !fin
		case 8, 9, 10:
		default:
			return errors.New("unsupported opcode")
		}
		var mask [4]byte
		if _, e := io.ReadFull(s.reader, mask[:]); e != nil {
			return e
		}
		offset := uint64(0)
		for offset < length {
			count := min(uint64(len(buf)), length-offset)
			p := buf[:int(count)]
			if _, e := io.ReadFull(s.reader, p); e != nil {
				return e
			}
			for i := range p {
				p[i] ^= mask[(offset+uint64(i))%4]
			}
			if !control {
				upstream.SetWriteDeadline(time.Now().Add(30 * time.Second))
				if e := writeAll(upstream, p); e != nil {
					return e
				}
			}
			offset += count
		}
		if control {
			p := buf[:int(length)]
			switch op {
			case 8:
				if length == 1 {
					return errors.New("invalid close payload")
				}
				if length >= 2 {
					code := binary.BigEndian.Uint16(p)
					if !validClose(code) || !utf8.Valid(p[2:]) {
						return errors.New("invalid close code or UTF-8")
					}
				}
				_ = s.writeFrame(8, p)
				return io.EOF
			case 9:
				if e := s.writeFrame(10, p); e != nil {
					return e
				}
			case 10:
				if string(p) == "alive" {
					s.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
				}
			}
		}
	}
}
func validClose(c uint16) bool {
	return c >= 3000 && c <= 4999 || c >= 1000 && c <= 1014 && c != 1004 && c != 1005 && c != 1006
}
func env(name, fallback string) string {
	if s := os.Getenv(name); s != "" {
		return s
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		log.Fatalf("%s must be an integer", name)
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		log.Fatalf("%s must be a Go duration", name)
	}
	return parsed
}

const maxDrainGrace = 10 * time.Minute
const finalShutdownTimeout = 5 * time.Second

func healthcheckURL(address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port == "" {
		return "", errors.New("health listener must be a host:port address")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", errors.New("health listener must use a concrete TCP port")
	}
	switch host {
	case "", "0.0.0.0":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/readyz", nil
}

func healthRoutes(mux *http.ServeMux, g *gateway, upstream string) {
	mux.HandleFunc("/livez", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if !g.isReady() {
			http.Error(w, "bridge is draining", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ready\n")
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if !g.isReady() {
			http.Error(w, "bridge is draining", http.StatusServiceUnavailable)
			return
		}
		conn, err := net.DialTimeout("tcp", upstream, time.Second)
		if err != nil {
			http.Error(w, "upstream unavailable", http.StatusServiceUnavailable)
			return
		}
		_ = conn.Close()
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
	})
}

func shutdownOnSignal(g *gateway, server, healthServer *http.Server, signals <-chan os.Signal, grace time.Duration) {
	<-signals
	g.beginDrain()
	log.Printf("shutdown signal received; draining tunnels for up to %s", grace)
	graceCtx, cancelGrace := context.WithTimeout(context.Background(), grace)
	drained := make(chan struct{})
	go func() {
		if g.waitForDrain(graceCtx) {
			close(drained)
		}
	}()
	forced := false
	select {
	case <-drained:
		g.metrics.drainCompletions.Add(1)
		log.Printf("drain completed before the grace deadline")
	case <-graceCtx.Done():
		forced = true
		log.Printf("drain grace deadline expired")
	case <-signals:
		forced = true
		log.Printf("second shutdown signal received")
	}
	cancelGrace()
	if forced {
		g.metrics.forcedShutdowns.Add(1)
		g.forceCloseActive()
		g.closeHTTPConnections(false)
		log.Printf("forcing tunnel shutdown")
		// The grace deadline or a second signal means force now: Shutdown would
		// otherwise keep waiting for a stalled HTTP handler after closing tunnels.
		_ = server.Close()
		_ = healthServer.Close()
		return
	}
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), finalShutdownTimeout)
	defer cancelShutdown()
	log.Printf("shutting down HTTP listeners")
	g.closeHTTPConnections(true)
	closeOnTimeout := make(chan struct{})
	go func() {
		select {
		case <-signals:
			g.closeHTTPConnections(false)
			_ = server.Close()
			g.closeHTTPConnections(false)
			_ = healthServer.Close()
		case <-shutdownCtx.Done():
			g.closeHTTPConnections(false)
			_ = server.Close()
			g.closeHTTPConnections(false)
			_ = healthServer.Close()
		case <-closeOnTimeout:
		}
	}()
	if err := server.Shutdown(shutdownCtx); err != nil {
		g.closeHTTPConnections(false)
		_ = server.Close()
	}
	if err := healthServer.Shutdown(shutdownCtx); err != nil {
		g.closeHTTPConnections(false)
		_ = healthServer.Close()
	}
	close(closeOnTimeout)
}

func main() {
	listen := flag.String("listen", env("LISTEN", "127.0.0.1:8080"), "HTTP listen address")
	healthListen := flag.String("health-listen", env("HEALTH_LISTEN", "127.0.0.1:8082"), "private HTTP listener for liveness/readiness probes")
	upstream := flag.String("upstream", env("UPSTREAM", "127.0.0.1:50051"), "default upstream TCP address")
	targetsFile := flag.String("targets-file", os.Getenv("TARGETS_FILE"), "JSON allowed destinations, reloaded on each new target selection")
	origin := flag.String("origin", env("ALLOWED_ORIGIN", "http://localhost:8080"), "exact allowed browser origin")
	assets := flag.String("assets", env("ASSETS", "web/dist"), "demo static directory")
	cert := flag.String("tls-cert", os.Getenv("TLS_CERT"), "PEM certificate for HTTPS/WSS")
	key := flag.String("tls-key", os.Getenv("TLS_KEY"), "PEM key for HTTPS/WSS")
	tlsUp := flag.Bool("upstream-tls", os.Getenv("UPSTREAM_TLS") == "true", "verify TLS and h2 ALPN upstream")
	maxConns := flag.Int("max-connections", 256, "maximum concurrent tunnels")
	maxPerPrincipal := flag.Int("max-connections-per-principal", envInt("MAX_CONNECTIONS_PER_PRINCIPAL", 8), "maximum concurrent tunnels for one principal")
	maxGrant := flag.Duration("max-grant-lifetime", envDuration("MAX_ADMISSION_GRANT_LIFETIME", 15*time.Minute), "maximum accepted admission grant lifetime")
	maxTunnel := flag.Duration("max-tunnel-lifetime", envDuration("MAX_TUNNEL_LIFETIME", time.Hour), "maximum lifetime of an established tunnel")
	drainGrace := flag.Duration("drain-grace-period", envDuration("DRAIN_GRACE_PERIOD", 30*time.Second), "maximum time to drain existing tunnels after the first shutdown signal")
	admissionURL := flag.String("admission-url", os.Getenv("ADMISSION_URL"), "fixed external admission service URL; mutually exclusive with TUNNEL_TOKEN")
	healthcheck := flag.Bool("healthcheck", false, "check local HTTP readiness and exit")
	flag.Parse()
	if *healthcheck {
		url, err := healthcheckURL(*healthListen)
		if err != nil {
			os.Exit(1)
		}
		c := http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		r, e := c.Get(url)
		if e != nil {
			os.Exit(1)
		}
		r.Body.Close()
		if r.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	if *maxConns < 1 {
		log.Fatal("max-connections must be positive")
	}
	if *maxPerPrincipal < 1 || *maxGrant <= 0 || *maxGrant > 24*time.Hour || *maxTunnel <= 0 || *maxTunnel > 24*time.Hour {
		log.Fatal("principal quota and admission/tunnel lifetimes are outside supported bounds")
	}
	if *drainGrace < 0 || *drainGrace > maxDrainGrace {
		log.Fatalf("drain-grace-period must be between 0 and %s", maxDrainGrace)
	}
	token := os.Getenv("TUNNEL_TOKEN")
	for _, r := range token {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			log.Fatal("TUNNEL_TOKEN must be base64url-safe")
		}
	}
	if *admissionURL != "" && token != "" {
		log.Fatal("configure either ADMISSION_URL or TUNNEL_TOKEN, not both")
	}
	if *admissionURL != "" {
		if err := validateAdmissionURL(*admissionURL); err != nil {
			log.Fatal("invalid ADMISSION_URL")
		}
	}
	g := newGateway(config{upstream: *upstream, origin: *origin, token: token, maxConnections: *maxConns, upstreamTLS: *tlsUp, targetsFile: *targetsFile, admissionURL: *admissionURL, maxPerPrincipal: *maxPerPrincipal, maxGrantLifetime: *maxGrant, maxTunnelLifetime: *maxTunnel})
	mux := http.NewServeMux()
	mux.Handle("/tunnel", g)
	healthRoutes(mux, g, *upstream)
	mux.HandleFunc("/metrics", g.serveMetrics)
	mux.Handle("/", http.FileServer(http.Dir(*assets)))
	server := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192, ConnState: g.httpConnState}
	publicListener, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("could not listen on %q: %v", *listen, err)
	}
	g.setServing()
	healthListener, err := net.Listen("tcp", *healthListen)
	if err != nil {
		log.Fatalf("could not listen on private health address %q: %v", *healthListen, err)
	}
	healthMux := http.NewServeMux()
	healthRoutes(healthMux, g, *upstream)
	healthServer := &http.Server{Handler: healthMux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192, ConnState: g.httpConnState}
	healthServeDone := make(chan error, 1)
	go func() { healthServeDone <- healthServer.Serve(healthListener) }()
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	shutdownDone := make(chan struct{})
	go func() {
		shutdownOnSignal(g, server, healthServer, signals, *drainGrace)
		close(shutdownDone)
	}()
	log.Printf("grpc-bridge listening on %s; health on %s; default upstream %s; max tunnels %d", *listen, *healthListen, *upstream, *maxConns)
	var serveErr error
	if *cert != "" {
		serveErr = server.ServeTLS(publicListener, *cert, *key)
	} else {
		serveErr = server.Serve(publicListener)
	}
	if !errors.Is(serveErr, http.ErrServerClosed) {
		log.Fatal(serveErr)
	}
	<-shutdownDone
	_ = healthListener.Close()
	if healthErr := <-healthServeDone; !errors.Is(healthErr, http.ErrServerClosed) {
		log.Printf("health server stopped: %v", healthErr)
	}
}
