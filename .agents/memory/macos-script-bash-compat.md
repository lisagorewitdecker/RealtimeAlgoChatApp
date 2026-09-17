---
name: macOS shell scripts must run on bash 3.2
description: Constraint for any script the owner runs on a Mac (runner provisioning, device checks); the Linux test harness cannot catch bash 4+ constructs.
---

Scripts executed on macOS run under Apple's stock `/bin/bash` 3.2 when invoked as `bash script.sh`, so they must avoid bash 4+ features: associative arrays, `mapfile`/`readarray`, `${var,,}`/`${var^^}`, `printf '%(...)T'`, `[[ -v `, negative array indices, `|&`, and GNU-only flags such as `sed -i` without a suffix.

**Why:** The repeatable checks for these scripts run only on Linux (bash 5), so a bash 4 construct passes every workspace test and then fails on the owner's Mac, where nobody can debug it from here.

**How to apply:** Before finishing a macOS-facing script, grep it for the constructs above (a regex over `declare -A|mapfile|readarray|,,|\^\^|%\(|\[\[ -v|\[-1\]`) and prefer `$(<file)`, parallel indexed arrays, `case` matching, and `[[ =~ ]]` with `[[:space:]]` classes. Also verify the checksum/label/version constants against the docs and workflow through the Linux dry-run test rather than by hand.
