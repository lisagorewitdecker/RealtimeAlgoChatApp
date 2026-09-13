---
name: Clerk token effect stability
description: Prevent repeated API requests when Expo Clerk token callbacks change identity across renders.
---

Stateful loading effects in the Expo app must not depend directly on Clerk's token callback identity. Keep the latest callback in a ref and drive the effect from durable authentication state instead.

**Why:** A profile-loading effect that updated local state and depended on the token callback repeatedly restarted after every render, creating thousands of requests and exhausting Clerk's development API rate limit.

**How to apply:** When an Expo effect both requests a Clerk token and updates component or context state, use a ref for the current token callback. Keep user ID, signed-in state, and loaded state as the effect dependencies.