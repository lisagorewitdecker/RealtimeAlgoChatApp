---
name: Expo canvas iframe refresh
description: How to clear a stale mobile artifact frame after an Expo render-crash fix.
---

After fixing an Expo render crash, restart the managed Expo workflow and remount the mobile artifact frame by cycling its canvas lifecycle state before judging whether the fix failed.

**Why:** An already-open canvas artifact iframe can retain an error-boundary or bundle state across source updates and continue showing the old crash even when a fresh app load is healthy.

**How to apply:** Confirm the merged source contains the fix, restart Expo, cycle the selected artifact iframe from `modifying` back to `live`, and verify Metro logs a fresh web bundle request.
