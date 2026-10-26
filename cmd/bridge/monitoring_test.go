package main

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestVersionedDashboardUsesExportedMetrics(t *testing.T) {
	data, err := os.ReadFile("../../monitoring/grafana/dashboards/grpc-bridge-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var dashboard any
	if err := json.Unmarshal(data, &dashboard); err != nil {
		t.Fatalf("invalid dashboard JSON: %v", err)
	}
	metricSource, err := os.ReadFile("metrics.go")
	if err != nil {
		t.Fatal(err)
	}
	metricPattern := regexp.MustCompile(`bridge_[a-z_]+(?:_total|_bytes|_seconds|_tunnels|_capacity|_draining|_goroutines)?`)
	for _, metric := range metricPattern.FindAllString(string(data), -1) {
		base := strings.TrimSuffix(metric, "_bucket")
		base = strings.TrimSuffix(base, "_count")
		base = strings.TrimSuffix(base, "_sum")
		if !strings.Contains(string(metricSource), `"`+base+`"`) {
			t.Errorf("dashboard query references metric not exported by bridge: %s", metric)
		}
	}
	for _, required := range []string{
		"bridge_active_tunnels", "bridge_tunnel_capacity", "bridge_connections_opened_total",
		"bridge_connections_closed_total", "bridge_connection_failures_total",
		"bridge_bytes_forwarded_total", "bridge_backend_dial_duration_seconds_bucket",
		"bridge_tunnel_expirations_total", "bridge_draining", "bridge_drain_forced_closures_total",
	} {
		if !strings.Contains(string(data), required) {
			t.Errorf("dashboard does not cover %s", required)
		}
	}
}
