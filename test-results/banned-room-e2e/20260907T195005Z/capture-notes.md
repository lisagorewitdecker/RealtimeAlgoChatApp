# Banned-room E2E error-context capture

**Captured at (UTC):** 2026-09-07T19:50:33Z

## Result

The fresh rerun passed:

- Clerk test-token setup: PASS
- Active-member ban and revisit flow: PASS in 15.2 seconds
- Entire Playwright run: 2 passed in 24.9 seconds
- Exit status: 0
- Fresh Playwright error context: not generated because the test passed

## Recovered prior failure

The prior tracked Playwright context is preserved in
`prior-failure-error-context.md`. It shows a 180-second timeout while the
synthetic owner was still on display-name setup with a visible
`Failed to fetch` alert. The test had not reached the banned-room assertions.

This makes the earlier failure most consistent with a transient frontend/API
startup or reachability problem. The same test passed after both managed
workflows were restarted. No application code was changed for this capture.

## Related artifacts

- `run-summary.txt` — machine-readable rerun status
- `last-run.json` — Playwright's successful-run metadata
- `playwright-output.txt` — concise rerun output
- `prior-failure-error-context.md` — redacted historical page snapshot
