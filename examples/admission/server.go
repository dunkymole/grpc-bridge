package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/time/rate"
)

const (
	maxRequestBytes = 8 << 10
	maxCredential   = 4096
	maxTarget       = 320
	maxJWKSBytes    = 1 << 20
)

type request struct {
	Version    int    `json:"version"`
	Credential string `json:"credential"`
	Target     string `json:"target"`
}

type response struct {
	Version   int    `json:"version"`
	Subject   string `json:"subject"`
	Target    string `json:"target"`
	ExpiresAt int64  `json:"expires_at"`
}

type claims struct {
	jwt.RegisteredClaims
	Targets []string `json:"targets"`
}

func (c claims) Validate() error {
	if c.Subject == "" || len(c.Subject) > 256 || strings.TrimSpace(c.Subject) != c.Subject {
		return errors.New("subject is missing or too long")
	}
	for _, r := range c.Subject {
		if unicode.IsControl(r) {
			return errors.New("subject contains control characters")
		}
	}
	if c.ExpiresAt == nil || c.NotBefore == nil {
		return errors.New("exp and nbf are required")
	}
	if len(c.Targets) == 0 || len(c.Targets) > 128 {
		return errors.New("targets claim is missing or too large")
	}
	for _, target := range c.Targets {
		if !validTarget(target) {
			return errors.New("targets claim contains an invalid destination")
		}
	}
	return nil
}

type verifier struct {
	issuer, audience string
	maxGrantLifetime time.Duration
	keys             keyfunc.Keyfunc
}

func newVerifier(ctx context.Context, issuer, audience, jwksURL string, grantLifetime time.Duration) (*verifier, error) {
	if issuer == "" || audience == "" || grantLifetime <= 0 || grantLifetime > 24*time.Hour {
		return nil, errors.New("invalid verifier configuration")
	}
	if err := validateJWKSURL(jwksURL); err != nil {
		return nil, err
	}
	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: boundedRoundTripper{base: http.DefaultTransport, max: maxJWKSBytes},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	noInitialError := true
	keys, err := keyfunc.NewDefaultOverrideCtx(ctx, []string{jwksURL}, keyfunc.Override{
		Client:                    client,
		HTTPTimeout:               2 * time.Second,
		RefreshInterval:           5 * time.Minute,
		RefreshUnknownKID:         rate.NewLimiter(rate.Every(30*time.Second), 1),
		RateLimitWaitMax:          time.Second,
		NoErrorReturnFirstHTTPReq: &noInitialError,
	})
	if err != nil {
		return nil, err
	}
	return &verifier{issuer: issuer, audience: audience, maxGrantLifetime: grantLifetime, keys: keys}, nil
}

