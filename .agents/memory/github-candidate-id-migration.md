---
name: GitHub candidate ID migration
description: GitHub Actions secret values cannot be read back through the repository API, so candidate IDs need a non-secret source before migration.
---

The exact native candidate build IDs must come from the builds installed on the reviewed devices; GitHub's Actions API can confirm variable and secret names but never returns secret values.

**Why:** Guessing the latest EAS builds can detach release evidence from the binaries that were actually reviewed.

**How to apply:** Obtain the two non-secret IDs from the device/release record, set the repository variables, confirm they are non-empty, and only then remove obsolete candidate secrets.