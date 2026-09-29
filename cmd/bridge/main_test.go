package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type memoryConn struct{ bytes.Buffer }

func (*memoryConn) Close() error                     { return nil }
func (*memoryConn) LocalAddr() net.Addr              { return nil }
func (*memoryConn) RemoteAddr() net.Addr             { return nil }
func (*memoryConn) SetDeadline(time.Time) error      { return nil }
func (*memoryConn) SetReadDeadline(time.Time) error  { return nil }
func (*memoryConn) SetWriteDeadline(time.Time) error { return nil }
func clientFrame(op byte, fin bool, p []byte) []byte {
	h := []byte{op, 0}
	if fin {
		h[0] |= 128
	}
	n := len(p)
	if n < 126 {
		h[1] = 128 | byte(n)
	} else if n <= 65535 {
		h[1] = 128 | 126
		h = binary.BigEndian.AppendUint16(h, uint16(n))
	} else {
		h[1] = 128 | 127
		h = binary.BigEndian.AppendUint64(h, uint64(n))
	}
	mask := [4]byte{3, 5, 7, 11}
	h = append(h, mask[:]...)
	for i, b := range p {
		h = append(h, b^mask[i%4])
	}
	return h
}
func TestRelayFragmentationAndControl(t *testing.T) {
	input := clientFrame(2, false, []byte("opaque "))
	input = append(input, clientFrame(9, true, []byte("ping"))...)
	input = append(input, clientFrame(0, true, []byte("bytes"))...)
	input = append(input, clientFrame(8, true, nil)...)
	downstream, upstream := &memoryConn{}, &memoryConn{}
	s := socket{conn: downstream, reader: bufio.NewReader(bytes.NewReader(input))}
	if e := s.relay(upstream); e != io.EOF {
		t.Fatal(e)
	}
	if upstream.String() != "opaque bytes" {
		t.Fatalf("changed inner bytes: %q", upstream.String())
	}
	if !bytes.Equal(downstream.Bytes(), []byte{0x8a, 4, 'p', 'i', 'n', 'g', 0x88, 0}) {
		t.Fatalf("bad control response: %x", downstream.Bytes())
	}
}

func TestCloseFrameIsTerminal(t *testing.T) {
	downstream := &memoryConn{}
	s := socket{conn: downstream}
	if err := s.closeWith(1000); err != nil {
		t.Fatal(err)
	}
	// Simulate the upstream pump observing EOF after the peer close has been
	// echoed. It must not send a second close or data after the handshake.
	if err := s.closeWith(1011); err == nil {
		t.Fatal("second close frame was written")
	}
	if err := s.writeFrame(2, []byte("late data")); err == nil {
		t.Fatal("data frame was written after close")
	}
	if want := []byte{0x88, 2, 0x03, 0xe8}; !bytes.Equal(downstream.Bytes(), want) {
		t.Fatalf("close output = %x, want exactly %x", downstream.Bytes(), want)
	}
}

func TestInvalidFrameGetsOneProtocolClose(t *testing.T) {
	downstream := &memoryConn{}
	s := socket{
		conn:   downstream,
		reader: bufio.NewReader(bytes.NewReader(clientFrame(8, true, []byte{1}))),
	}
	if err := s.relay(&memoryConn{}); err == nil || err == io.EOF {
		t.Fatalf("invalid close payload was accepted: %v", err)
	}
	if err := s.closeWith(1002); err != nil {
		t.Fatal(err)
	}
	if err := s.closeWith(1011); err == nil {
		t.Fatal("failure pump appended a second close after protocol error")
	}
	if want := []byte{0x88, 2, 0x03, 0xea}; !bytes.Equal(downstream.Bytes(), want) {
		t.Fatalf("protocol close output = %x, want exactly %x", downstream.Bytes(), want)
	}
}

func TestConcurrentPumpsSendOnlyOneClose(t *testing.T) {
	downstream := &memoryConn{}
	s := socket{conn: downstream}
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, code := range []uint16{1000, 1011} {
		go func(code uint16) {
			<-start
			results <- s.closeWith(code)
		}(code)
	}
	close(start)
	first, second := <-results, <-results
	if (first == nil) == (second == nil) {
		t.Fatalf("want exactly one winning close write, got %v and %v", first, second)
	}
	if len(downstream.Bytes()) != 4 {
		t.Fatalf("concurrent pumps wrote %d bytes, want one close frame", downstream.Len())
	}
}

