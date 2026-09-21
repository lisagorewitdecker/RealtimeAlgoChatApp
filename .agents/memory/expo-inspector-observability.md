---
name: Expo inspector observability
description: Where Expo Go device connect/close events and Metro request evidence can and cannot be observed from the Chat App dev server, and the rules a launch-evidence classifier must follow.
---

## Inspector events are only visible on the dev server's stderr via DEBUG

Expo CLI force-overrides Metro's `reporter`, leaves dev-middleware's event reporter disabled, and WebSocket upgrades never
pass through `enhanceMiddleware`, so `metro.config.js` cannot observe Expo Go's inspector connection or its close code. The
only source is `DEBUG=Metro:InspectorProxy` on the dev server's stderr (ISO-timestamped when stderr is not a TTY, colored
with a `+4s` suffix when it is). iOS Expo Go identifies as `host.exp.Exponent`, Android as the lowercase `host.exp.exponent`;
"DevTools" connection lines are not device sessions.

**Why:** an Expo Go startup crash (bundle 200, abnormal close ~4 s later, no `iOS  LOG`) is invisible to every HTTP-level
check; only the debug namespace in the dev server's own output shows it.
**How to apply:** launch evidence must come from a process that owns the dev server's output for that run, enabled for one
run only. Do not set `DEBUG`/`EXPO_DEV_REQUEST_LOG` globally (e.g. `.replit` userenv): they persist and flood the log.

## The request log sees only Metro-served requests

The redacted `[dev-request]` log hooks Metro's `enhanceMiddleware`; Expo's manifest middleware answers `/` before Metro, so
manifest fetches never appear. Only a `platform=ios client=Expo Go resource=bundle` 200 is an iOS launch marker; a
`client=curl`/`browser` bundle 200 is a workspace probe, and an empty request log after a manifest-only check is normal.

## Classifier rule: evidence must follow the session's own bundle

A still-running earlier bundle keeps logging and fetching assets while Metro serves the new bundle, so client logs or asset
requests seen before a session's bundle 200 prove nothing about that bundle. Count them separately and never let them turn a
bundle-then-abnormal-close trace into a pass. (A completion review rejected the first version of the probe for exactly this.)

## Replit simulator reloads can create a transient pre-bundle session

The Replit iPhone simulator can open an Expo Go inspector connection, close it
with code 1006 before requesting a bundle, then connect again a few seconds
later and fetch the real iOS bundle. The first connection is reload setup, not
the app session to classify.

**Why:** repeated armed main-workspace runs finalized as INCONCLUSIVE on the
first close even though the replacement session fetched an iOS bundle moments
later.

**How to apply:** a live classifier must keep listening through a pre-bundle
close until the device budget expires or a replacement session arrives. A
bundle followed by an abnormal close still decides the startup-crash verdict
immediately.

## Verification limits in task environments

Task environments have no simulator attached (public domains return a placeholder), so a probe can only be proven with
fixture logs plus a real armed run that ends in NO_DEVICE; the simulator-attached result needs the main workspace.
---
name: Expo inspector observability
description: Where Expo Go device connect/close events and Metro request evidence can and cannot be observed from the Chat App dev server, and the rules a launch-evidence classifier must follow.
---

## Inspector events are only visible on the dev server's stderr via DEBUG

Expo CLI force-overrides Metro's `reporter`, leaves dev-middleware's event reporter disabled, and WebSocket upgrades never
pass through `enhanceMiddleware`, so `metro.config.js` cannot observe Expo Go's inspector connection or its close code. The
only source is `DEBUG=Metro:InspectorProxy` on the dev server's stderr (ISO-timestamped when stderr is not a TTY, colored
with a `+4s` suffix when it is). iOS Expo Go identifies as `host.exp.Exponent`, Android as the lowercase `host.exp.exponent`;
"DevTools" connection lines are not device sessions.

