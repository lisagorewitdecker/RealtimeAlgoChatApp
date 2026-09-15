---
name: expo-blur Android blur prerequisites
description: Why the classic tab bar uses a translucent palette panel on Android instead of expo-blur's Android blur, and what enabling that blur would take.
---

On Android, expo-blur (the SDK 54+ line) only blurs when the `BlurView` receives a `blurTarget` ref to a `BlurTargetView` that wraps the content behind it. Without one, the native side silently renders a plain tinted panel (the dark tint at intensity 100 is roughly rgba(25,25,25,0.69)) and only warns in development; `experimentalBlurMethod` additionally warns as deprecated in favor of `blurMethod`. Plans that say "just set experimentalBlurMethod" are therefore not enough.

**Why:** The Dimezis BlurView library re-renders the target on every frame the target redraws (list scrolling), on the CPU below API 31, which Expo documents as a performance risk; the `dimezisBlurViewSdk31Plus` variant falls back to the tint on older devices, so a tinted panel has to look right regardless. No Android device or emulator is reachable from this workspace to measure the cost, so the bounded-cost panel ships.

**How to apply:** The classic tab bar keeps a palette `tabBarBackground` rgba token (the palette background at 0.85 alpha; 0.9 in high contrast) with a hairline top border on Android and web, and the tab layout test bounds the alpha through a WCAG 4.5:1 check over white (the 0.69 fallback alpha fails at about 2.7:1). To enable real blur later: wrap each tab screen's content in `BlurTargetView`, pass the focused screen's ref as `blurTarget`, re-target when tab focus changes (the component only re-resolves the target when the ref identity changes), keep the panel as the pre-API-31 fallback, and measure scroll frame times on a low-end device first.

## Quick signed-in web screenshots of the Chat App

A throwaway Playwright spec placed next to the API server's E2E files (with its own config whose `testMatch` names it and keeps the Clerk `setup` project) can reuse the Clerk testing token, a `+clerk_test` user with password, the `424242` verification code, and the profile-setup step to reach the tabs in a mobile-sized viewport; delete the spec and config afterwards. The Chats list only shows rooms that are live in the server's memory, so a freshly started server shows "No active rooms" even with hundreds of historic rows; use the Profile tab for content that scrolls under the tab bar.
