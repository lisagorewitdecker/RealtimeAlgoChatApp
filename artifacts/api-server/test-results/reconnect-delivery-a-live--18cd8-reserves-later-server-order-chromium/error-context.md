# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: reconnect-delivery.spec.ts >> a live reconnect replays each message once and preserves later server order
- Location: e2e/reconnect-delivery.spec.ts:84:1

# Error details

```
Test timeout of 240000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e8]:
  - progressbar [ref=e14]:
    - progressbar [ref=e15]
    - generic [ref=e20]: Opening room…
    - generic [ref=e21]: Still registering your device key. Check your connection; encrypted rooms stay closed until it completes.
  - generic [ref=e22]: © 2026 Lisa M Gorewit-Decker
```