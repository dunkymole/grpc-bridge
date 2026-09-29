package main

import (
	"bufio"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testTLSCertificate(t *testing.T) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	now := time.Now()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkixName("grpc-bridge test root"),
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leaves := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkixName("grpc-bridge local endpoint"),
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaves, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
	)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	return cert, roots
}

// Avoid embedding a mutable pkix.Name value in the test cases above.
func pkixName(commonName string) pkix.Name { return pkix.Name{CommonName: commonName} }

func startTCPEcho(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return listener.Addr().String()
}

func startTLSEcho(t *testing.T, cert tls.Certificate, protocols []string, entered *atomic.Int32, received *atomic.Int32) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tlsListener := tls.NewListener(listener, &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
		NextProtos:   protocols,
	})
	t.Cleanup(func() { tlsListener.Close() })
	go func() {
		for {
			conn, err := tlsListener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
				tlsConn := conn.(*tls.Conn)
				if err := tlsConn.Handshake(); err != nil || tlsConn.ConnectionState().NegotiatedProtocol != "h2" {
					return
				}
				entered.Add(1)
				buf := make([]byte, 1024)
				for {
					n, err := tlsConn.Read(buf)
					if n > 0 {
						received.Add(int32(n))
						if _, writeErr := tlsConn.Write(buf[:n]); writeErr != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}(conn)
		}
	}()
	return listener.Addr().String()
}

func performWebSocketHandshake(t *testing.T, conn net.Conn, host, origin string) (*bufio.Reader, int) {
	t.Helper()
	reader := bufio.NewReader(conn)
	_, port, err := net.SplitHostPort(host)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "GET /tunnel HTTP/1.1\r\nHost: localhost:%s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: %s\r\nOrigin: %s\r\n\r\n", port, protocol, origin)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	return reader, response.StatusCode
}

func readServerFrame(reader *bufio.Reader) (byte, []byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return 0, nil, err
	}
	if header[1]&0x80 != 0 {
		return 0, nil, fmt.Errorf("server frame unexpectedly masked")
	}
	length := uint64(header[1] & 0x7f)
	if length == 126 {
		var ext [2]byte
		if _, err := io.ReadFull(reader, ext[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(ext[0])<<8 | uint64(ext[1])
	} else if length == 127 {
		var ext [8]byte
		if _, err := io.ReadFull(reader, ext[:]); err != nil {
			return 0, nil, err
		}
		length = 0
		for _, b := range ext {
			length = length<<8 | uint64(b)
		}
	}
	if length > maxFrame {
		return 0, nil, fmt.Errorf("oversized server frame: %d", length)
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return 0, nil, err
	}
	return header[0] & 0x0f, payload, nil
}

func TestWSSLocalCATrustAndRejection(t *testing.T) {
	cert, roots := testTLSCertificate(t)
	g := newGateway(config{upstream: startTCPEcho(t), origin: "https://client.example", maxConnections: 2})
	defer g.stop()
	server := httptest.NewUnstartedServer(g)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{"http/1.1"}}
	server.StartTLS()
	t.Cleanup(server.Close)
	address := strings.TrimPrefix(server.URL, "https://")
	trusted, err := tls.Dial("tcp", address, &tls.Config{RootCAs: roots, ServerName: "localhost", NextProtos: []string{"http/1.1"}})
	if err != nil {
		t.Fatalf("trusted WSS TLS handshake failed: %v", err)
	}
	reader, status := performWebSocketHandshake(t, trusted, address, "https://client.example")
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("trusted WSS status = %d", status)
	}
	payload := []byte("verified WSS")
	if err := writeAll(trusted, clientFrame(2, true, payload)); err != nil {
		t.Fatal(err)
	}
	op, echoed, err := readServerFrame(reader)
	if err != nil || op != 2 || !bytes.Equal(echoed, payload) {
		t.Fatalf("WSS echo op=%d payload=%q err=%v", op, echoed, err)
	}
	if err := writeAll(trusted, clientFrame(8, true, []byte{3, 232})); err != nil {
		t.Fatal(err)
	}
	op, closePayload, err := readServerFrame(reader)
	if err != nil || op != 8 || !bytes.Equal(closePayload, []byte{3, 232}) {
		t.Fatalf("WSS close op=%d payload=%x err=%v", op, closePayload, err)
	}
	trusted.Close()

	attempts := g.metrics.attempts.Load()
	for _, serverName := range []string{"localhost", "wrong.invalid"} {
		untrusted, err := tls.Dial("tcp", address, &tls.Config{RootCAs: x509.NewCertPool(), ServerName: serverName, NextProtos: []string{"http/1.1"}})
		if err == nil {
			untrusted.Close()
			t.Fatalf("untrusted or mismatched WSS certificate accepted for %s", serverName)
		}
	}
	if got := g.metrics.attempts.Load(); got != attempts {
		t.Fatalf("rejected TLS clients reached the WebSocket handler: attempts %d -> %d", attempts, got)
	}
}

