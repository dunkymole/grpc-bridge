package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// These are fixed-payload warm-connection round trips. Handshake costs and
// application HTTP/2/gRPC work are intentionally excluded from the timed loop.
func BenchmarkTunnelTLSOverhead(b *testing.B) {
	for _, encrypted := range []bool{false, true} {
		name := "plaintext"
		if encrypted {
			name = "wss"
		}
		b.Run(name, func(b *testing.B) {
			backend, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				b.Fatal(err)
			}
			defer backend.Close()
			go func() {
				for {
					conn, err := backend.Accept()
					if err != nil {
						return
					}
					go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
				}
			}()
			g := newGateway(config{defaultTarget: "demo", targetsFile: testTargetsFile(b, backend.Addr().String(), false), maxConnections: 1})
			server := httptest.NewUnstartedServer(g)
			if encrypted {
				server.StartTLS()
			} else {
				server.Start()
			}
			defer server.Close()
			endpoint, _ := url.Parse(server.URL)
			var conn net.Conn
			if encrypted {
				// Trust only this test server's generated certificate, never disable verification.
				trust := server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
				conn, err = tls.Dial("tcp", endpoint.Host, trust)
			} else {
				conn, err = net.Dial("tcp", endpoint.Host)
			}
			if err != nil {
				b.Fatal(err)
			}
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(time.Minute))
			_, err = fmt.Fprintf(conn, "GET /tunnel HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: %s\r\n\r\n", endpoint.Host, protocol)
			if err != nil {
				b.Fatal(err)
			}
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				b.Fatal(err)
			}
			if response.StatusCode != 101 {
				b.Fatal(response.Status)
			}
			payload := bytes.Repeat([]byte("x"), 16*1024)
			packet := clientFrame(2, true, payload)
			b.SetBytes(int64(len(payload) * 2))
			b.ReportAllocs()
			b.ResetTimer()
			for iteration := 0; iteration < b.N; iteration++ {
				if _, err := conn.Write(packet); err != nil {
					b.Fatal(err)
				}
				received := 0
				for received < len(payload) {
					op, data, err := readServerFrame(reader)
					if err != nil || op != 2 {
						b.Fatalf("echo failed: opcode=%d error=%v", op, err)
					}
					received += len(data)
					if !bytes.Equal(data, payload[:len(data)]) {
						b.Fatal("corrupt echoed payload")
					}
				}
			}
			b.StopTimer()
		})
	}
}
