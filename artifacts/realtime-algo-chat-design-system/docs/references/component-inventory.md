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

The pilot was ranked by shared usage and product importance. App-specific screen
compositions such as the AI panel are excluded.
