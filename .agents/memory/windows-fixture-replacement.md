---
name: Windows fixture replacement
description: Generated preview fixtures need rollback protection because Windows cannot rename over an existing file.
---

Windows refreshes must move an existing generated fixture to a same-directory backup before replacement, restore it when the replacement fails, and retain the backup if restoration itself fails.

**Why:** Windows does not provide the same overwrite behavior as POSIX rename; deleting the destination first can turn a transient replacement error into permanent loss of the last known-good evidence.

**How to apply:** Keep capture validation before any destination move, exercise both failed and successful simulated-Windows replacements, and compare the non-generated handoff code after refresh.