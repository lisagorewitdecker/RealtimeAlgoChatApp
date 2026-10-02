# SDK 57 preview runtime check — 2026-09-21

**Result: PASS — clean frozen install and managed Metro startup are aligned**

This record covers the workspace runtime boundary only. It does not claim that
Expo Go completed a physical-device launch.

## Verification

| Field | Result |
| --- | --- |
| Workspace revision | `d9f7a973e95d96de16fc3c82a396036c0405cd29` |
| Node.js | `v24.13.0` |
| pnpm | `10.26.1` |
| Install | `pnpm install --frozen-lockfile` — PASS; lockfile unchanged |
| Runtime validator | `pnpm --filter @workspace/chat-app run validate:preview-runtime` — PASS |
| Expo SDK | `57` (`expo` `~57.0.24`) |
| Expo CLI | `57.0.20` |
| React Native | `0.86.3` |
| Expo Go native pins | `react-native-worklets` `0.10.0`; `react-native-reanimated` `4.5.0` for Expo Go iOS `57.0.5` |
| Required Nix packages | 27 of 27 present |
| Nix package changes | None; `.replit` was unchanged |
| Managed workflow | Restarted `artifacts/chat-app: expo` after the install |

The validator also confirmed the Expo Go native-module exceptions remain
explicitly excluded from Expo's SDK-default package check.

## Fresh workflow result

The restarted managed workflow reached:

- `Starting Metro Bundler`
- `Using Expo Go`

The workflow log contained no shared-library loader error, GTK/DevTools loader
error, or other startup error. The normal QR/Metro/Web endpoints were printed,
and the workflow remained running.

The required Nix set is intentionally unchanged from the SDK 57 review:
`glib`, `nss`, `nspr`, `atk`, `at-spi2-atk`, `dbus`, the required X11
libraries, `mesa`, `libxkbcommon`, `alsa-lib`, `at-spi2-core`, `libgbm`,
`cups`, `expat`, `libdrm`, `pango`, `cairo`, `fontconfig`, `freetype`,
`systemd`, and `gtk3`.