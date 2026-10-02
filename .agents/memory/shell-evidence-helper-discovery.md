---
name: Shell evidence helper discovery
description: Static release-contract checks for evidence readers implemented in shell heredocs and dynamically imported local JavaScript helpers.
---

Evidence parsing embedded in a shell heredoc must be checked as part of the
shell entry point's local helper closure. Only shell scripts explicitly
inventoried as evidence readers should contribute embedded JSON parsing;
utility shell parsing must remain excluded.

**Why:** A shell-run JavaScript reader can move JSON.parse into a dynamically
imported helper without changing the shell entry point, bypassing a contract
that only follows static JavaScript imports.

**How to apply:** When adding a shell evidence reader, keep its local helper
paths resolvable from the command arguments and add a regression for both the
delegated duplicate-key diagnostic and the non-evidence exclusion boundary.