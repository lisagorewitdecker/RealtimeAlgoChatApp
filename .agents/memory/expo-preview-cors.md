---
name: Expo preview CORS
description: Browser-based Expo previews use a distinct origin for API requests.
---

Include the Expo preview domain in the API's browser-origin allowlist alongside
the normal development and deployment domains.

**Why:** The Expo web preview is served from a distinct origin. Without that
origin, browser CORS preflight can succeed superficially while authenticated
profile requests are blocked before reaching their route handler.

**How to apply:** When adding or reviewing CORS restrictions for this product,
allow the environment-provided Expo preview domain. Native requests remain
originless and should continue to follow the existing native-client policy.