func TestUpstreamTLSRequiresTrustAndH2ALPN(t *testing.T) {
	cert, roots := testTLSCertificate(t)
	for _, tc := range []struct {
		name      string
		protocols []string
		trust     *x509.CertPool
		wantEcho  bool
	}{
		{name: "trusted h2", protocols: []string{"h2"}, trust: roots, wantEcho: true},
		{name: "untrusted certificate", protocols: []string{"h2"}, trust: x509.NewCertPool()},
		{name: "wrong ALPN", protocols: []string{"http/1.1"}, trust: roots},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var appEntered, appBytes atomic.Int32
			address := startTLSEcho(t, cert, tc.protocols, &appEntered, &appBytes)
			g := newGateway(config{upstream: address, origin: "http://localhost", upstreamTLS: true, upstreamRoots: tc.trust, maxConnections: 1})
			defer g.stop()
			server := httptest.NewServer(g)
			defer server.Close()
			host := strings.TrimPrefix(server.URL, "http://")
			client, err := net.Dial("tcp", host)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			reader, status := performWebSocketHandshake(t, client, host, "http://localhost")
			if !tc.wantEcho {
				if status != http.StatusBadGateway {
					t.Fatalf("rejected upstream got HTTP %d, want 502", status)
				}
				if appEntered.Load() != 0 || appBytes.Load() != 0 {
					t.Fatalf("rejected upstream reached app: entries=%d bytes=%d", appEntered.Load(), appBytes.Load())
				}
				return
			}
			if status != http.StatusSwitchingProtocols {
				t.Fatalf("trusted upstream got HTTP %d, want 101", status)
			}
			payload := []byte("verified upstream TLS")
			if err := writeAll(client, clientFrame(2, true, payload)); err != nil {
				t.Fatal(err)
			}
			op, echoed, err := readServerFrame(reader)
			if err != nil || op != 2 || !bytes.Equal(echoed, payload) {
				t.Fatalf("upstream TLS echo op=%d payload=%q err=%v", op, echoed, err)
			}
			if appEntered.Load() != 1 || appBytes.Load() != int32(len(payload)) {
				t.Fatalf("application traffic entries=%d bytes=%d", appEntered.Load(), appBytes.Load())
			}
		})
	}
}

func TestTLSCertificateHasExpectedHostname(t *testing.T) {
	cert, roots := testTLSCertificate(t)
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := parsed.VerifyHostname("localhost"); err != nil {
		t.Fatalf("local test certificate lacks localhost SAN: %v", err)
	}
	if err := parsed.VerifyHostname("127.0.0.1"); err != nil {
		t.Fatalf("local test certificate lacks IP SAN: %v", err)
	}
	if len(roots.Subjects()) != 1 {
		t.Fatalf("expected isolated one-root trust pool, got %d subjects", len(roots.Subjects()))
	}
}
