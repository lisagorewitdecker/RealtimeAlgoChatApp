# Security Policy

## Supported Versions

This project does not publish versioned releases at this time. Security fixes
are applied to the latest commit on the `main` branch only.

| Branch | Supported          |
| ------ | ------------------ |
| main   | :white_check_mark: |

## Reporting a Vulnerability

To report a security vulnerability, please use
[GitHub Security Advisories](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/security/advisories/new)
to disclose it privately.

Please include the following in your report:

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any relevant code snippets or screenshots

You can expect an initial response within 7 days. If we confirm the
vulnerability, we will prioritize a fix and notify you when it is resolved. If
we decline the report, we will explain why. Please do not disclose the
vulnerability publicly until we have addressed it.

## Security Model and Known Limitations

deepmerge 4.3.1 has no published fix for GHSA-gcqx-w48m-w2h4. The workspace
applies `patches/deepmerge@4.3.1.patch` to its source, CommonJS, and UMD builds.
The patch filters `__proto__`, `constructor`, and `prototype` keys from both
merge inputs before reading their values, and defines own data properties on
the result instead of invoking inherited setters. These reserved keys are
intentionally omitted; ordinary merge options and enumerable symbols remain
supported. Run `node --test scripts/tests/deepmerge-security-patch.test.mjs`
after dependency updates. Keep the patch until an upstream fix is available.
Dependabot may continue reporting the version despite this local mitigation.
Modern Glob dependencies are overridden to 14.0.2 for GHSA-3g3m-2fjr-6pw4,
which fixes filesystem traversal continuing after AbortSignal cancellation.
Glob 7 consumers are outside this advisory's affected range and are unchanged.
Run `node --test scripts/tests/glob-security-patch.test.mjs` after dependency
updates to verify cancellation and normal traversal behavior.

[`threat_model.md`](threat_model.md) describes the trust boundaries, the
controls in place, and the limitations we already know about. Before
reporting, please check its "Known Limitations and Deferred Work" section and
the end-to-end encryption notes under "Information Disclosure". In short:

- The server is trusted for E2EE key distribution, room keys are not rotated
  after a kick or ban, and WebRTC signaling is relayed by the server.
- Live sockets are not disconnected when a Clerk session signs out or is
  revoked; account bans and room kicks/bans do disconnect them.
- There is no full Content Security Policy; responses send
  `X-Content-Type-Options: nosniff`, and the room call/sandbox documents
  forbid framing.
- Rate limits and the assistant cooldown are per API instance, and per-IP
  limits assume exactly one trusted proxy hop.
- The Sentry DSN in the repository history is a public ingestion identifier by
  design.

Reports that show new impact beyond these documented limitations are welcome.

## Deployment Configuration

Administrator privileges come only from the `ADMIN_USER_IDS` environment
variable (comma-separated Clerk user IDs). `MAIN_ADMIN_EMAIL` names the owner's
Clerk account, the only account allowed to select the owner's display name;
set it in Replit Secrets/Configurations for the deployment. When it is unset
no account can newly set that name (display names already stored are still
shown) and the API logs a warning at startup. Neither value belongs in the
repository.
