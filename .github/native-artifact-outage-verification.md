# Native artifact outage summary verification

This record documents the controlled GitHub-hosted check for the mobile release
gate. It is not native-device release evidence and must not be used to approve
a store submission.

## Observed run

- Date: 2026-09-18
- Scenario: the iOS evidence artifact was intentionally unavailable; a
  synthetic Android artifact was uploaded and downloaded afterward.
- Workflow run:
  [35387137791](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35387137791)
- Regression job:
  [Native evidence summary regression](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/actions/runs/35387137791/job/105736612253)
- Workflow source:
  [mobile-release.yml](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/blob/main/.github/workflows/mobile-release.yml)
- Checker source:
  [check-native-large-text-evidence.sh](https://github.com/lisagorewitdecker/RealtimeAlgoChatApp/blob/main/scripts/check-native-large-text-evidence.sh)

The hosted job confirmed all of the following:

- The iOS download step continued with
  `steps.download-controlled-ios.outcome=failure`.
- The Android download completed afterward with
  `steps.download-controlled-android.outcome=success`.
- The native evidence checker returned failure, so promotion remained blocked.
- The final assertion step passed after finding separate iOS and Android
  sections in the checker summary.
- The iOS section reported a failed artifact download and fixed iOS recovery
  guidance.
- The Android section reported a successful artifact download but failed
  evidence completeness, without including the iOS download path.

## Operator recovery

When this failure occurs during a real release:

1. Rerun the failed native job or make its artifact available.
2. Rerun the mobile release gate.
3. Do not submit either store candidate until both native evidence sections
   pass and the release gate permits promotion.

The workflow uses the fixed recovery wording:

> Rerun the failed native job or make its artifact available, then rerun the
> mobile release gate.
