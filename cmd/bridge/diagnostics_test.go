package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type failingResolver struct{ wait bool }

func (r failingResolver) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	if r.wait {
		<-ctx.Done()
	}
	return nil, errors.New("secret")
}
func TestConnectivityDNSFailureAndDeadline(t *testing.T) {
	for _, wait := range []bool{false, true} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		start := time.Now()
		report, code := diagnoseConnectivity(ctx, config{defaultTarget: "demo", targetsFile: testTargetsFile(t, "secret.invalid:443", false)}, "", failingResolver{wait})
		cancel()
		if code != 3 || report.Stage != "dns" || strings.Contains(report.Message, "secret") {
			t.Fatalf("unexpected report: %+v / %d", report, code)
		}
		if time.Since(start) > time.Second {
			t.Fatal("deadline not respected")
		}
	}
}
func TestConnectivityPlaintextAndPolicy(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c := config{defaultTarget: "demo", targetsFile: testTargetsFile(t, listener.Addr().String(), false)}
	report, code := diagnoseConnectivity(ctx, c, "", net.DefaultResolver)
	if code != 0 || !report.OK || report.TLS {
		t.Fatalf("unexpected report: %+v / %d", report, code)
	}
	connection, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	connection.SetReadDeadline(time.Now().Add(time.Second))
	buffer := make([]byte, 1)
	if n, _ := connection.Read(buffer); n != 0 {
		t.Fatal("plaintext diagnostic sent application bytes")
	}
	report, code = diagnoseConnectivity(ctx, c, "secret.invalid:443", failingResolver{})
	if code != 2 || report.Stage != "config" {
		t.Fatalf("unconfigured destination accepted: %+v", report)
	}
	listener.Close()
	report, code = diagnoseConnectivity(ctx, c, "", net.DefaultResolver)
	if code != 4 || report.Stage != "tcp" {
		t.Fatalf("expected TCP failure: %+v / %d", report, code)
	}
}
func TestConnectivityTLS(t *testing.T) {
	cert, roots, _ := testTLSCertificate(t)
	for _, tc := range []struct {
		name      string
		protocols []string
		trusted   bool
		code      int
	}{
		{"trusted h2", []string{"h2"}, true, 0},
		{"untrusted", []string{"h2"}, false, 5},
		{"missing alpn", nil, true, 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var entered, received atomic.Int32
			address := startTLSEcho(t, cert, tc.protocols, &entered, &received)
			_, port, _ := net.SplitHostPort(address)
			c := config{defaultTarget: "demo", targetsFile: testTargetsFile(t, net.JoinHostPort("localhost", port), true)}
			if tc.trusted {
				c.upstreamRoots = roots
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			report, code := diagnoseConnectivity(ctx, c, "", net.DefaultResolver)
			if code != tc.code {
				t.Fatalf("unexpected report: %+v / %d", report, code)
			}
			if received.Load() != 0 {
				t.Fatal("diagnostic sent application bytes")
			}
		})
	}
}
func TestConnectivityTLSStall(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	report, code := diagnoseConnectivity(ctx, config{defaultTarget: "demo", targetsFile: testTargetsFile(t, listener.Addr().String(), true)}, "", net.DefaultResolver)
	if code != 5 || report.Stage != "tls" {
		t.Fatalf("unexpected result: %+v / %d", report, code)
	}
	connection, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	connection.Close()
}

func TestDiagnosticPolicySelection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "targets.json")
	if err := os.WriteFile(path, []byte(`{"targets":{"backend":{"address":"backend:443","tls":true},"demo":{"address":"localhost:50051","tls":false}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	c := config{defaultTarget: "demo", targetsFile: path}
	destination, secure, ok := diagnosticDestination(c, "backend")
	if !ok || !secure || destination != "backend:443" {
		t.Fatal("policy TLS selection failed")
	}
	if _, _, ok := diagnosticDestination(c, "other"); ok {
		t.Fatal("unconfigured target accepted")
	}
}

func TestDiagnosticProcess(t *testing.T) {
	if processBridgeBinary == "" {
		t.Skip("process binary requires Linux")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	for _, tc := range []struct {
		args  []string
		code  int
		stage string
	}{
		{nil, 0, "complete"},
		{[]string{"-diagnostic-target=secret.invalid:443"}, 2, "config"},
		{[]string{"-diagnostic-timeout=0s"}, 2, "config"},
		{[]string{"-diagnostic-timeout=61s"}, 2, "config"},
		{[]string{"-healthcheck"}, 1, ""},
		{[]string{"-check-config"}, 1, ""},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		args := append([]string{"-diagnose", "-targets-file=" + testTargetsFile(t, listener.Addr().String(), false), "-listen=" + listener.Addr().String()}, tc.args...)
		command := exec.CommandContext(ctx, processBridgeBinary, args...)
		command.Env = []string{"ALLOWED_ORIGIN=https://example.com"}
		output, err := command.CombinedOutput()
		cancel()
		code := 0
		if err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				code = exit.ExitCode()
			} else {
				t.Fatal(err)
			}
		}
		if code != tc.code || strings.Contains(string(output), "secret") {
			t.Fatalf("unexpected result %d: %s", code, output)
		}
		if tc.stage != "" {
			var report diagnosticReport
			if json.Unmarshal(output, &report) != nil || report.Version != 1 || report.Stage != tc.stage {
				t.Fatalf("invalid report: %s", output)
			}
		}
	}
	connection, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	connection.Close()
}
