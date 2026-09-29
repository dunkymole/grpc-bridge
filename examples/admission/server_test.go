package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MicahParks/jwkset"
	"github.com/golang-jwt/jwt/v5"
)

func TestVerifierValidJWTAndExactDestinationScope(t *testing.T) {
	keys := newKeyPair(t, "key-one")
	jwks, set := serveJWKS(t, keys)
	defer jwks.Close()
	verifier, cancel := newTestVerifier(t, jwks.URL)
	defer cancel()

	valid := signedToken(t, keys[0].private, claimsFor(time.Now().Add(time.Minute), time.Now().Add(-time.Minute), "tenant-1", "https://issuer.example", []string{"backend.internal:443"}), "key-one", nil)
	result := requestVerifier(t, verifier, valid, "backend.internal:443")
	if result.Code != http.StatusOK {
		t.Fatalf("valid token denied: %d %s", result.Code, result.Body.String())
	}
	var grant response
	if err := json.Unmarshal(result.Body.Bytes(), &grant); err != nil {
		t.Fatal(err)
	}
	if grant.Version != 1 || grant.Subject != "tenant-1" || grant.Target != "backend.internal:443" || grant.ExpiresAt <= time.Now().Unix() || grant.ExpiresAt > time.Now().Add(30*time.Second).Unix() {
		t.Fatalf("grant exceeded configured scope/lifetime: %#v", grant)
	}

	result = requestVerifier(t, verifier, valid, "other.internal:443")
	if result.Code != http.StatusForbidden {
		t.Fatalf("wrong destination was not forbidden: %d", result.Code)
	}
	_ = set
}

