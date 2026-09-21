---
name: Native report retention
description: How mobile release summaries keep native artifact links reviewable and detect expired evidence.
---

Historical release summaries need a bounded, privacy-safe evidence snapshot that is independent of expiring artifact storage. Artifact links are convenience links; the durable summary must still contain enough review information after those links stop working.

**Why:** Historical summaries can outlive finite artifact links, and a dead link must not erase the evidence needed for release review or incident investigation.

**How to apply:** Keep artifact links as optional detail, embed only the approved bounded result in reviewer-visible output, and test reviewability after the underlying artifact is removed.

The approved durable boundary is a per-run GitHub Release containing only redacted platform report Markdown; summary links are emitted only after the matching asset upload succeeds.

**Why:** Release artifacts have a bounded lifetime, while a reviewer-usable report location needs a durable repository-owned target without copying candidate or runner-private evidence.

**How to apply:** Treat archive preparation, release creation, and each platform upload as separate failure points. A missing or unsafe asset URL must mark that platform blocked and publish no dead link.
