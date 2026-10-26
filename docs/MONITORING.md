# Optional monitoring

The versioned [Grafana dashboard](../monitoring/grafana/dashboards/grpc-bridge-v1.json)
and [Prometheus alert examples](../monitoring/prometheus/alerts.yml) are external
operator assets. Grafana and Prometheus are not compiled into the bridge, copied
into its runtime image, or started by the default `compose.yaml` demo.

## Local provisioning

Start the normal demo plus the optional monitoring overlay:

```sh
docker compose -f compose.yaml -f compose.monitoring.yaml up --build -d --wait
```

Grafana is then available at `http://localhost:3000` with the **gRPC Bridge
Operations** dashboard provisioned, and Prometheus at `http://localhost:9090`.
Both published ports bind to loopback by default. Stop the combined stack with:

```sh
docker compose -f compose.yaml -f compose.monitoring.yaml down
```

Anonymous Grafana Viewer access is for this loopback-only example. Do not expose
that configuration publicly. In a real deployment, use the organization's normal
Grafana authentication and import the dashboard JSON or provision it from source.

## Protecting metrics

`/metrics` shares the bridge's public HTTP/TLS listener and is intentionally not
protected by `TUNNEL_TOKEN`. Restrict it at the network boundary: use a private
listener/network, a firewall or security group that only admits Prometheus, or an
authenticating reverse proxy with a route rule for `/metrics`. Keep the tunnel
token out of scrape URLs and configuration. If an ingress exposes the bridge,
explicitly deny `/metrics` on its public route and provide a separate protected
scrape path.

The local overlay reaches `bridge:8080` only on the Compose network. Its published
Prometheus and Grafana ports remain loopback-only unless their `*_BIND` variables
are deliberately changed.

## Aggregation and interpretation

The dashboard's `$instance` selector works with one or many bridge targets.
Counters and traffic rates are summed for fleet observations. Histogram buckets
are summed by `le` before `histogram_quantile`, avoiding an average of per-instance
quantiles. Process heap and goroutine series remain separate by instance.

Admission capacity and principal quotas are enforced independently by each bridge
process. The dashboard therefore graphs utilization per instance. Its fleet active
and capacity totals are observations only: adding them does not create a shared
fleet quota, and an overloaded instance can coexist with idle replicas.

`bridge_tunnel_expirations_total{source="grant"}` records a transport closed when
its admission grant deadline is reached. It does not mean that an already-open
tunnel can be revoked immediately. `source="lifetime"` is the configured maximum
tunnel lifetime. Admission 401/403 responses appear as failure reason `auth`;
verifier availability or invalid-response failures appear as `admission`.

Post-upgrade close reasons are not classified because the bridge is an opaque byte
relay and does not decode RPC status. `bridge_connections_closed_total` includes
all established handlers that finish. Forced-drain counters are updated just
before listener shutdown, so their final scrape is best-effort; shutdown logs are
authoritative for a terminating process.

## Alert examples and validation

The alert thresholds are examples, marked `threshold_status: example`. They cover
sustained per-instance capacity pressure, dial failures, admission rejection
spikes, and backend dial p95. Calibrate durations, minimum traffic, and thresholds
against representative load and recovery evidence before paging.

Validate the checked-in rules and the composed configuration with the same pinned
Prometheus image used by the overlay:

```sh
docker run --rm --entrypoint /bin/promtool \
  -v "$PWD/monitoring/prometheus:/monitoring:ro" \
  prom/prometheus:v3.5.0 check rules /monitoring/alerts.yml
docker compose -f compose.yaml -f compose.monitoring.yaml config --quiet
```

The Go test suite parses the dashboard JSON, checks coverage, and rejects dashboard
metric names that the bridge does not export. The admission lifecycle test drives
a real grant expiry and verifies its metric. For a visual/local check, start the
overlay, exercise the demo, select the `grpc-bridge` job in Grafana, and confirm
the selected instance produces tunnel, traffic, and dial series.