func TestUpstreamFailureCanInitiateClose(t *testing.T) {
	downstream := &memoryConn{}
	s := socket{conn: downstream}
	if err := s.closeWith(1011); err != nil {
		t.Fatal(err)
	}
	if want := []byte{0x88, 2, 0x03, 0xf3}; !bytes.Equal(downstream.Bytes(), want) {
		t.Fatalf("upstream failure close = %x, want %x", downstream.Bytes(), want)
	}
}

func TestLargeFrameStreamsInChunks(t *testing.T) {
	payload := bytes.Repeat([]byte{0, 1, 255, 127}, maxFrame/4)
	input := clientFrame(2, true, payload)
	upstream := &memoryConn{}
	s := socket{conn: &memoryConn{}, reader: bufio.NewReader(bytes.NewReader(input))}
	if e := s.relay(upstream); e != io.EOF {
		t.Fatal(e)
	}
	if !bytes.Equal(payload, upstream.Bytes()) {
		t.Fatal("large payload corrupted")
	}
}
func TestRejectMalformedFrames(t *testing.T) {
	cases := map[string][]byte{
		"unmasked": {0x82, 0}, "reserved": {0xc2, 0x80},
		"text": clientFrame(1, true, nil), "continuation": clientFrame(0, true, nil),
		"fragmented ping": clientFrame(9, false, nil), "large ping": clientFrame(9, true, make([]byte, 126)),
		"one byte close": clientFrame(8, true, []byte{1}), "invalid close": clientFrame(8, true, []byte{3, 237}),
		"invalid UTF8 close": clientFrame(8, true, []byte{3, 232, 255}),
		"noncanonical":       {0x82, 0xfe, 0, 1},
		"oversized":          {0x82, 0xff, 0, 0, 0, 0, 0, 0x20, 0, 0},
	}
	reservedBinary := clientFrame(2, true, []byte("binary"))
	reservedBinary[0] |= 0x40
	cases["reserved bit on binary message"] = reservedBinary
	cases["unsupported binary-profile opcode"] = clientFrame(3, true, []byte("binary"))
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			s := socket{conn: &memoryConn{}, reader: bufio.NewReader(bytes.NewReader(input))}
			if e := s.relay(&memoryConn{}); e == nil || e == io.EOF {
				t.Fatalf("accepted malformed frame: %v", e)
			}
		})
	}
}
func request() *http.Request {
	r := httptest.NewRequest("GET", "http://localhost/tunnel", nil)
	r.Header.Set("Connection", "keep-alive, Upgrade")
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Sec-WebSocket-Version", "13")
	r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	r.Header.Set("Sec-WebSocket-Protocol", protocol)
	return r
}
func TestHandshakeGuards(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*http.Request)
		code   int
	}{
		{"origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, 403},
		{"auth", func(r *http.Request) {}, 401},
		{"version", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Version", "12") }, 400},
		{"key", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Key", "invalid") }, 400},
		{"profile", func(r *http.Request) { r.Header.Set("Sec-WebSocket-Protocol", "auth.secret, grpc-tunnel.v2") }, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newGateway(config{upstream: "127.0.0.1:1", origin: "http://localhost", token: "secret", maxConnections: 1})
			r := request()
			tc.mutate(r)
			w := httptest.NewRecorder()
			g.ServeHTTP(w, r)
			if w.Code != tc.code {
				t.Fatalf("got %d want %d", w.Code, tc.code)
			}
		})
	}
	g := newGateway(config{upstream: "127.0.0.1:1", maxConnections: 1})
	g.slots <- struct{}{}
	w := httptest.NewRecorder()
	g.ServeHTTP(w, request())
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
}
func TestActualUpgradeAndOpaqueRelay(t *testing.T) {
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	go func() {
		c, e := listener.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		io.Copy(c, c)
	}()
	policy := filepath.Join(t.TempDir(), "targets.json")
	if e := os.WriteFile(policy, []byte(fmt.Sprintf(`{"targets":{%q:{"tls":false}}}`, listener.Addr().String())), 0600); e != nil {
		t.Fatal(e)
	}
	g := newGateway(config{upstream: "127.0.0.1:1", targetsFile: policy, maxConnections: 1})
	defer g.stop()
	server := httptest.NewServer(g)
	defer server.Close()
	c, e := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(c, "GET /tunnel?target=%s HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: %s\r\n\r\n", url.QueryEscape(listener.Addr().String()), protocol)
	reader := bufio.NewReader(c)
	response, e := http.ReadResponse(reader, nil)
	if e != nil {
		t.Fatal(e)
	}
	if response.StatusCode != 101 {
		t.Fatal(response.Status)
	}
	if response.Header.Get("Sec-WebSocket-Accept") != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatal("incorrect RFC handshake")
	}
	payload := []byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\x00\xff")
	writeAll(c, clientFrame(2, true, payload))
	header := make([]byte, 2)
	if _, e = io.ReadFull(reader, header); e != nil {
		t.Fatal(e)
	}
	if header[0] != 0x82 || int(header[1]) != len(payload) {
		t.Fatalf("bad frame %x", header)
	}
	got := make([]byte, len(payload))
	io.ReadFull(reader, got)
	if !bytes.Equal(got, payload) {
		t.Fatal("relay changed bytes")
	}
	// Finish the tunnel, then verify counters have settled after both relay legs.
	c.Close()
	deadline := time.Now().Add(time.Second)
	for g.metrics.closed.Load() != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if g.metrics.opened.Load() != 1 || g.metrics.closed.Load() != 1 || g.metrics.established.Load() != 0 {
		t.Fatal("incorrect tunnel lifecycle metrics")
	}
	if g.metrics.toBackend.Load() != uint64(len(payload)) || g.metrics.toClient.Load() != uint64(len(payload)) {
		t.Fatalf("incorrect byte counts: %d %d", g.metrics.toBackend.Load(), g.metrics.toClient.Load())
	}
	g.metrics.dial.mu.Lock()
	defer g.metrics.dial.mu.Unlock()
	if g.metrics.dial.count != 1 {
		t.Fatal("successful dial was not measured")
	}
}

