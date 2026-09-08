---
name: React Native Web confirmations
description: Cross-platform confirmation behavior for destructive actions in the Expo web preview.
---

For destructive actions that must run after confirmation, use the browser's confirmation result on web and native `Alert` buttons on iOS and Android.

**Why:** React Native Web can display an `Alert.alert` dialog without invoking the custom button callback after the browser accepts it. The UI appears to confirm while the action never runs.

**How to apply:** Branch on the web platform for confirmation-dependent actions, and verify the real web flow with browser automation that observes the resulting mutation rather than only the dialog.