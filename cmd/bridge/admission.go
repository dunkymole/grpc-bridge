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
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxCredentialBytes = 4096
	maxAdmissionBody   = 16 << 10
	admissionTimeout   = 2 * time.Second
)

func validateAdmissionURL(raw string) error {
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.Fragment != "" || endpoint.Opaque != "" {
		return errors.New("invalid fixed admission URL")
	}
	switch endpoint.Scheme {
	case "https":
		return nil
	case "http":
		host := endpoint.Hostname()
		ip := net.ParseIP(host)
		if strings.EqualFold(host, "localhost") || ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return errors.New("admission URL must use HTTPS (HTTP is limited to loopback)")
}

type admissionRequest struct {
	Version    int    `json:"version"`
	Credential string `json:"credential"`
	Target     string `json:"target"`
}

type admissionResponse struct {
	Version   int    `json:"version"`
	Subject   string `json:"subject"`
	Target    string `json:"target"`
	ExpiresAt int64  `json:"expires_at"`
}

type accessGrant struct {
	subject string
	expires time.Time
}

func newAdmissionHTTPClient() *http.Client {
	return &http.Client{
		Timeout: admissionTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// authorizeTarget asks one fixed operator-configured service to independently
// grant the already-resolved static destination to a principal.
func (g *gateway) authorizeTarget(ctx context.Context, credential, target string) (accessGrant, int) {
	if len(credential) == 0 || len(credential) > maxCredentialBytes || !utf8.ValidString(credential) {
		return accessGrant{}, http.StatusUnauthorized
	}
	body, err := json.Marshal(admissionRequest{Version: 1, Credential: credential, Target: target})
	if err != nil {
		return accessGrant{}, http.StatusServiceUnavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, g.admissionURL, bytes.NewReader(body))
	if err != nil {
		return accessGrant{}, http.StatusServiceUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	client := g.admissionClient
	if client == nil {
		client = newAdmissionHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return accessGrant{}, http.StatusServiceUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		switch response.StatusCode {
		case http.StatusUnauthorized:
			return accessGrant{}, http.StatusUnauthorized
		case http.StatusForbidden:
			return accessGrant{}, http.StatusForbidden
		default:
			return accessGrant{}, http.StatusServiceUnavailable
		}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxAdmissionBody+1))
	if err != nil || len(data) > maxAdmissionBody {
		return accessGrant{}, http.StatusServiceUnavailable
	}
	var grant admissionResponse
	if err := decodeStrictJSON(data, &grant); err != nil || grant.Version != 1 || grant.Target != target || !validSubject(grant.Subject) {
		return accessGrant{}, http.StatusForbidden
	}
	now := time.Now()
	expires := time.Unix(grant.ExpiresAt, 0)
	if grant.ExpiresAt <= 0 || !expires.After(now) || g.maxGrantLifetime <= 0 || expires.After(now.Add(g.maxGrantLifetime)) {
		return accessGrant{}, http.StatusForbidden
	}
	return accessGrant{subject: grant.Subject, expires: expires}, 0
}

func validSubject(subject string) bool {
	if subject == "" || len(subject) > 256 || strings.TrimSpace(subject) != subject || !utf8.ValidString(subject) {
		return false
	}
	for _, r := range subject {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// decodeStrictJSON rejects unknown fields, duplicate object keys, multiple
// top-level values, and non-object roots before accepting a security decision.
func decodeStrictJSON(data []byte, destination any) error {
	if !utf8.Valid(data) {
		return errors.New("invalid UTF-8 in JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	root, err := scanJSONValue(decoder)
	if err != nil {
		return err
	}
	if root != json.Delim('{') {
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

func scanJSONValue(decoder *json.Decoder) (json.Token, error) {
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
				return nil, errors.New("invalid JSON object key")
			}
			if strings.ToLower(key) != key {
				return nil, fmt.Errorf("JSON object key %q is not canonical lowercase", key)
			}
			if _, exists := seen[key]; exists {
				return nil, fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			if _, err := scanJSONValue(decoder); err != nil {
				return nil, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return nil, errors.New("unterminated JSON object")
		}
	case '[':
		for decoder.More() {
			if _, err := scanJSONValue(decoder); err != nil {
				return nil, err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return nil, errors.New("unterminated JSON array")
		}
	default:
		return nil, errors.New("unexpected JSON delimiter")
	}
	return token, nil
}
