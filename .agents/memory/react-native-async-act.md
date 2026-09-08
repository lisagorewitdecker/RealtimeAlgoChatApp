---
name: React Native async act
description: Async provider effects in the current React Native test stack need a separate act flush after render.
---

When a React Native provider starts asynchronous work in an effect, render it normally and follow with `await act(async () => {})` before asserting. Nesting `render` inside async `act` can make RNTL host detection see an unmounted renderer.

**Why:** The installed React Native Testing Library wraps render itself, while provider promises can resolve after that synchronous wrapper finishes.

**How to apply:** Use this pattern for tests that mount asynchronous context providers and otherwise finish before their initial state update.