**Why:** an Expo Go startup crash (bundle 200, abnormal close ~4 s later, no `iOS  LOG`) is invisible to every HTTP-level
check; only the debug namespace in the dev server's own output shows it.
**How to apply:** launch evidence must come from a process that owns the dev server's output for that run, enabled for one
run only. Do not set `DEBUG`/`EXPO_DEV_REQUEST_LOG` globally (e.g. `.replit` userenv): they persist and flood the log.

## The request log sees only Metro-served requests

The redacted `[dev-request]` log hooks Metro's `enhanceMiddleware`; Expo's manifest middleware answers `/` before Metro, so
manifest fetches never appear. Only a `platform=ios client=Expo Go resource=bundle` 200 is an iOS launch marker; a
`client=curl`/`browser` bundle 200 is a workspace probe, and an empty request log after a manifest-only check is normal.

## Classifier rule: evidence must follow the session's own bundle

A still-running earlier bundle keeps logging and fetching assets while Metro serves the new bundle, so client logs or asset
requests seen before a session's bundle 200 prove nothing about that bundle. Count them separately and never let them turn a
bundle-then-abnormal-close trace into a pass. (A completion review rejected the first version of the probe for exactly this.)

## Replit simulator reloads can create a transient pre-bundle session

The Replit iPhone simulator can open an Expo Go inspector connection, close it
with code 1006 before requesting a bundle, then connect again a few seconds
later and fetch the real iOS bundle. The first connection is reload setup, not
the app session to classify.

**Why:** repeated armed main-workspace runs finalized as INCONCLUSIVE on the
first close even though the replacement session fetched an iOS bundle moments
later.

**How to apply:** a live classifier must keep listening through a pre-bundle
close until the device budget expires or a replacement session arrives. A
bundle followed by an abnormal close still decides the startup-crash verdict
immediately.

## Verification limits in task environments

Task environments have no simulator attached (public domains return a placeholder), so a probe can only be proven with
fixture logs plus a real armed run that ends in NO_DEVICE; the simulator-attached result needs the main workspace.
---
name: Expo inspector observability
description: Where Expo Go device connect/close events and Metro request evidence can and cannot be observed from the Chat App dev server, and the rules a launch-evidence classifier must follow.
---

## Inspector events are only visible on the dev server's stderr via DEBUG

Expo CLI force-overrides Metro's `reporter`, leaves dev-middleware's event reporter disabled, and WebSocket upgrades never
pass through `enhanceMiddleware`, so `metro.config.js` cannot observe Expo Go's inspector connection or its close code. The
only source is `DEBUG=Metro:InspectorProxy` on the dev server's stderr (ISO-timestamped when stderr is not a TTY, colored
with a `+4s` suffix when it is). iOS Expo Go identifies as `host.exp.Exponent`, Android as the lowercase `host.exp.exponent`;
"DevTools" connection lines are not device sessions.

**Why:** an Expo Go startup crash (bundle 200, abnormal close ~4 s later, no `iOS  LOG`) is invisible to every HTTP-level
check; only the debug namespace in the dev server's own output shows it.
**How to apply:** launch evidence must come from a process that owns the dev server's output for that run, enabled for one
run only. Do not set `DEBUG`/`EXPO_DEV_REQUEST_LOG` globally (e.g. `.replit` userenv): they persist and flood the log.

## The request log sees only Metro-served requests

The redacted `[dev-request]` log hooks Metro's `enhanceMiddleware`; Expo's manifest middleware answers `/` before Metro, so
manifest fetches never appear. Only a `platform=ios client=Expo Go resource=bundle` 200 is an iOS launch marker; a
`client=curl`/`browser` bundle 200 is a workspace probe, and an empty request log after a manifest-only check is normal.

## Classifier rule: evidence must follow the session's own bundle

