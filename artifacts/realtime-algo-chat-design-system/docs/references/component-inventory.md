# Component inventory

Source: `artifacts/chat-app` in this workspace.

| Family | Reference | Dependencies | Evidence | Chunk | Status |
|---|---|---|---|---|---|
| Scaled text | `components/scaled-text.md` | Accessibility font scale | Used across the app | Pilot | implemented |
| Scaled text input | `components/scaled-text-input.md` | Scaled text behavior | Used in all major forms | Pilot | implemented |
| Room card | `components/room-card.md` | Scaled text, theme | Primary room list | Pilot | implemented |
| Message bubble | `components/message-bubble.md` | Scaled text, theme | Core room conversation | Pilot | implemented |
| Device status card | `components/status-card.md` | Theme, confirmation | Profile security surface | Pilot | implemented |
| Keyboard-aware form container | `components/keyboard-aware-form.md` | Keyboard controller | Four major forms | 2 | implemented |
| Apple sign-in button | `components/apple-sign-in-button.md` | Apple policy, vector icon | Sign-in and sign-up | 2 | implemented |
| Error boundary and fallback | `components/error-boundary.md` | Expo reload, modal | Global app root | 2 | implemented |
| App footer | `components/app-footer.md` | Scaled text | Auth and setup screens | 2 | implemented |

The pilot was ranked by shared usage and product importance. App-specific screen
compositions such as the AI panel are excluded.