# Component inventory

Source: `artifacts/chat-app` in this workspace.

- **Scaled text**
  - Reference: `components/scaled-text.md`
  - Dependencies: Accessibility font scale
  - Evidence: Used across the app
  - Chunk: Pilot; Status: implemented
- **Scaled text input**
  - Reference: `components/scaled-text-input.md`
  - Dependencies: Scaled text behavior
  - Evidence: Used in all major forms
  - Chunk: Pilot; Status: implemented
- **Room card**
  - Reference: `components/room-card.md`
  - Dependencies: Scaled text, theme
  - Evidence: Primary room list
  - Chunk: Pilot; Status: implemented
- **Message bubble**
  - Reference: `components/message-bubble.md`
  - Dependencies: Scaled text, theme
  - Evidence: Core room conversation
  - Chunk: Pilot; Status: implemented
- **Device status card**
  - Reference: `components/status-card.md`
  - Dependencies: Theme, confirmation
  - Evidence: Profile security surface
  - Chunk: Pilot; Status: implemented
- **Keyboard-aware form container**
  - Reference: `components/keyboard-aware-form.md`
  - Dependencies: Keyboard controller
  - Evidence: Four major forms
  - Chunk: 2; Status: implemented
- **Apple sign-in button**
  - Reference: `components/apple-sign-in-button.md`
  - Dependencies: Apple policy, vector icon
  - Evidence: Sign-in and sign-up
  - Chunk: 2; Status: implemented
- **Error boundary and fallback**
  - Reference: `components/error-boundary.md`
  - Dependencies: Expo reload, modal
  - Evidence: Global app root
  - Chunk: 2; Status: implemented
- **App footer**
  - Reference: `components/app-footer.md`
  - Dependencies: Scaled text
  - Evidence: Auth and setup screens
  - Chunk: 2; Status: implemented

The pilot was ranked by shared usage and product importance. App-specific screen
compositions such as the AI panel are excluded.