A still-running earlier bundle keeps logging and fetching assets while Metro serves the new bundle, so client logs or asset
requests seen before a session's bundle 200 prove nothing about that bundle. Count them separately and never let them turn a
bundle-then-abnormal-close trace into a pass. (A completion review rejected the first version of the probe for exactly this.)

## Replit simulator reloads can create a transient pre-bundle session

The Replit iPhone simulator can open an Expo Go inspector connection, close it
with code 1006 before requesting a bundle, then connect again a few seconds
later and fetch the real iOS bundle. The first connection is reload setup, not
the app session to classify.

**Why:** repeated armed main-workspace runs finalized as INCONCLUSIVE on the
first close even though the replacement session fetched an iOS bundle moments
later.

**How to apply:** a live classifier must keep listening through a pre-bundle
close until the device budget expires or a replacement session arrives. A
bundle followed by an abnormal close still decides the startup-crash verdict
immediately.

## Verification limits in task environments

Task environments have no simulator attached (public domains return a placeholder), so a probe can only be proven with
fixture logs plus a real armed run that ends in NO_DEVICE; the simulator-attached result needs the main workspace.
---
name: Expo inspector observability
description: Where Expo Go device connect/close events and Metro request evidence can and cannot be observed from the Chat App dev server, and the rules a launch-evidence classifier must follow.
---

## Inspector events are only visible on the dev server's stderr via DEBUG

Expo CLI force-overrides Metro's `reporter`, leaves dev-middleware's event reporter disabled, and WebSocket upgrades never
pass through `enhanceMiddleware`, so `metro.config.js` cannot observe Expo Go's inspector connection or its close code. The
only source is `DEBUG=Metro:InspectorProxy` on the dev server's stderr (ISO-timestamped when stderr is not a TTY, colored
with a `+4s` suffix when it is). iOS Expo Go identifies as `host.exp.Exponent`, Android as the lowercase `host.exp.exponent`;
"DevTools" connection lines are not device sessions.

**Why:** an Expo Go startup crash (bundle 200, abnormal close ~4 s later, no `iOS  LOG`) is invisible to every HTTP-level
check; only the debug namespace in the dev server's own output shows it.
**How to apply:** launch evidence must come from a process that owns the dev server's output for that run, enabled for one
run only. Do not set `DEBUG`/`EXPO_DEV_REQUEST_LOG` globally (e.g. `.replit` userenv): they persist and flood the log.

## The request log sees only Metro-served requests

The redacted `[dev-request]` log hooks Metro's `enhanceMiddleware`; Expo's manifest middleware answers `/` before Metro, so
manifest fetches never appear. Only a `platform=ios client=Expo Go resource=bundle` 200 is an iOS launch marker; a
`client=curl`/`browser` bundle 200 is a workspace probe, and an empty request log after a manifest-only check is normal.

## Classifier rule: evidence must follow the session's own bundle

A still-running earlier bundle keeps logging and fetching assets while Metro serves the new bundle, so client logs or asset
requests seen before a session's bundle 200 prove nothing about that bundle. Count them separately and never let them turn a
bundle-then-abnormal-close trace into a pass. (A completion review rejected the first version of the probe for exactly this.)

## Replit simulator reloads can create a transient pre-bundle session

The Replit iPhone simulator can open an Expo Go inspector connection, close it
with code 1006 before requesting a bundle, then connect again a few seconds
later and fetch the real iOS bundle. The first connection is reload setup, not
the app session to classify.

**Why:** repeated armed main-workspace runs finalized as INCONCLUSIVE on the
first close even though the replacement session fetched an iOS bundle moments
later.

**How to apply:** a live classifier must keep listening through a pre-bundle
close until the device budget expires or a replacement session arrives. A
bundle followed by an abnormal close still decides the startup-crash verdict
immediately.

## Verification limits in task environments

Task environments have no simulator attached (public domains return a placeholder), so a probe can only be proven with
fixture logs plus a real armed run that ends in NO_DEVICE; the simulator-attached result needs the main workspace.
