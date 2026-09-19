# SDK 57 Android preview runtime dependency check

**Result: PASS — preview runtime dependencies are aligned**

This record documents the native runtime review that must accompany an Expo or
React Native upgrade. The stock Expo Go Android handoff is a separate physical
device check; a clean Metro process does not claim that a phone opened the
preview.

## Current metadata

| Field | Result |
| --- | --- |
| App | Chat App |
| Expo SDK | 57 (`expo` `~57.0.24`) |
| Expo CLI | `57.0.20` |
| React Native | `0.86.3` |
| Native diagnostic binary | Optional React Native DevTools launcher bundled by Expo CLI |
| Runtime configuration | `.replit` Nix packages on `stable-25_05` |

## Upgrade review procedure

Run this review whenever `expo`, `@expo/cli`, or `react-native` changes:

1. Run `pnpm exec expo install --check` and `pnpm dlx expo-doctor@latest` from
   `artifacts/chat-app`. Resolve dependency alignment before investigating
   preview startup.
2. Run `pnpm run validate:preview-runtime`. It repeats Expo's package
   compatibility check, verifies that the installed Expo CLI and React Native
   versions match the versioned loader evidence, and checks that `.replit`
   contains the native runtime set required by the optional DevTools launcher.
3. If the debugger binary or its loader output changes, inspect the binary's
   dependencies on the platform where it runs (`ldd` on Linux, `otool -L` on
   macOS, or the Windows dependency viewer available on the runner). Add the
   corresponding package to `.replit`'s `[nix].packages` list, then refresh the
   versioned loader evidence with
   `pnpm run refresh:preview-loader-evidence`.
4. Run `pnpm run validate:preview-startup` and restart the managed
   `artifacts/chat-app: expo` workflow. Confirm Metro reaches its normal
   `Using Expo Go`/`Starting Metro Bundler` state without a shared-library or
   DevTools loader error. An optional debugger warning is not a clean result.
5. Record the Expo SDK, Expo CLI, React Native versions, changed Nix entries,
   and the fresh workflow result in a new dated check. Keep physical Expo Go
   launch evidence separate from this workspace runtime check.

The required SDK 57 Linux runtime set is intentionally broader than the one
library named by a previous loader failure:

```text
glib nss nspr atk at-spi2-atk dbus
xorg.libX11 xorg.libXcomposite xorg.libXdamage xorg.libXext
xorg.libXfixes xorg.libXrandr mesa xorg.libxcb libxkbcommon alsa-lib
at-spi2-core libgbm cups expat libdrm pango cairo fontconfig freetype
systemd gtk3
```

## Verification at this revision

`CI=1 pnpm exec expo install --check` reports `Dependencies are up to date`
with the SDK 57 package matrix:

```text
expo ~57.0.24
expo-constants ~57.0.19
expo-image-picker ~57.0.19
expo-location ~57.0.19
expo-router ~57.0.22
```

`pnpm run validate:preview-runtime` passes with those versions and all
required Nix entries present. The Nix list was checked rather than changed:
`gtk3` and its GLib/GTK/X11 support libraries are already configured for the
SDK 57 DevTools launcher.

The configured preview-startup validation remains the release check for a
fresh Metro handoff. If it reports a loader failure, preserve the named
library in the diagnostic, update the Nix list, and repeat the full review
instead of treating Metro's continued availability as success.
