---
name: GitHub edited-event evidence
description: How to prove a hosted GitHub pull-request description edit triggered a workflow when REST event history omits the edit.
---

When a live GitHub probe changes only a pull-request description, the REST timeline and issue-events endpoints may not expose the body edit as an `edited` event. Treat the recorded PATCH completion time, the unchanged pull-request head SHA, and the later workflow run creation time as the evidence chain.

**Why:** The hosted API can run the workflow correctly while omitting description-edit events from the event-history endpoints, so an evidence record that depends only on timeline output cannot prove the trigger.

**How to apply:** Capture the description update response timestamp before polling runs. Match the edited run by pull-request number and unchanged head SHA, retain the run and job URLs, and state the timestamp relationship explicitly before closing and deleting the temporary probe.