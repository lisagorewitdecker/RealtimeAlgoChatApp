---
name: Malformed loader diagnostics
description: Keep corrupted Expo loader paths out of bounded preview startup diagnostics.
---

Preview loader parsing must fail closed when quotes, control characters, or trailing text make the library path ambiguous. Recognize only complete platform-specific loader phrases with a safe library basename on the same line as the selected loader failure; otherwise return the existing maintenance guidance without echoing the observed line.

**Why:** Process wrappers and terminal corruption can append unrelated or sensitive text to loader failures. Sanitizing the whole line is not enough because it can preserve misleading text or hide the actual library identifier; scanning later lines can also let a valid retry mask an earlier malformed failure.

**How to apply:** Keep malformed cases as synthetic fixtures, verify live and captured-log validation produce identical bounded diagnostics, and preserve those fixtures when refreshing versioned platform captures. Ignore ANSI wrappers and terminal bells only as decorations around an otherwise valid loader line.