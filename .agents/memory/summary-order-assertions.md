---
name: Summary order assertions
description: How to make report-order tests detect actual output reordering.
---

When testing deterministic report ordering, extract the ordered identifiers from the rendered headings and compare that sequence with the sorted expected identifiers. Do not compare offsets calculated by iterating an already-sorted input list; that can pass even when the output sections are reordered.

**Why:** A mixed Android preview report test initially compared positions generated from the same sorted record list, so it could not detect a deleted section appearing after a later present section.

**How to apply:** Use heading extraction for summary/report order assertions, and include deleted, valid, and invalid records so the ordering check covers every section.