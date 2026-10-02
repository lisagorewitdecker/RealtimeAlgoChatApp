---
name: Expo Go embedded native module versions
description: Why the SDK-default worklets/reanimated versions crashed Expo Go iOS 57.0.5 at startup, and how the Chat App pins these packages to the Expo Go build it is loaded with.
---

Packages whose native half is compiled into Expo Go (`react-native-worklets`, `react-native-reanimated`) must match the
JavaScript version at the **patch** level for the specific Expo Go build that loads the app — not the SDK's
`bundledNativeModules.json`, which only describes the latest Expo Go build. Expo Go iOS 57.0.5 (Replit's iPhone
simulator, 2026-09-17) embeds worklets 0.10.0 / reanimated 4.5.0; Expo Go 57.0.6+ (App Store 57.0.9 on 2026-09-19)
embeds 0.10.1 / 4.5.1, which is also what `expo install --check` demands.

**Why:** worklets' startup guard compares only major.minor, and 0.10.1 changed the arity of a JSI binding
(`createSerializableNonWorkletFunction`) that runs during bundle evaluation. With 0.10.1 JS on 0.10.0 native (or vice
versa) the native side dereferences a missing argument: a process crash before `AppRegistry.runApplication`, so there is
no red box, no `iOS LOG`, no asset/API request — only bundle 200 followed by inspector close 1006 a few seconds later.
The Hermes compile of the bundle, the web preview, and every `expo install --check`/typecheck/Jest run stay green, so the
mismatch is invisible from inside the repo unless the served bundle's `jsVersion` is compared with the Expo Go build.

**How to apply:** the Chat App records the targeted Expo Go build and each build's embedded versions in
`artifacts/chat-app/expo-go-native-modules.json`; `validate:preview-runtime` fails unless `package.json` pins exactly those
versions and `expo.install.exclude` lists exactly the packages that deviate from the SDK default. When the simulator's Expo
Go build changes (or a physical phone on the store build is the target), retarget the record and move the pins instead of
running `expo install --fix`. Diagnose a repeat of the signature by comparing the Expo Go version (its Settings tab; the
bundle request User-Agent is `Expo/<version>` but the request log redacts it) with the record before touching the app.
To confirm a suspected embedded version, read `apps/expo-go/ios/Podfile.lock` at the Expo Go release commit in expo/expo
(the `sdk-NN` branch's `Info.plist` bump commits are the anchors); the App Store builds after the branch head come from
`@go/sdk-NN` branches, so infer later builds from the latest bump, never from the SDK's bundled-module list alone.
