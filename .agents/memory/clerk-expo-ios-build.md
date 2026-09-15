---
name: Clerk Expo iOS builds
description: Why the @clerk/expo config plugin is mandatory for native iOS builds of the Chat App and how its absence shows up in pod install logs.
---

Keep `@clerk/expo` in the `plugins` array of the Chat App's static `app.json` (currently `["@clerk/expo", { "appleSignIn": false }]`).

**Why:** `@clerk/expo` 4.x ships a native Expo module (`ClerkExpo` pod) whose podspec requires iOS 17.0 and declares a Swift
package (`clerk-ios`, products ClerkKit/ClerkKitUI). Expo autolinking evaluates every module podspec first — which registers
the Swift package with React Native's SPM helper — and only then compares deployment targets. On the Expo SDK 57 default
(16.4) it skips the pod with a `[Expo] @clerk/expo was not linked` warning, but the SPM registration stays behind, so
`react_native_post_install` looks up the missing `ClerkExpo` target and `pod install` dies with
`undefined method 'package_product_dependencies' for nil:NilClass` (RN `scripts/cocoapods/spm.rb`). The `--repo-update` retry
fails identically. The plugin fixes this by writing `ios.deploymentTarget: 17.0` into `Podfile.properties.json` before
pod install and bumping `IPHONEOS_DEPLOYMENT_TARGET` in the Xcode project.

**How to apply:**
- Diagnose from the retained Expo Launch log: the nil crash immediately after `[SPM] Adding SPM dependency on product
  ["ClerkKit", "ClerkKitUI"]` plus no `ClerkExpo` in the "Installing" list means the deployment target is below 17.0.
- Do not replace the plugin with `expo-build-properties`; it would duplicate Clerk's own mods. Do not add `app.config.*`.
- `appleSignIn: false` is deliberate: the app has no Sign in with Apple UI, and the default adds an entitlement that the
  provisioning profile may not carry. Re-evaluate together with App Review guideline 4.8 (Google/X login present).
- Expo Go and the web preview are unaffected: the JS side uses `requireOptionalNativeModule("ClerkExpo")`.
- Verify locally without EAS: `expo config --type introspect` shows `ClerkExpoVersion` in `ios.infoPlist`; a scratch
  `expo prebuild --platform ios --no-install` (needs a temporary `ios.bundleIdentifier`) must yield
  `ios.deploymentTarget: "17.0"`. Prebuild edits `package.json`/`.gitignore` and creates `ios/`; revert all three afterwards.