func TestVerifierRejectsIssuerAudienceTimesAlgorithmsAndKeys(t *testing.T) {
	keys := newKeyPair(t, "key-one")
	jwks, _ := serveJWKS(t, keys)
	defer jwks.Close()
	verifier, cancel := newTestVerifier(t, jwks.URL)
	defer cancel()
	now := time.Now()
	cases := []struct {
		name  string
		claim claims
		alg   jwt.SigningMethod
		kid   string
		extra map[string]any
	}{
		{"wrong issuer", claimsFor(now.Add(time.Minute), now.Add(-time.Minute), "u", "https://wrong.example", []string{"backend.internal:443"}), jwt.SigningMethodRS256, "key-one", nil},
		{"wrong audience", claimsForAudience(now.Add(time.Minute), now.Add(-time.Minute), "u", []string{"other"}, []string{"backend.internal:443"}), jwt.SigningMethodRS256, "key-one", nil},
		{"expired", claimsFor(now.Add(-time.Minute), now.Add(-2*time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), jwt.SigningMethodRS256, "key-one", nil},
		{"not yet valid", claimsFor(now.Add(time.Minute), now.Add(time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), jwt.SigningMethodRS256, "key-one", nil},
		{"missing nbf", claims{RegisteredClaims: jwt.RegisteredClaims{Issuer: "https://issuer.example", Subject: "u", Audience: jwt.ClaimStrings{"grpc-bridge"}, ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute))}, Targets: []string{"backend.internal:443"}}, jwt.SigningMethodRS256, "key-one", nil},
		{"disallowed algorithm", claimsFor(now.Add(time.Minute), now.Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), jwt.SigningMethodHS256, "key-one", nil},
		{"unknown key", claimsFor(now.Add(time.Minute), now.Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), jwt.SigningMethodRS256, "unknown-key", nil},
		{"token jku", claimsFor(now.Add(time.Minute), now.Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), jwt.SigningMethodRS256, "key-one", map[string]any{"jku": "https://attacker.example/jwks.json"}},
		{"token x5u", claimsFor(now.Add(time.Minute), now.Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), jwt.SigningMethodRS256, "key-one", map[string]any{"x5u": "https://attacker.example/cert"}},
		{"unsupported critical extension", claimsFor(now.Add(time.Minute), now.Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), jwt.SigningMethodRS256, "key-one", map[string]any{"crit": []string{"enterprise_scope"}, "enterprise_scope": true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var token string
			if tc.alg == jwt.SigningMethodHS256 {
				token = signedHS256(t, tc.claim, tc.kid)
			} else {
				token = signedToken(t, keys[0].private, tc.claim, tc.kid, tc.extra)
			}
			response := requestVerifier(t, verifier, token, "backend.internal:443")
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("invalid token accepted: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestVerifierJWKSRotationAndUnknownKeyFailsClosed(t *testing.T) {
	first := newKeyPair(t, "key-one")
	second := newKeyPair(t, "key-two")
	jwks, setKeys := serveJWKS(t, first)
	defer jwks.Close()
	verifier, cancel := newTestVerifier(t, jwks.URL)
	defer cancel()
	now := time.Now()
	old := signedToken(t, first[0].private, claimsFor(now.Add(time.Minute), now.Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), "key-one", nil)
	if response := requestVerifier(t, verifier, old, "backend.internal:443"); response.Code != http.StatusOK {
		t.Fatalf("initial key failed: %d %s", response.Code, response.Body.String())
	}
	setKeys(second)
	rotated := signedToken(t, second[0].private, claimsFor(now.Add(time.Minute), now.Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), "key-two", nil)
	if response := requestVerifier(t, verifier, rotated, "backend.internal:443"); response.Code != http.StatusOK {
		t.Fatalf("new JWKS key did not rotate in: %d %s", response.Code, response.Body.String())
	}

	unknown := signedToken(t, first[0].private, claimsFor(now.Add(time.Minute), now.Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), "never-published", nil)
	setKeys(nil)
	response := requestVerifier(t, verifier, unknown, "backend.internal:443")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unknown key after rotation did not fail closed: %d", response.Code)
	}
}

func TestVerifierRejectsUnknownKeyDuringJWKSOutage(t *testing.T) {
	keys := newKeyPair(t, "key-one")
	var requestCount atomic.Int32
	var unavailable atomic.Bool
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		if unavailable.Load() {
			http.Error(w, "offline", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write(marshalJWKS(t, keys))
	}))
	defer jwks.Close()
	verifier, cancel := newTestVerifier(t, jwks.URL)
	defer cancel()
	initial := requestCount.Load()
	unavailable.Store(true)
	// A cached key remains usable during an outage, while an unknown key cannot
	// cause an unbounded fetch loop or an allow decision.
	known := signedToken(t, keys[0].private, claimsFor(time.Now().Add(time.Minute), time.Now().Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), "key-one", nil)
	if response := requestVerifier(t, verifier, known, "backend.internal:443"); response.Code != http.StatusOK {
		t.Fatalf("cached key stopped working during JWKS outage: %d", response.Code)
	}
	token := signedToken(t, keys[0].private, claimsFor(time.Now().Add(time.Minute), time.Now().Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), "absent", nil)
	response := requestVerifier(t, verifier, token, "backend.internal:443")
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("verifier outage did not fail closed: %d", response.Code)
	}
	if requestCount.Load() <= initial {
		t.Fatalf("unknown key did not attempt bounded fixed-JWKS refresh")
	}
}

func TestVerifierExcludesJWKEncryptionPurposes(t *testing.T) {
	keys := newKeyPair(t, "key-one")
	metadata := []struct {
		name  string
		field string
		value any
	}{
		{"use encryption", "use", "enc"},
		{"key operations omit verify", "key_ops", []string{"encrypt"}},
	}
	for _, tc := range metadata {
		t.Run(tc.name, func(t *testing.T) {
			var document map[string]any
			if err := json.Unmarshal(marshalJWKS(t, keys), &document); err != nil {
				t.Fatal(err)
			}
			jwk := document["keys"].([]any)[0].(map[string]any)
			jwk[tc.field] = tc.value
			data, err := json.Marshal(document)
			if err != nil {
				t.Fatal(err)
			}
			jwks := serveJWKSBytes(data)
			defer jwks.Close()
			verifier, cancel := newTestVerifier(t, jwks.URL)
			defer cancel()
			token := signedToken(t, keys[0].private, claimsFor(time.Now().Add(time.Minute), time.Now().Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), "key-one", nil)
			if response := requestVerifier(t, verifier, token, "backend.internal:443"); response.Code != http.StatusUnauthorized {
				t.Fatalf("JWK declared for encryption was accepted: %d", response.Code)
			}
		})
	}

	var document map[string]any
	if err := json.Unmarshal(marshalJWKS(t, keys), &document); err != nil {
		t.Fatal(err)
	}
	jwk := document["keys"].([]any)[0].(map[string]any)
	jwk["use"] = "sig"
	jwk["key_ops"] = []string{"verify"}
	data, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	jwks := serveJWKSBytes(data)
	defer jwks.Close()
	verifier, cancel := newTestVerifier(t, jwks.URL)
	defer cancel()
	token := signedToken(t, keys[0].private, claimsFor(time.Now().Add(time.Minute), time.Now().Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), "key-one", nil)
	if response := requestVerifier(t, verifier, token, "backend.internal:443"); response.Code != http.StatusOK {
		t.Fatalf("signature-purpose JWK was rejected: %d %s", response.Code, response.Body.String())
	}
}

func TestVerifierDoesNotFollowJWKSRedirect(t *testing.T) {
	keys := newKeyPair(t, "key-one")
	var redirectHits atomic.Int32
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectHits.Add(1)
		_, _ = w.Write(marshalJWKS(t, keys))
	}))
	defer redirectTarget.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, redirectTarget.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	verifier, cancel := newTestVerifier(t, redirect.URL)
	defer cancel()
	token := signedToken(t, keys[0].private, claimsFor(time.Now().Add(time.Minute), time.Now().Add(-time.Minute), "u", "https://issuer.example", []string{"backend.internal:443"}), "key-one", nil)
	if response := requestVerifier(t, verifier, token, "backend.internal:443"); response.Code != http.StatusUnauthorized {
		t.Fatalf("token unexpectedly verified through JWKS redirect: %d", response.Code)
	}
	if redirectHits.Load() != 0 {
		t.Fatalf("JWKS redirect target received %d requests", redirectHits.Load())
	}
}

