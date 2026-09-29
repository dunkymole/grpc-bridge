# Bridge metrics

`GET /metrics` exposes Prometheus text format 0.0.4 on the bridge HTTP listener.
No exporter, monitoring library, or additional process is required. Counters reset
when the bridge restarts. All series, including zero-valued failures, are emitted.

| Metric | Type | Meaning |
| --- | --- | --- |
| `bridge_active_tunnels` | Gauge | Admission slots occupied, including backend setup. |
| `bridge_established_tunnels` | Gauge | Open tunnels whose WebSocket upgrade response has been flushed. |
| `bridge_tunnel_capacity` | Gauge | Configured maximum admission slots (`-max-connections`). |
| `bridge_draining` | Gauge | 1 after the first shutdown signal; new tunnel admissions are rejected. |
| `bridge_drain_graceful_completions_total` | Counter | Drains completed after tunnels and handshakes ended before the grace deadline. |
| `bridge_drain_forced_closures_total` | Counter | Active tunnels closed at the grace deadline or after a second signal. |
| `bridge_drain_forced_shutdowns_total` | Counter | Shutdowns forced by a second signal or an expired drain grace period. |
| `bridge_connection_attempts_total` | Counter | Requests reaching `/tunnel`, including rejected handshakes. |
| `bridge_connections_opened_total` | Counter | Successfully flushed WebSocket upgrades. |
| `bridge_connections_closed_total` | Counter | Established tunnel handlers that have finished, for any reason, including shutdown. |
| `bridge_connection_failures_total{reason}` | Counter | Failed establishment, once per attempt, with reasons below. Does not count errors after upgrade. |
| `bridge_bytes_forwarded_total{direction}` | Counter | Inner payload bytes accepted by destination writes. Directions: `to_backend`, `to_client`. |
| `bridge_backend_dial_duration_seconds` | Histogram | Time spent resolving/connecting to the backend, including optional TLS handshake and ALPN validation, for both successful and failed dials. |

Failure reasons are a fixed set:

| Reason | Meaning |
| --- | --- |
| `handshake` | Invalid method, upgrade headers, WebSocket key or version |
| `origin` | Browser Origin rejected |
| `auth` | Missing or incorrect tunnel token |
| `profile` | Required tunnel profile not offered |
| `capacity` | No admission slot available |
| `destination` | Malformed destination/query |
| `destination_denied` | Destination not allowed |
| `policy` | Policy file unavailable, invalid, or too large |
| `dial` | DNS, TCP, TLS, or ALPN failure |
| `upgrade` | HTTP hijacking or upgrade-response write failure |
| `shutdown` | Bridge stopping before upgrade |

The first rejection determines the reason. Requests rejected by Go's HTTP server
before reaching the handler (for example malformed HTTP) are not included.
Normal and abnormal closures after upgrade both increment the closed counter;
the bridge does not classify individual RPC failures or decode gRPC status.

Byte counts exclude WebSocket headers/control frames and TCP/TLS overhead, but
include inner HTTP/2 headers and controls. Partial successful writes are counted
even if the same write returns an error. Counts indicate acceptance by the local
destination writer, not acknowledgement or consumption by the remote application.

Dial histogram boundaries in seconds are `0.001, 0.005, 0.01, 0.025, 0.05, 0.1,
0.25, 0.5, 1, 2.5, 5, 10, +Inf`. Standard cumulative `_bucket{le}`, `_sum`, and
`_count` series are emitted. Policy-file reading and health-check dials are excluded.
A rejected request that never dials does not add a histogram observation.

Counters use atomics; the histogram uses a short lock per completed dial and
snapshot. Scraping does not hold a metrics lock while writing the HTTP response.
Individual counters are sampled independently, so concurrent activity can cause
small temporary differences between related values in one scrape.

Labels never contain destinations, tokens, users, or client addresses. Metric
storage remains bounded as the number of connections and targets grows.

## Example queries

```promql
# Connection establishment failures per second, by reason
sum by (reason) (rate(bridge_connection_failures_total[5m]))

# Forwarded bytes per second in each direction
sum by (direction) (rate(bridge_bytes_forwarded_total[5m]))

# Backend dial p95 across bridge instances
histogram_quantile(0.95,
  sum by (le) (rate(bridge_backend_dial_duration_seconds_bucket[5m])))

# Admission utilization per instance
bridge_active_tunnels / bridge_tunnel_capacity

```

Scrape the bridge's HTTP endpoint from your monitoring system. The local demo is
available at `http://localhost:8080/metrics`. The endpoint shares the listener and
TLS configuration with the tunnel and is not protected by `TUNNEL_TOKEN`; restrict
access at your deployment's network/proxy boundary if exposing the bridge publicly.
Drain counters are process-local and reset on restart. They increment immediately
before shutdown closes the HTTP listeners, so a final scrape is best-effort; the
bridge's shutdown log lines are the authoritative record for a terminating process.
