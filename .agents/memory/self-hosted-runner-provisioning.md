---
name: Self-hosted GitHub runner provisioning scripts
description: Review-driven rules for scripts that download, register, and service-install GitHub Actions runners (macOS or Linux); what the completion review rejects and how to test macOS-only logic on Linux.
---

Rules the completion code review enforces for runner provisioning scripts:

- Download → digest check → extract must short-circuit explicitly (`|| return 1` / `if ! ...; then return 1`). A multi-command function called from an `if`, `||`, or `&&` context runs with errexit suppressed, so a failed checksum silently falls through to `tar`.
- The registration token goes to `config.sh` through the runner's `ACTIONS_RUNNER_INPUT_TOKEN` environment input, never `--token` on argv (visible to process inspection). Clear the variables right after configure.
- An existing `.runner` is not proof of a usable registration. It stores `agentId` (numeric), `agentName`, and `gitHubUrl` but no labels. Verify name + repository locally, and labels via `gh api repos/<repo>/actions/runners` when authenticated or via a record the script itself wrote at registration; anything unverifiable is MISSING.
- Service install/start (`svc.sh`) must be gated on a verified registration and all core prerequisites; leave an existing service untouched and print remediation otherwise.
- A simulator boot-at-login agent must run `simctl boot <udid>` itself before `simctl bootstatus <udid> -b` (the reviewer treats bootstatus alone as monitoring only).

**Why:** Two consecutive review rejections on the iOS runner script were about exactly these points, even though the Linux dry-run test passed.

**How to apply:** Give the script a sourced-mode guard before its main section (`[[ "${BASH_SOURCE[0]}" != "$0" ]] && return 0`) so the Linux test can `set -- --dry-run; source script`, flip `DRY_RUN=0`, and call individual functions against stubbed `curl`/`tar`/`svc.sh`/`xcrun`/`gh` with the real `sha256sum`. Cover: digest mismatch never calls tar, foreign/unverified registrations never call svc.sh, verified ones do, and the agent command contains both simctl calls.
