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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testTLSCertificate(t *testing.T) (tls.Certificate, *x509.CertPool, []byte) {
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
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	return cert, roots, caPEM
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
	_, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return net.JoinHostPort("localhost", port)
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
	if response.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(response.Body)
		t.Logf("WebSocket handshake returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
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
	cert, roots, _ := testTLSCertificate(t)
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
	for _, tc := range []struct {
		name  string
		roots *x509.CertPool
	}{
		{name: "unknown CA", roots: x509.NewCertPool()},
		{name: "trusted CA with wrong hostname", roots: roots},
	} {
		serverName := "localhost"
		if tc.name == "trusted CA with wrong hostname" {
			serverName = "wrong.invalid"
		}
		untrusted, err := tls.Dial("tcp", address, &tls.Config{RootCAs: tc.roots, ServerName: serverName, NextProtos: []string{"http/1.1"}})
		if err == nil {
			untrusted.Close()
			t.Fatalf("WSS accepted %s", tc.name)
		}
	}
	if got := g.metrics.attempts.Load(); got != attempts {
		t.Fatalf("rejected TLS clients reached the WebSocket handler: attempts %d -> %d", attempts, got)
	}
}

func TestUpstreamTLSRequiresTrustAndH2ALPN(t *testing.T) {
	cert, roots, _ := testTLSCertificate(t)
	for _, tc := range []struct {
		name      string
		protocols []string
		trust     *x509.CertPool
		wrongHost bool
		wantEcho  bool
	}{
		{name: "trusted h2", protocols: []string{"h2"}, trust: roots, wantEcho: true},
		{name: "untrusted certificate", protocols: []string{"h2"}, trust: x509.NewCertPool()},
		{name: "trusted certificate with wrong hostname", protocols: []string{"h2"}, trust: roots, wrongHost: true},
		{name: "no ALPN", protocols: nil, trust: roots},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var appEntered, appBytes atomic.Int32
			address := startTLSEcho(t, cert, tc.protocols, &appEntered, &appBytes)
			if tc.wrongHost {
				_, port, err := net.SplitHostPort(address)
				if err != nil {
					t.Fatal(err)
				}
				address = net.JoinHostPort("127.0.0.1", port)
			}
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
	cert, roots, _ := testTLSCertificate(t)
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := parsed.VerifyHostname("localhost"); err != nil {
		t.Fatalf("local test certificate lacks localhost SAN: %v", err)
	}
	if err := parsed.VerifyHostname("127.0.0.1"); err == nil {
		t.Fatal("DNS-only certificate unexpectedly validates for an IP address")
	}
	if len(roots.Subjects()) != 1 {
		t.Fatalf("expected isolated one-root trust pool, got %d subjects", len(roots.Subjects()))
	}
}

func TestBridgeProcessUsesSSL_CERT_FILEForWSSAndUpstream(t *testing.T) {
	cert, roots, caPEM := testTLSCertificate(t)
	temp := t.TempDir()
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]})
	keyDER, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	certPath, keyPath, rootsPath := filepath.Join(temp, "bridge.pem"), filepath.Join(temp, "bridge-key.pem"), filepath.Join(temp, "roots.pem")
	for path, data := range map[string][]byte{certPath: certPEM, keyPath: keyPEM, rootsPath: caPEM} {
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	var appEntered, appBytes atomic.Int32
	upstream := startTLSEcho(t, cert, []string{"h2"}, &appEntered, &appBytes)
	listen, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	listenAddress := listen.Addr().String()
	listen.Close()
	healthListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	healthAddress := healthListener.Addr().String()
	healthListener.Close()

	binary := filepath.Join(temp, "grpc-bridge")
	build := exec.Command("go", "build", "-o", binary, ".")
	output, err := build.CombinedOutput()
	if err != nil {
		t.Fatalf("build production bridge binary: %v\n%s", err, output)
	}
	cmd := exec.Command(binary)
	cmd.Env = append(filteredEnvironment(
		"SSL_CERT_FILE", "LISTEN", "UPSTREAM", "UPSTREAM_TLS", "TLS_CERT", "TLS_KEY", "ALLOWED_ORIGIN",
		"TUNNEL_TOKEN", "ADMISSION_URL", "TARGETS_FILE", "HEALTH_LISTEN", "MAX_CONNECTIONS",
		"MAX_CONNECTIONS_PER_PRINCIPAL", "MAX_ADMISSION_GRANT_LIFETIME", "MAX_TUNNEL_LIFETIME", "DRAIN_GRACE_PERIOD",
	),
		"SSL_CERT_FILE="+rootsPath,
		"LISTEN="+listenAddress,
		"UPSTREAM="+upstream,
		"UPSTREAM_TLS=true",
		"TLS_CERT="+certPath,
		"TLS_KEY="+keyPath,
		"ALLOWED_ORIGIN=https://client.example",
		"HEALTH_LISTEN="+healthAddress,
	)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(6 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})

	client := &http.Client{
		Timeout:   300 * time.Millisecond,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "localhost"}},
	}
	readyURL := "https://" + listenAddress + "/healthz"
	readyURL = strings.Replace(readyURL, "127.0.0.1:", "localhost:", 1)
	deadline := time.Now().Add(10 * time.Second)
	for {
		response, requestErr := client.Get(readyURL)
		if requestErr == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("production bridge did not serve verified WSS listener: %v", requestErr)
		}
		time.Sleep(50 * time.Millisecond)
	}
	parsedReadyURL, err := url.Parse(readyURL)
	if err != nil {
		t.Fatal(err)
	}
	address := parsedReadyURL.Host
	conn, err := tls.Dial("tcp", address, &tls.Config{RootCAs: roots, ServerName: "localhost", NextProtos: []string{"http/1.1"}})
	if err != nil {
		t.Fatalf("production WSS verification failed: %v", err)
	}
	reader, status := performWebSocketHandshake(t, conn, address, "https://client.example")
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("production TLS tunnel got HTTP %d", status)
	}
	payload := []byte("production trust store")
	if err := writeAll(conn, clientFrame(2, true, payload)); err != nil {
		t.Fatal(err)
	}
	op, echoed, err := readServerFrame(reader)
	if err != nil || op != 2 || !bytes.Equal(echoed, payload) {
		t.Fatalf("production TLS echo op=%d payload=%q err=%v", op, echoed, err)
	}
	if appEntered.Load() != 1 || appBytes.Load() != int32(len(payload)) {
		t.Fatalf("production trust store did not reach upstream app: entries=%d bytes=%d", appEntered.Load(), appBytes.Load())
	}
	conn.Close()
}

func filteredEnvironment(keys ...string) []string {
	wanted := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		wanted[key] = struct{}{}
	}
	filtered := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if _, remove := wanted[key]; !remove {
			filtered = append(filtered, entry)
		}
	}
	return filtered
}
