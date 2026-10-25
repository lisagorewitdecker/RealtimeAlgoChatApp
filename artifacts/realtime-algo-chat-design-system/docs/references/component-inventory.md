# Component inventory

Source: `artifacts/chat-app` in this workspace.

<table>
  <thead>
    <tr>
      <th>Family</th>
      <th>Reference</th>
      <th>Dependencies</th>
      <th>Evidence</th>
      <th>Chunk</th>
      <th>Status</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Scaled text</td>
      <td><code>components/scaled-text.md</code></td>
      <td>Accessibility font scale</td>
      <td>Used across the app</td>
      <td>Pilot</td>
      <td>implemented</td>
    </tr>
    <tr>
      <td>Scaled text input</td>
      <td><code>components/scaled-text-input.md</code></td>
      <td>Scaled text behavior</td>
      <td>Used in all major forms</td>
      <td>Pilot</td>
      <td>implemented</td>
    </tr>
    <tr>
      <td>Room card</td>
      <td><code>components/room-card.md</code></td>
      <td>Scaled text, theme</td>
      <td>Primary room list</td>
      <td>Pilot</td>
      <td>implemented</td>
    </tr>
    <tr>
      <td>Message bubble</td>
      <td><code>components/message-bubble.md</code></td>
      <td>Scaled text, theme</td>
      <td>Core room conversation</td>
      <td>Pilot</td>
      <td>implemented</td>
    </tr>
    <tr>
      <td>Device status card</td>
      <td><code>components/status-card.md</code></td>
      <td>Theme, confirmation</td>
      <td>Profile security surface</td>
      <td>Pilot</td>
      <td>implemented</td>
    </tr>
    <tr>
      <td>Keyboard-aware form container</td>
      <td><code>components/keyboard-aware-form.md</code></td>
      <td>Keyboard controller</td>
      <td>Four major forms</td>
      <td>2</td>
      <td>implemented</td>
    </tr>
    <tr>
      <td>Apple sign-in button</td>
      <td><code>components/apple-sign-in-button.md</code></td>
      <td>Apple policy, vector icon</td>
      <td>Sign-in and sign-up</td>
      <td>2</td>
      <td>implemented</td>
    </tr>
    <tr>
      <td>Error boundary and fallback</td>
      <td><code>components/error-boundary.md</code></td>
      <td>Expo reload, modal</td>
      <td>Global app root</td>
      <td>2</td>
      <td>implemented</td>
    </tr>
    <tr>
      <td>App footer</td>
      <td><code>components/app-footer.md</code></td>
      <td>Scaled text</td>
      <td>Auth and setup screens</td>
      <td>2</td>
      <td>implemented</td>
    </tr>
  </tbody>
</table>
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
