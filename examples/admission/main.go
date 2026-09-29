package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"time"
)

func main() {
	listen := flag.String("listen", env("ADMISSION_LISTEN", "127.0.0.1:8081"), "private admission HTTP listener")
	issuer := flag.String("issuer", os.Getenv("JWT_ISSUER"), "required JWT issuer")
	audience := flag.String("audience", os.Getenv("JWT_AUDIENCE"), "required JWT audience")
	jwksURL := flag.String("jwks-url", os.Getenv("JWKS_URL"), "fixed operator-configured JWKS URL")
	grantLifetime := flag.Duration("max-grant-lifetime", envDuration("MAX_ADMISSION_GRANT_LIFETIME", 10*time.Minute), "maximum time returned grants may remain valid")
	flag.Parse()
	if *listen == "" || *issuer == "" || *audience == "" || *jwksURL == "" || *grantLifetime <= 0 || *grantLifetime > 24*time.Hour {
		log.Fatal("listen, issuer, audience, JWKS URL, and bounded positive grant lifetime are required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	verifier, err := newVerifier(ctx, *issuer, *audience, *jwksURL, *grantLifetime)
	if err != nil {
		log.Fatal("could not configure the admission verifier")
	}
	server := &http.Server{
		Addr:              *listen,
		Handler:           verifier,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8192,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("reference admission verifier listening on %s", *listen)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal("admission verifier stopped")
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		log.Fatalf("%s must be a Go duration", name)
	}
	return parsed
}
