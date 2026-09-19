---
name: jest-expo platform projects
description: How the Chat App gets Android coverage from Jest, and two jest-expo behaviours that make the obvious approaches silently wrong.
---

# jest-expo platform projects

Rule: platform coverage comes from Jest `projects` with explicit per-project
`testMatch` lists, not from jest-expo's `*.test.android.tsx` file-suffix
convention, and platform-dependent expectations are keyed on `Platform.OS`
inside shared suites rather than skipped.

**Why:**
- The default `jest-expo` preset keeps Jest's default `testMatch`
  (`**/__tests__/**/*.[jt]s?(x)`), so an `X.test.android.tsx` file would
  also run under the iOS project. Only `jest-expo/ios` and `jest-expo/android`
  install platform-suffixed patterns.
- In tests, `Platform.OS` is not inlined by babel-preset-expo (that only
  happens in production); it comes from haste's `defaultPlatform`, so the
  Android preset works purely through module resolution. Nothing fails if that
  resolution stops matching the project label, which is why the Android
  project has a setup file that throws unless `Platform.OS === "android"`.
- `process.env.EXPO_OS` *is* inlined at transform time per project, so it is
  useless as a runtime guard.

**How to apply:** new layout-bearing suites are added to the Android list in
the Chat App's Jest config (the config throws if a listed file is missing);
expectations that differ by platform use the shared `onTestPlatform` helper so
neither project reports skipped tests. The Android pass adds roughly 10% to a
warm run and noticeably more on a cold babel cache.

Run one suite under one project as
`jest --runInBand --selectProjects iOS -- __tests__/X.test.tsx`. Without the
`--`, `--selectProjects` swallows the path as another project name and Jest
runs the whole project in parallel, where the heavier screen suites hit
spurious 5 s test timeouts.

There is deliberately no web project. A component's web branch is covered
inside the same suite by assigning `Platform.OS = "web"` for that test and
restoring the project's platform afterwards; capture the project's platform
with `testPlatform()` at module load (it throws for anything but ios/android),
before any test mutates `Platform.OS`. React Native's own `ScrollView` under
Jest is the preset's mock class, so `UNSAFE_getByType(ScrollView)` identifies
the plain-scroll branch; `react-test-renderer` is not installed in the app, so
type render results as `ReturnType<typeof render>` rather than importing
`ReactTestInstance`.