func TestJWKSFilterRejectsAmbiguousAndOversizedDocuments(t *testing.T) {
	for _, data := range [][]byte{
		[]byte(`{"keys":[],"keys":[]}`),
		[]byte("{\"keys\":[]}" + string([]byte{0xff})),
	} {
		if _, err := signatureOnlyJWKS(data); err == nil {
			t.Fatal("accepted ambiguous or invalid UTF-8 JWKS")
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("12345"))
	}))
	defer server.Close()
	client := &http.Client{Transport: boundedRoundTripper{base: http.DefaultTransport, max: 4}}
	request, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Do(request); err == nil {
		t.Fatal("accepted oversized JWKS response")
	}
}

type testKey struct {
	kid     string
	private *rsa.PrivateKey
}

func newKeyPair(t *testing.T, kid string) []testKey {
	t.Helper()
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return []testKey{{kid: kid, private: private}}
}

func serveJWKS(t *testing.T, keys []testKey) (*httptest.Server, func([]testKey)) {
	t.Helper()
	var current atomic.Value
	current.Store(marshalJWKS(t, keys))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(current.Load().([]byte))
	}))
	return server, func(keys []testKey) { current.Store(marshalJWKS(t, keys)) }
}

func serveJWKSBytes(data []byte) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
	}))
}

func marshalJWKS(t *testing.T, keys []testKey) []byte {
	t.Helper()
	set := jwkset.JWKSMarshal{}
	for _, key := range keys {
		jwk, err := jwkset.NewJWKFromKey(&key.private.PublicKey, jwkset.JWKOptions{Metadata: jwkset.JWKMetadataOptions{KID: key.kid, ALG: jwkset.AlgRS256}})
		if err != nil {
			t.Fatal(err)
		}
		set.Keys = append(set.Keys, jwk.Marshal())
	}
	data, err := json.Marshal(set)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func newTestVerifier(t *testing.T, jwksURL string) (*verifier, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	verifier, err := newVerifier(ctx, "https://issuer.example", "grpc-bridge", jwksURL, 30*time.Second)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	return verifier, cancel
}

func claimsFor(exp, nbf time.Time, subject, issuer string, targets []string) claims {
	return claimsForAudience(exp, nbf, subject, []string{"grpc-bridge"}, targets).withIssuer(issuer)
}

func claimsForAudience(exp, nbf time.Time, subject string, audience []string, targets []string) claims {
	return claims{RegisteredClaims: jwt.RegisteredClaims{
		Subject: subject, Audience: jwt.ClaimStrings(audience), ExpiresAt: jwt.NewNumericDate(exp), NotBefore: jwt.NewNumericDate(nbf),
	}, Targets: targets}
}

func (c claims) withIssuer(issuer string) claims {
	c.Issuer = issuer
	return c
}

func signedToken(t *testing.T, key *rsa.PrivateKey, value claims, kid string, extra map[string]any) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, value)
	token.Header["kid"] = kid
	for name, value := range extra {
		token.Header[name] = value
	}
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func signedHS256(t *testing.T, value claims, kid string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, value)
	token.Header["kid"] = kid
	signed, err := token.SignedString([]byte("test key"))
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

func requestVerifier(t *testing.T, v *verifier, credential, target string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(request{Version: 1, Credential: credential, Target: target})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/v1/admit", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	v.ServeHTTP(w, r)
	return w
}

func TestVerifierRejectsMalformedAdmissionRequests(t *testing.T) {
	keys := newKeyPair(t, "key-one")
	jwks, _ := serveJWKS(t, keys)
	defer jwks.Close()
	verifier, cancel := newTestVerifier(t, jwks.URL)
	defer cancel()
	for _, body := range []string{
		`{"version":1,"credential":"x","target":"backend.internal:443","target":"other:443"}`,
		`{"version":1,"credential":"x","CREDENTIAL":"y","target":"backend.internal:443"}`,
		`{"version":1,"credential":"x","target":"backend.internal:443","extra":true}`,
		`{"version":1,"credential":"x","target":"backend.internal:443"} {}`,
	} {
		r := httptest.NewRequest(http.MethodPost, "/v1/admit", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		verifier.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("malformed admission request accepted: %d", w.Code)
		}
	}
}

func TestTargetValidationIsExactAndBounded(t *testing.T) {
	for _, target := range []string{"backend.internal:443", "[::1]:50051"} {
		if !validTarget(target) {
			t.Errorf("rejected valid target %q", target)
		}
	}
	for _, target := range []string{"", "backend:0", "backend:65536", "host/path:443", "host:0443", "host:443\n", fmt.Sprintf("%s:443", strings.Repeat("a", 321))} {
		if validTarget(target) {
			t.Errorf("accepted invalid target %q", target)
		}
	}
}
