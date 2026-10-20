package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

func (target *targetPolicy) UnmarshalJSON(data []byte) error {
	var fields struct {
		Address *string         `json:"address"`
		TLS     json.RawMessage `json:"tls"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fields); err != nil || fields.Address == nil {
		return errors.New("target entry requires an address and optional boolean tls setting")
	}
	if len(fields.TLS) != 0 && (bytes.Equal(bytes.TrimSpace(fields.TLS), []byte("null")) || json.Unmarshal(fields.TLS, &target.TLS) != nil) {
		return errors.New("target tls setting must be boolean")
	}
	target.Address = *fields.Address
	return nil
}

// Flags take precedence even when the overridden environment value is malformed.
func overriddenEnvironment(name string) bool {
	names := map[string]string{"MAX_CONNECTIONS_PER_PRINCIPAL": "max-connections-per-principal", "MAX_ADMISSION_GRANT_LIFETIME": "max-grant-lifetime", "MAX_TUNNEL_LIFETIME": "max-tunnel-lifetime", "DRAIN_GRACE_PERIOD": "drain-grace-period"}
	for _, arg := range os.Args[1:] {
		if arg == "--" {
			break
		}
		if !strings.HasPrefix(arg, "-") {
			continue
		}
		key := strings.SplitN(strings.TrimLeft(arg, "-"), "=", 2)[0]
		if key == names[name] {
			return true
		}
	}
	return false
}

func validAddress(address string, emptyHost, zeroPort bool) bool {
	host, port, err := net.SplitHostPort(address)
	n, portErr := strconv.Atoi(port)
	minimum := 1
	if zeroPort {
		minimum = 0
	}
	return err == nil && portErr == nil && n >= minimum && n <= 65535 && (emptyHost || host != "") && !strings.ContainsAny(host, "/@?#\\ \t\r\n")
}
func validDestination(target string) bool {
	return len(target) <= 320 && validAddress(target, false, false)
}

func validTargetLabel(label string) bool {
	if len(label) < 1 || len(label) > 63 || label[0] < 'a' || label[0] > 'z' {
		return false
	}
	for i := 1; i < len(label); i++ {
		c := label[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// All errors deliberately omit file paths, JSON contents, and configured values.
func readTargetPolicy(path string) (map[string]targetPolicy, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("targets-file cannot be opened")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(data) > 65536 {
		return nil, errors.New("targets-file cannot be read or exceeds 64 KiB")
	}
	var policy struct {
		Targets map[string]targetPolicy `json:"targets"`
	}
	if decodeStrictJSON(data, &policy) != nil || policy.Targets == nil {
		return nil, errors.New("targets-file must contain a targets object with valid policy fields")
	}
	for label, target := range policy.Targets {
		if !validTargetLabel(label) || !validDestination(target.Address) {
			return nil, errors.New("targets-file contains an invalid target label or address")
		}
	}
	return policy.Targets, nil
}

func validateOfflineSettings(listen, health, defaultTarget, origin, targets, cert, key string) error {
	if !validAddress(listen, true, true) {
		return errors.New("listen must be a TCP host:port address")
	}
	if !validAddress(health, true, false) {
		return errors.New("health-listen must be a TCP host:port address with a concrete port")
	}
	if listen == health {
		return errors.New("listen and health-listen must use different addresses")
	}
	if !validTargetLabel(defaultTarget) {
		return errors.New("default-target must be a valid target label")
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Opaque != "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return errors.New("origin must be an exact HTTP or HTTPS origin without credentials, path, query, or fragment")
	}
	if strings.HasSuffix(parsed.Host, ":") {
		return errors.New("origin must not contain an empty port")
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return errors.New("origin port must be between 1 and 65535")
		}
	}
	policy, err := readTargetPolicy(targets)
	if err != nil {
		return err
	}
	if _, ok := policy[defaultTarget]; !ok {
		return errors.New("default-target is not present in targets-file")
	}
	if (cert == "") != (key == "") {
		return errors.New("tls-cert and tls-key must be configured together")
	}
	if cert != "" {
		if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
			return errors.New("tls-cert and tls-key must be readable PEM files containing a matching certificate and private key")
		}
	}
	return nil
}
