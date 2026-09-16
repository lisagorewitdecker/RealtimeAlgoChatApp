# Required pull-request checks

The repository ruleset requires the `Android preview evidence` check before a
pull request can merge. That check name comes from the `name` field of the
`android-preview-evidence` job in
[`.github/workflows/mobile-release.yml`](./workflows/mobile-release.yml).

If that job is renamed, a repository administrator must update the required
status-check context at the same time:

1. Open the repository's [Rulesets settings](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/settings/rules).
2. Edit the active branch ruleset.
3. Under required status checks, replace `Android preview evidence` with the
   workflow job's new display name.
4. Confirm the pull-request workflow reports that exact check name before
   merging the change.

Do not treat changing the workflow job name alone as sufficient; GitHub will
then enforce the old context and the handoff record will not be protected by
the intended check.