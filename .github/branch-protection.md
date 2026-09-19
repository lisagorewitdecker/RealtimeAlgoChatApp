# Required pull-request checks

The repository ruleset that targets `main` requires two status checks before a
pull request can merge:

- `Root contract checks` — the `name` of the `root-contract-checks` job in
  [`.github/workflows/root-contract-checks.yml`](./workflows/root-contract-checks.yml).
  It runs `pnpm install --frozen-lockfile`, `pnpm run typecheck`,
  `pnpm test:unit --run`, and `pnpm run validate:api-codegen` on every pull
  request into `main`, so a change that does not even parse (a duplicate key in
  a workflow file, a script with a syntax error, a hand-edited generated API
  client) is blocked with the failing command's own diagnostic instead of
  landing unchecked.
- `Android preview evidence` — the `name` of the `android-preview-evidence`
  job in [`.github/workflows/mobile-release.yml`](./workflows/mobile-release.yml).

Each check name comes from the job's `name` field. If either job is renamed, a
repository administrator must update the required status-check context at the
same time:

1. Open the repository's [Rulesets settings](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/settings/rules).
2. Edit the active branch ruleset and confirm it still targets `main`; a
   ruleset whose target branch list is empty enforces nothing.
3. Under required status checks, replace the old context with the workflow
   job's new display name.
4. Confirm the pull-request workflow reports that exact check name before
   merging the change.

Do not treat changing the workflow job name alone as sufficient; GitHub will
then enforce the old context and the branch will not be protected by the
intended check.
