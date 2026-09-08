---
name: Sandbox release validation
description: How to keep the generated sandbox and mobile host covered by stable release checks.
---

The collaborative sandbox spans two delivery boundaries: server-generated HTML
and the authenticated client host that renders it. Native clients use WebView;
browser previews fetch the HTML with a bearer token and host it in an iframe.
Keep a lightweight API suite for the generated document’s capability-scoped
connection, safe output, and collaborative editor contract, plus client
coverage for the platform-specific authentication handoff.

**Why:** The current mobile client does not render a native assistant panel;
testing a retired component creates false confidence and breaks when the
delivery architecture changes.

**How to apply:** Run the API and mobile package test scripts as separate,
named validation steps. When the sandbox UI or authentication handoff changes,
update the test at the boundary that owns the behavior rather than adding
tests for unused client components. Never render react-native-webview on web.
Load the browser document's Socket.IO client from a normal API asset route
rather than Socket.IO's built-in client endpoint: the artifact proxy can serve
the Engine.IO connection endpoint while returning a 502 for its client bundle
path.