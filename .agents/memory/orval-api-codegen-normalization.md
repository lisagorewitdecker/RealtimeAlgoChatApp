---
name: Orval API codegen normalization
description: The Orval split Zod generator can add a redundant wildcard export to the package entrypoint.
---

Treat Orval's generated wildcard export in the Zod package entrypoint as disposable. Normalize it after every generation while preserving the intentional named export list.

**Why:** Orval can update the package entrypoint during a refresh, and the wildcard re-exports values already exposed by the explicit list. Without normalization, a successful refresh creates unrelated working-tree changes and can expose more generated API than intended.

**How to apply:** Keep the post-generation normalizer idempotent and test both duplicate removal and stability across a second pass. Do not replace the explicit package exports with a wildcard.
