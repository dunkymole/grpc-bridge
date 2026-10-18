package main

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOfflineSettings(t *testing.T) {
	for _, tc := range []struct{ name, listen, health, upstream, origin, cert, key string }{
		{"valid", "127.0.0.1:8080", "127.0.0.1:8082", "offline.invalid:443", "https://example.com", "", ""},
		{"bad listen", "secret", "localhost:8082", "localhost:443", "https://example.com", "", ""},
		{"bad health", "localhost:8080", "localhost:0", "localhost:443", "https://example.com", "", ""},
		{"bad upstream", "localhost:8080", "localhost:8082", "secret:99999", "https://example.com", "", ""},
		{"bad origin", "localhost:8080", "localhost:8082", "localhost:443", "https://secret@example.com", "", ""},
		{"origin empty hostname", "localhost:8080", "localhost:8082", "localhost:443", "https://:443", "", ""},
		{"origin invalid port", "localhost:8080", "localhost:8082", "localhost:443", "https://example.com:99999", "", ""},
		{"origin zero port", "localhost:8080", "localhost:8082", "localhost:443", "https://example.com:0", "", ""},
		{"origin empty port", "localhost:8080", "localhost:8082", "localhost:443", "https://example.com:", "", ""},
		{"missing key", "localhost:8080", "localhost:8082", "localhost:443", "https://example.com", "secret", ""},
		{"missing files", "localhost:8080", "localhost:8082", "localhost:443", "https://example.com", "secret", "secret"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateOfflineSettings(tc.listen, tc.health, tc.upstream, tc.origin, "", tc.cert, tc.key)
			if (err == nil) != (tc.name == "valid") {
				t.Fatalf("unexpected result: %v", err)
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Fatal("sensitive value leaked")
			}
		})
	}
}

func TestTargetPolicyValidation(t *testing.T) {
	for _, body := range []string{`{"targets":{"backend:443":{"tls":true}}}`, `{"targets":{}}`, `null`, `{}`, `{"targets":null}`, `{"targets":{"secret:0":{}}}`, `{"targets":{"backend:443":{"secret":true}}}`, `{"targets":{}} {}`, strings.Repeat(" ", 65537)} {
		path := filepath.Join(t.TempDir(), "policy.json")
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := readTargetPolicy(path)
		valid := body == `{"targets":{"backend:443":{"tls":true}}}` || body == `{"targets":{}}`
		if (err == nil) != valid {
			t.Fatalf("unexpected policy result: %v", err)
		}
		if err != nil && strings.Contains(err.Error(), "secret") {
			t.Fatal("policy contents leaked")
		}
	}
}

func TestCheckConfigProcess(t *testing.T) {
	if processBridgeBinary == "" {
		t.Skip("process binary requires Linux")
	}
	// Occupied listeners and an accepting backend detect accidental network work.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	for _, tc := range []struct {
		args  []string
		valid bool
	}{
		{[]string{}, true},
		{[]string{"-healthcheck"}, false},
		{[]string{"-origin=https://:443"}, false},
		{[]string{"-origin=https://example.com:99999"}, false},
		{[]string{"-max-connections=0"}, false},
		{[]string{"-max-connections-per-principal=0"}, false},
		{[]string{"-max-grant-lifetime=25h"}, false},
		{[]string{"-max-tunnel-lifetime=0s"}, false},
		{[]string{"-drain-grace-period=-1s"}, false},
		{[]string{"-targets-file=secret"}, false},
		{[]string{"-unknown=secret"}, false},
		{[]string{"-tls-key=secret"}, false},
		{[]string{"-max-connections=secret"}, false},
		{[]string{"-admission-url=https://secret@example.com"}, false},
		{[]string{"-max-grant-lifetime=1m"}, true},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		args := []string{"-check-config", "-listen=" + listener.Addr().String(), "-upstream=" + listener.Addr().String(), "-health-listen=127.0.0.1:8082"}
		args = append(args, tc.args...)
		command := exec.CommandContext(ctx, processBridgeBinary, args...)
		command.Env = []string{"ALLOWED_ORIGIN=https://example.com"}
		if strings.Contains(strings.Join(tc.args, " "), "-max-grant-lifetime") {
			command.Env = append(command.Env, "MAX_ADMISSION_GRANT_LIFETIME=secret")
		}
		output, err := command.CombinedOutput()
		cancel()
		if (err == nil) != tc.valid {
			t.Fatalf("args %v: %v: %s", tc.args, err, output)
		}
		if strings.Contains(string(output), "secret") {
			t.Fatalf("sensitive value leaked: %s", output)
		}
	}
	listener.(*net.TCPListener).SetDeadline(time.Now().Add(50 * time.Millisecond))
	if connection, err := listener.Accept(); err == nil {
		connection.Close()
		t.Fatal("validator contacted backend")
	}
}

func TestOfflineTLSFiles(t *testing.T) {
	certificate, _, _ := testTLSCertificate(t)
	directory := t.TempDir()
	certPath, keyPath := filepath.Join(directory, "cert.pem"), filepath.Join(directory, "key.pem")
	keyDER, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0600); err != nil {
		t.Fatal(err)
	}
	validate := func() error {
		return validateOfflineSettings("localhost:8080", "localhost:8082", "localhost:443", "https://example.com", "", certPath, keyPath)
	}
	if err := validate(); err != nil {
		t.Fatal(err)
	}
	other, _, _ := testTLSCertificate(t)
	otherDER, err := x509.MarshalPKCS8PrivateKey(other.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: otherDER}), 0600); err != nil {
		t.Fatal(err)
	}
	if validate() == nil {
		t.Fatal("accepted mismatched TLS pair")
	}
	if err := os.WriteFile(keyPath, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validate(); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("malformed TLS result: %v", err)
	}
}
