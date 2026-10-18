package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"time"
)

// Reports contain fixed messages only: never peer errors, addresses, or credentials.
type diagnosticReport struct {
	Version int    `json:"version"`
	OK      bool   `json:"ok"`
	Stage   string `json:"stage"`
	Message string `json:"message"`
	TLS     bool   `json:"tls"`
}

func diagnosticFailure(stage, message string, secure bool, code int) (diagnosticReport, int) {
	return diagnosticReport{Version: 1, Stage: stage, Message: message, TLS: secure}, code
}

func diagnosticDestination(c config, target string) (string, bool, bool) {
	if target == "" {
		target = c.upstream
	}
	if !validDestination(target) {
		return "", false, false
	}
	if target == c.upstream {
		return target, c.upstreamTLS, true
	}
	if c.targetsFile == "" {
		return "", false, false
	}
	policy, err := readTargetPolicy(c.targetsFile)
	if err != nil {
		return "", false, false
	}
	entry, ok := policy[target]
	return target, entry.TLS, ok
}

type diagnosticResolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

func diagnoseConnectivity(ctx context.Context, c config, target string, resolver diagnosticResolver) (diagnosticReport, int) {
	destination, secure, allowed := diagnosticDestination(c, target)
	if !allowed {
		return diagnosticFailure("config", "destination is invalid, not allowed, or its policy is unreadable", false, 2)
	}
	host, port, _ := net.SplitHostPort(destination)
	addresses, err := resolver.LookupIPAddr(ctx, host)
	if err != nil || len(addresses) == 0 {
		return diagnosticFailure("dns", "name resolution failed or timed out; check DNS and destination configuration", secure, 3)
	}
	var connection net.Conn
	// All addresses share the one deadline; no second DNS lookup after resolution.
	for index, address := range addresses {
		if ctx.Err() != nil {
			break
		}
		attempt := ctx
		cancel := func() {}
		if deadline, ok := ctx.Deadline(); ok {
			attempt, cancel = context.WithTimeout(ctx, time.Until(deadline)/time.Duration(len(addresses)-index))
		}
		connection, err = (&net.Dialer{}).DialContext(attempt, "tcp", net.JoinHostPort(address.String(), port))
		cancel()
		if err == nil {
			break
		}
	}
	if connection == nil {
		return diagnosticFailure("tcp", "connection failed or timed out; check listener, routing, and firewall", secure, 4)
	}
	defer closeTransportConn(connection)
	if secure {
		tlsConnection := tls.Client(connection, &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"h2"}, RootCAs: c.upstreamRoots, ServerName: host})
		if err := tlsConnection.HandshakeContext(ctx); err != nil {
			return diagnosticFailure("tls", "TLS handshake or certificate validation failed or timed out; check trust, hostname, validity, and TLS configuration", true, 5)
		}
		if tlsConnection.ConnectionState().NegotiatedProtocol != "h2" {
			return diagnosticFailure("alpn", "backend did not negotiate h2; enable HTTP/2 ALPN", true, 6)
		}
	}
	message := "DNS and TCP checks passed; plaintext HTTP/2 and RPC behavior were not probed"
	if secure {
		message = "DNS, TCP, certificate validation, and h2 ALPN checks passed; RPC behavior was not probed"
	}
	return diagnosticReport{Version: 1, OK: true, Stage: "complete", Message: message, TLS: secure}, 0
}

func runConnectivityDiagnostic(output io.Writer, c config, target string, timeout time.Duration) int {
	var report diagnosticReport
	var code int
	if timeout <= 0 || timeout > time.Minute {
		report, code = diagnosticFailure("config", "diagnostic-timeout must be positive and at most 1m", false, 2)
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		report, code = diagnoseConnectivity(ctx, c, target, net.DefaultResolver)
	}
	if json.NewEncoder(output).Encode(report) != nil {
		return 1
	}
	return code
}
