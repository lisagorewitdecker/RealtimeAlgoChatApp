---
name: Preview device debugging
description: How to tell what a phone actually fetched from the Expo dev preview, and why in-workspace probes and the "published app" can mislead.
---

# Debugging phones that cannot load the Expo preview

**Rule:** Do not conclude "the preview works" from curl inside the workspace.
Requests to `*.replit.dev` from the container resolve to an internal sidecar
(a private IP), so they never traverse the public edge the phone uses.
Replit's "Run this app to see the results here" HTML in an Expo Go 404 means
the public edge could not reach the workspace app server at that moment.

**Isolated task environments:** `$REPLIT_DEV_DOMAIN` and
`$REPLIT_EXPO_DEV_DOMAIN` answer every path with a 7-byte `Running`
placeholder there, even while the local ports serve real responses. The
workspace preview pane is served by the main workspace's workflows, so
starting workflows inside a task environment cannot clear a "Your app is not
running" banner shown in the main workspace. Only local port probes are
meaningful from a task environment.

**How to see device traffic:** enable the opt-in redacted Metro request
evidence and restart the Expo workflow; Metro logs one redacted line per
Metro-level request and refreshes a handoff evidence file. The marker contains
only status, timing, normalized platform, client class, and coarse resource
class.
Manifest requests are handled by Expo middleware before that hook and are not
logged.
In the API access log, a native client is the one that sends no `OPTIONS`
preflights; browser tabs preflight every cross-origin call.

**"Published app" caveat:** the live domain serves an Expo Go manifest whose
bundle can be days behind HEAD. Check the production manifest `createdAt` and
`runtimeVersion` (curl the live root with an `expo-platform` header) before
diagnosing a "production" bug against current source.

**Why:** a real-iPhone "Opening room…" hang was a stale published bundle
(pre secure-store fix), and same-day preview 404/502 responses were
edge/restart windows;
both looked healthy from in-container probes.

**How to apply:** any time a user reports an Expo Go loading error or a
phone-only bug, capture the request log and compare manifest dates first.

The handoff record must keep four outcomes separate: public manifest
reachability, the local manifest/bundle probe, the physical Expo Go launch, and
server-side native request evidence. A successful public or local probe is not
phone evidence.

**Why:** operators can otherwise copy a successful workspace/public probe into
the Android record and accidentally imply that a physical phone launched the
preview.

**How to apply:** use the redacted preflight summary for the first two rows and
keep the phone and native-request rows `BLOCKED` or `NOT_ASSESSED` until both
physical evidence sources exist.

The local Expo Go handoff check must request the platform manifest first and
follow its `launchAsset.url` pathname for the bundle; a guessed `/index.bundle`
route is not equivalent. This validates Metro's native-client routing locally,
but does not replace a real-device check through the public edge.

**Why:** retaining raw hosts, URLs, or user-agent strings makes it too easy to
copy credentials or account context into native evidence, while workflow
console output is difficult to preserve as a timestamped handoff artifact.

**How to apply:** filter the retained log for
`platform=android client=Expo Go` (or the corresponding iOS platform), exclude
`OPTIONS`, and copy only the redacted marker into the handoff record.

Preview handoff deadlines must cover both response headers and manifest/bundle
body reads; normalize deadline aborts into an explicit configured-deadline
failure and include recovery guidance.

**Why:** Metro can return headers and then stall while delivering a response
body, which otherwise makes a local probe appear hung without identifying the
request or the next recovery step.

**How to apply:** use the bounded request helper for every local manifest and
bundle read, and test stalled manifest and bundle paths independently.
