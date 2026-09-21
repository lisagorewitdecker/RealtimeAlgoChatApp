# iOS preview launch probe summary

**Result: INCONCLUSIVE**

| Field | Value |
| --- | --- |
| Check time (UTC) | 2026-09-21 12:40:14 |
| Revision | `f4ec1eb07c58` |
| Probe mode | live managed-workflow restart |
| `preview_launch_evidence` | `INCONCLUSIVE` |
| `metro_ready` | `yes` |
| `expo_go_ios_connections` | `2` |
| `other_inspector_connections` | `0` |
| `ios_bundle_http_200` | `0` |
| `inspector_close_code` | `none` |
| `bundle_to_close_seconds` | `n/a` |
| `ios_client_log_lines` | `0` |
| `ios_client_error_lines` | `0` |
| `expo_go_asset_requests` | `0` |
| `ios_lines_before_bundle` | `0` |
| `request_log_lines` | `1` |
| `dev_server_exit` | `signal:SIGHUP` |

The armed run was interrupted by a concurrent main-workspace task merge before
the simulator's replacement session requested its bundle. Earlier attempts in
the same main workspace exposed a transient inspector connection that closed
before the real session connected and fetched one iOS bundle successfully. The
probe now waits through that transient pre-bundle close; its focused regression
suite passes. A clean, uninterrupted device run is still required for a
`RUNNING` result.

This record contains counts and statuses only. It intentionally excludes host,
URL, account, device, and session values.