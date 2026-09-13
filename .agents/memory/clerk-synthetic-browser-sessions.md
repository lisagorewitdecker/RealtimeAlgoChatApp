---
name: Clerk synthetic browser sessions
description: How Clerk development-instance users establish browser trust in deterministic E2E tests.
---

Backend-created `+clerk_test` users can return `needs_client_trust` after a correct password sign-in. Treat that as an expected email-code continuation, not as a failed password or an unverified primary email. Create a backend session and mint its short-lived token before starting browser sign-in; the activation side effect matters even when the browser helper never directly consumes the token.

**Why:** Clerk development instances may require a new browser context to establish device trust. Ignoring the continuation leaves automation waiting on the signed-out screen even though provisioning and credentials succeeded.

**How to apply:** Provision the user, backend session, and token in that order. Select the supported `email_code` factor when prompted, prepare it with its email-address ID, and complete it with Clerk's synthetic test code. Register user IDs and browser contexts immediately so timeout cleanup remains reliable.