func TestDestinationPolicyReload(t *testing.T) {
	file := filepath.Join(t.TempDir(), "targets.json")
	g := newGateway(config{upstream: "default:50051", targetsFile: file, maxConnections: 1})
	r := request()
	r.URL.RawQuery = "target=added.internal%3A50051"
	write := func(data string) {
		t.Helper()
		if e := os.WriteFile(file, []byte(data), 0600); e != nil {
			t.Fatal(e)
		}
	}
	write(`{"targets":{}}`)
	if _, _, status := g.destination(r); status != 403 {
		t.Fatal(status)
	}
	write(`{"targets":{"added.internal:50051":{"tls":true}}}`)
	if target, tls, status := g.destination(r); target != "added.internal:50051" || !tls || status != 0 {
		t.Fatalf("reload failed: %s %t %d", target, tls, status)
	}
	write(`{"targets":{}}`)
	if _, _, status := g.destination(r); status != 403 {
		t.Fatal("removed target still allowed")
	}
	for _, data := range []string{`{broken`, `{"targets":{}} {}`, strings.Repeat(" ", 65537)} {
		write(data)
		if _, _, status := g.destination(r); status != 503 {
			t.Fatalf("invalid config accepted: %d", status)
		}
	}
	for _, query := range []string{"target=a:0", "target=a:65536", "target=:80", "target=http://a:80", "target=a:80&target=b:80", "target=%zz"} {
		r.URL.RawQuery = query
		if _, _, status := g.destination(r); status != 400 {
			t.Fatalf("invalid target accepted: %s %d", query, status)
		}
	}
}
func FuzzRelay(f *testing.F) {
	f.Add(clientFrame(2, true, []byte("test")))
	f.Add([]byte{0x82, 0xff})
	f.Fuzz(func(t *testing.T, input []byte) {
		if len(input) > maxFrame+14 {
			t.Skip()
		}
		s := socket{conn: &memoryConn{}, reader: bufio.NewReader(bytes.NewReader(input))}
		_ = s.relay(&memoryConn{})
	})
}