func (v *verifier) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/admit" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.Header.Get("Content-Type") != "application/json" {
		http.Error(w, "invalid admission request", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes+1))
	if err != nil || len(body) > maxRequestBytes {
		http.Error(w, "invalid admission request", http.StatusBadRequest)
		return
	}
	var input request
	if err := decodeStrict(body, &input); err != nil || input.Version != 1 || !validTarget(input.Target) || len(input.Credential) == 0 || len(input.Credential) > maxCredential {
		http.Error(w, "invalid admission request", http.StatusBadRequest)
		return
	}
	parsed, err := jwt.ParseWithClaims(input.Credential, &claims{}, v.keyForToken,
		jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
		jwt.WithExpirationRequired(),
	)
	if err != nil || parsed == nil || !parsed.Valid {
		http.Error(w, "admission denied", http.StatusUnauthorized)
		return
	}
	verified, ok := parsed.Claims.(*claims)
	if !ok || !containsTarget(verified.Targets, input.Target) {
		http.Error(w, "admission denied", http.StatusForbidden)
		return
	}
	now := time.Now()
	expires := verified.ExpiresAt.Time
	limit := now.Add(v.maxGrantLifetime)
	if expires.After(limit) {
		expires = limit
	}
	if !expires.After(now) {
		http.Error(w, "admission denied", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(response{Version: 1, Subject: verified.Subject, Target: input.Target, ExpiresAt: expires.Unix()})
}

func (v *verifier) keyForToken(token *jwt.Token) (any, error) {
	// This verifier implements no critical JOSE extensions. RFC 7515 requires
	// rejecting a token that marks an unsupported extension as critical.
	if _, exists := token.Header["crit"]; exists {
		return nil, errors.New("critical JWT extensions are not supported")
	}
	if _, exists := token.Header["jku"]; exists {
		return nil, errors.New("token jku header is not accepted")
	}
	if _, exists := token.Header["x5u"]; exists {
		return nil, errors.New("token x5u header is not accepted")
	}
	if token.Method != jwt.SigningMethodRS256 {
		return nil, errors.New("token algorithm is not allowed")
	}
	kid, ok := token.Header["kid"].(string)
	if !ok || kid == "" || len(kid) > 128 {
		return nil, errors.New("token key id is invalid")
	}
	return v.keys.Keyfunc(token)
}

func validateJWKSURL(raw string) error {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" || endpoint.Opaque != "" {
		return errors.New("invalid fixed JWKS URL")
	}
	if endpoint.Scheme == "https" {
		return nil
	}
	if endpoint.Scheme == "http" {
		host := endpoint.Hostname()
		ip := net.ParseIP(host)
		if strings.EqualFold(host, "localhost") || ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return errors.New("JWKS URL must use HTTPS (HTTP is limited to loopback)")
}

func validTarget(target string) bool {
	if target == "" || len(target) > maxTarget || !utf8.ValidString(target) || strings.ContainsAny(target, "/@?#\\ \t\r\n") {
		return false
	}
	host, port, err := net.SplitHostPort(target)
	if err != nil || host == "" {
		return false
	}
	for _, r := range host {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	var number int
	if _, err := fmt.Sscanf(port, "%d", &number); err != nil || number < 1 || number > 65535 || fmt.Sprint(number) != port {
		return false
	}
	return true
}

func containsTarget(targets []string, target string) bool {
	for _, candidate := range targets {
		if candidate == target {
			return true
		}
	}
	return false
}

func decodeStrict(data []byte, destination any) error {
	if !utf8.Valid(data) {
		return errors.New("invalid JSON UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	root, err := scanValue(decoder)
	if err != nil || root != json.Delim('{') {
		return errors.New("JSON object required")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	decoder = json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func scanValue(decoder *json.Decoder) (json.Token, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}
	switch delim {
	case '{':
		keys := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok || strings.ToLower(key) != key {
				return nil, errors.New("JSON object keys must use canonical lowercase spelling")
			}
			if _, exists := keys[key]; exists {
				return nil, errors.New("duplicate JSON object key")
			}
			keys[key] = struct{}{}
			if _, err := scanValue(decoder); err != nil {
				return nil, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return nil, errors.New("unterminated JSON object")
		}
	case '[':
		for decoder.More() {
			if _, err := scanValue(decoder); err != nil {
				return nil, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return nil, errors.New("unterminated JSON array")
		}
	default:
		return nil, fmt.Errorf("unexpected JSON delimiter: %c", delim)
	}
	return token, nil
}

type boundedRoundTripper struct {
	base http.RoundTripper
	max  int64
}

func (b boundedRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	base := b.base
	if base == nil {
		base = http.DefaultTransport
	}
	response, err := base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if response.ContentLength > b.max {
		response.Body.Close()
		return nil, errors.New("JWKS response exceeds configured limit")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, b.max+1))
	_ = response.Body.Close()
	if err != nil || int64(len(data)) > b.max {
		return nil, errors.New("JWKS response exceeds configured limit or could not be read")
	}
	if response.StatusCode == http.StatusOK {
		data, err = signatureOnlyJWKS(data)
		if err != nil {
			return nil, errors.New("JWKS response is invalid or contains no acceptable key metadata")
		}
	}
	response.Body = io.NopCloser(bytes.NewReader(data))
	response.ContentLength = int64(len(data))
	response.Header.Set("Content-Length", fmt.Sprint(len(data)))
	return response, nil
}

// signatureOnlyJWKS leaves key parsing to jwkset but excludes keys declared
// solely for encryption. An absent use/key_ops remains valid; when either is
// present it must permit signature verification.
func signatureOnlyJWKS(data []byte) ([]byte, error) {
	if !utf8.Valid(data) {
		return nil, errors.New("JWKS is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	root, err := scanUniqueValue(decoder)
	if err != nil || root != json.Delim('{') {
		return nil, errors.New("JWKS must be a unique-key JSON object")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("trailing JWKS data")
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	keysData, ok := document["keys"]
	if !ok {
		return nil, errors.New("JWKS keys member is required")
	}
	var keys []json.RawMessage
	if err := json.Unmarshal(keysData, &keys); err != nil {
		return nil, err
	}
	filtered := make([]json.RawMessage, 0, len(keys))
	for _, raw := range keys {
		var key map[string]json.RawMessage
		if err := json.Unmarshal(raw, &key); err != nil {
			return nil, err
		}
		for _, member := range []string{"use", "key_ops"} {
			for name := range key {
				if strings.EqualFold(name, member) && name != member {
					return nil, fmt.Errorf("noncanonical JWKS member %q", name)
				}
			}
		}
		if rawUse, exists := key["use"]; exists {
			var use string
			if err := json.Unmarshal(rawUse, &use); err != nil || use != "sig" {
				continue
			}
		}
		if rawOps, exists := key["key_ops"]; exists {
			var operations []string
			if err := json.Unmarshal(rawOps, &operations); err != nil || !slices.Contains(operations, "verify") {
				continue
			}
		}
		filtered = append(filtered, raw)
	}
	document["keys"], err = json.Marshal(filtered)
	if err != nil {
		return nil, err
	}
	return json.Marshal(document)
}

func scanUniqueValue(decoder *json.Decoder) (json.Token, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errors.New("invalid JWKS object member")
			}
			if _, exists := seen[key]; exists {
				return nil, fmt.Errorf("duplicate JWKS member %q", key)
			}
			seen[key] = struct{}{}
			if _, err := scanUniqueValue(decoder); err != nil {
				return nil, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return nil, errors.New("unterminated JWKS object")
		}
	case '[':
		for decoder.More() {
			if _, err := scanUniqueValue(decoder); err != nil {
				return nil, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return nil, errors.New("unterminated JWKS array")
		}
	default:
		return nil, errors.New("unexpected JWKS delimiter")
	}
	return token, nil
}
