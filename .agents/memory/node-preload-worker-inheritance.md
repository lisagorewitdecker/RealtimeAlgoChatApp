---
name: Node preload worker inheritance
description: Node preload modules also execute inside worker threads that inherit the parent process arguments.
---

Node `--import` preloads are inherited through worker `execArgv`. Any preload that performs process-wide initialization or emits startup logs must guard that work to the main thread unless every worker genuinely needs its own instance.

**Why:** a monitoring preload was correct for the server process but also initialized once per logging transport worker, producing repeated startup messages and unnecessary SDK instances.

**How to apply:** when adding a Node preload to a process that may use worker-backed libraries, verify startup logs after the workers launch and use a main-thread check around one-per-process initialization.
