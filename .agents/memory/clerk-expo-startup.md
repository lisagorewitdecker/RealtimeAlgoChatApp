---
name: Clerk Expo startup
description: Environment and rendering constraints for the managed Clerk Expo client.
---

Expo only exposes environment variables prefixed with `EXPO_PUBLIC_` to the
mobile bundle. The managed Clerk publishable key may be provided to the process
under a different publishable-key environment name, so map it into
`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` for both development Metro and static
production builds without printing its value.

**Why:** A missing mapping makes the Clerk provider fail before any sign-in UI
can render. Separately, returning an empty root while optional web fonts are
loading turns a recoverable loading delay into a blank app shell.

**How to apply:** Keep the key mapping at the Expo process/build boundary.
Render the root with system-font fallback while fonts load, and reserve a
visible loading state for real authentication or profile-hydration work.