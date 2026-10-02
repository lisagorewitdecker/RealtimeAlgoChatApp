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

## Updating `main` from the workspace

The ruleset has no bypass actors, so the same checks gate direct pushes: GitHub
rejects a push to `main` whose new commit has not already passed both checks.
To move `main`:

1. Push the commit to a branch and open a pull request into `main` (every pull
   request runs both check workflows, so no manual dispatch is needed).
2. Wait until `Root contract checks` and `Android preview evidence` report
   success on the branch head.
3. Fast-forward `main` to that exact commit (`git push origin <sha>:refs/heads/main`);
   GitHub then marks the pull request merged. Never squash or rebase-merge on
   GitHub, which would give `main` a commit the workspace does not have.

The [2026-09-19 handoff record](./root-contract-checks-required-check-20260919.md)
shows the gate passing on a clean tree and blocking a pull request that
reintroduced the known breakages.
