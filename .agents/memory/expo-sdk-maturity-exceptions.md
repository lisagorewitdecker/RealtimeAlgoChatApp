---
name: Expo SDK maturity exceptions
description: How to handle same-day official Expo SDK dependency releases under the workspace package-age policy.
---

When upgrading Expo SDKs, keep the workspace minimum release age enabled and add only the specific official Expo packages required by the SDK dependency chain to `minimumReleaseAgeExclude`.

**Why:** The package-age firewall can reject a valid SDK upgrade because Expo publishes core and tightly coupled transitive packages together. Disabling the policy globally would weaken supply-chain protection for unrelated dependencies.

**How to apply:** Let Expo’s compatibility installer identify the next blocked package, add that package name narrowly, and rerun the install. Finish with `expo install --check` and `expo-doctor`; remove exceptions that are no longer needed when the package-age window has passed.