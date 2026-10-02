# Hosted root contract checks required-check handoff

**Result: PASS — the `Root contract checks` workflow passed on a clean tree, the
repository ruleset for `main` now requires it, and a disposable pull request
that reintroduced the known breakages was blocked with readable failures.**

The probe was never merged. It used a temporary branch against the live
repository default branch and was deleted after the hosted run completed.

## Metadata

| Field | Result |
| --- | --- |
| Check time (UTC) | 2026-09-19 01:03 to 01:30 |
| Repository | `lisagorewitdecker/RealtimeAlgoChatApp` |
| Base branch before the gate | `main` at `7732e84` |
| Base branch after the gate | `main` at `f7bd471cf9185fd7074d7e0294cb10503fff697d` (fast-forward) |
| Workflow | `.github/workflows/root-contract-checks.yml` (`pull_request` into `main`, `workflow_dispatch`) |
| Required ruleset | [Ruleset1](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/rules/21924513), active, no bypass actors, targets `refs/heads/main` |
| Required status contexts | `Root contract checks`, `Android preview evidence` |
| Gate pull request | [#267](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/267), merged by fast-forward |
| Probe pull request | [#268](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/pull/268), closed unmerged |
| Probe branch | `task-610-breakage-probe`, deleted after verification |

## Clean-tree result

| Revision | Hosted run | Result |
| --- | --- | --- |
| `fb949295251d6a8455c73fd62651690ba8f8afa8` — workflow added | [Run #35411450575](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35411450575) | Attempt 1 failed in `Validate generated API clients`: the checker's cancellation tests raced signal delivery under the runner's Node 24.20.0 (`1 !== 143`); attempt 2 passed unchanged, confirming the race. |
| `f7bd471cf9185fd7074d7e0294cb10503fff697d` — injected test signals wait for delivery | [Run #35411884614](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35411884614) | Success: install, typecheck, root unit suite, and generated-client validation all passed; the commit carries both required contexts. |

The same commit passed `pnpm install --frozen-lockfile`, `pnpm run typecheck`,
`pnpm test:unit --run`, and `pnpm run validate:api-codegen` in a fresh
workspace worktree with no seeded test output, and the cancellation tests
passed 16 consecutive local runs under Node 24.20.0 after the fix.

## Blocking result

Probe revision `4ef5ef8b33504f7429f894a79dd7892532159874` appended a second
top-level `name` key to `.github/workflows/mobile-release.yml`, a hand-written
comment to `lib/api-client-react/src/generated/api.ts`, and an unterminated
`if` to `scripts/check-native-large-text-evidence.sh`.

| Hosted run | Failing steps | PR merge state |
| --- | --- | --- |
| [Run #35412719879](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35412719879) | `Run the root unit and contract tests`, `Validate generated API clients` | `mergeable_state: blocked` |

The job log named each problem:

- `.github/workflows/mobile-release.yml:2384:1: key "name" is duplicated in "workflow" section. previously defined at line:1,col:1 [syntax-check]` (from `pnpm run validate:mobile-release-workflow`, the first command of `pnpm test:unit`; the chain stops at the first failure, so the bash syntax error is reported once the workflow file is fixed).
- `Generated API drift detected after regeneration:` followed by a unified diff of `lib/api-client-react/src/generated/api.ts` removing the hand edit and `Run \`pnpm --filter @workspace/api-spec run codegen\` and commit the generated output.`

## Cleanup

- PR #268 was closed without merging.
- Branches `task-610-breakage-probe` and `task-610-root-contract-checks` were deleted; a follow-up branch lookup returned `404 Not Found`.
