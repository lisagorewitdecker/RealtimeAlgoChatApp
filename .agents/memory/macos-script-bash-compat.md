---
name: macOS shell scripts must run on bash 3.2
description: Constraint for any script the owner runs on a Mac (runner provisioning, device checks), plus the recipe for testing under a real bash 3.2.57 built on Linux.
---

Scripts executed on macOS run under Apple's stock `/bin/bash` 3.2 when invoked as `bash script.sh`, so they must avoid bash 4+ features: associative arrays, `mapfile`/`readarray`, `${var,,}`/`${var^^}`, `printf '%(...)T'`, `[[ -v `, negative array indices, `|&`, and GNU-only flags such as `sed -i` without a suffix.

**Why:** The repeatable checks for these scripts run only on Linux (bash 5), so a bash 4 construct passes every workspace test and then fails on the owner's Mac, where nobody can debug it from here.

**How to apply:** Grep first (`declare -A|mapfile|readarray|,,|\^\^|%\(|\[\[ -v|\[-1\]`), then run the real thing: a genuine bash 3.2.57 builds on this Linux workspace in a few minutes and the iOS runner harness accepts `PROVISION_TEST_BASH=/path/to/bash` to run the script and every stub under it. `bash -n` under 3.2 catches parse-level constructs; the harness cases catch runtime ones. Shared summary helpers must also work with an intentionally minimal `PATH`, so prefer Bash builtins over adding an `awk`/GNU utility dependency.

Build recipe (do not commit the binary; `/tmp` is fine):

1. `F="-O1 -std=gnu89 -Wno-implicit-function-declaration -Wno-implicit-int -Wno-incompatible-pointer-types -Wno-int-conversion -Wno-error -Wno-format-security"`; `curl -fsSL -o bash-3.2.57.tar.gz https://ftp.gnu.org/gnu/bash/bash-3.2.57.tar.gz`, extract, then `CFLAGS="$F" ./configure --prefix=/tmp/bash32/install`. The flags must reach configure too: GCC 14 rejects implicit declarations, so a plain configure records `bash_cv_have_strsignal=no` and the build later dies in `siglist.o` (`siglist.h:37: expected identifier or '(' before 'char'`). Check `grep HAVE_STRSIGNAL config.h` shows `#define HAVE_STRSIGNAL 1` before making.
2. The shipped `y.tab.c` is stale relative to the patched `parse.y` (compile error `too few arguments to function 'expand_prompt_string'`), and there is no `yacc` on the PATH: delete `y.tab.c`/`y.tab.h` and build inside `nix-shell -p bison` with `YACC='bison -y'`.
3. The same flags go to both the target and the build-tools compiles: `make -j4 YACC='bison -y' CFLAGS="$F" CFLAGS_FOR_BUILD="$F" && make install`; without `CFLAGS_FOR_BUILD`, `support/bashversion.c` fails, and without `-Wno-format-security`, `print_cmd.c` fails. About two minutes end to end; `/tmp` is wiped when the task environment resets, so expect to rebuild.

**Hosted verification (added 2026-09-20):** the `iOS runner provisioning real macOS` workflow runs both iOS-runner suites and the script's `--dry-run --no-github` under Apple's `/bin/bash` on `macos-latest`, judged by `scripts/check-ios-runner-dry-run-report.sh`. Two portability rules that job depends on: isolated-PATH harness cases must answer `uname -s` with Linux through a stub (otherwise a real Mac runs the script's installers in the non-dry-run usage case), and digest checks must accept `shasum` because macOS has no `sha256sum`. Locally, run both suites with `PROVISION_TEST_BASH=/tmp/bash32/install/bin/bash` and also invoke them *through* that bash (`/tmp/bash32/install/bin/bash scripts/tests/<suite>.sh`), which is what the hosted job does.
