# Real-platform preview launcher hosted check

This record keeps only the reviewed revision, runner outcomes, and validator
comparison status. Raw macOS and Windows launcher output is not retained here;
the workflow's uploaded captures are redacted before persistence.

| Item | Result |
| --- | --- |
| Reviewed ref | `task-607-real-platform` |
| Reviewed revision | `f57ac12bdd25b8fa87265f08a0cccd5a33f8c359` |
| Expo CLI / React Native samples | `57.0.20` / `0.86.3` |
| Workflow run | `35433637963` |
| macOS launcher | PASS — capture, validator revalidation, and redacted upload completed |
| Windows launcher | BLOCKED — the Windows loader smoke check failed before launcher capture |
| Windows validator comparison | NOT RECORDED — no Windows capture was produced |
| Parser/sample change | None — the successful macOS diagnosis matched the existing `libgtk-3.dylib` wording |

The Windows failure is a runner smoke-check failure, not evidence of changed
Expo launcher wording. The existing deterministic compatibility suite remains
the source of truth for the parser until a Windows capture can be produced.