# Consuming RealtimeAlgoChatApp Design System in slide decks

Read `artifacts/realtime-algo-chat-design-system/docs/AGENTS.md` first. Slide decks
(SDM documents) do not consume CSS, Tailwind, or React components. Do NOT add
this package as a dependency of a slides artifact, import `styles.css`, or
copy components into it. Instead, translate this package's tokens into each
slide document's `theme` block.

## Token mapping

The source of truth is `tokens.json` (the generated hex object in
`src/generated/tokens.tsx` carries the same values, already in hex):

- Pick ONE mode -- the `light` or `dark` color set -- for the whole deck and
  hold it on every slide.
- `background` -> `theme.colors.background`; `card` or `secondary` ->
  `theme.colors.surface`; `foreground` -> `theme.colors.foreground`;
  `mutedForeground` -> `theme.colors.muted`; `primary` ->
  `theme.colors.accent`; `chart1`..`chart5` -> table and widget data colors.
- Every value in an SDM theme is a 6-digit hex string (`"#RRGGBB"`); resolve
  any HSL or channel form before writing it.
- Map this system's font families to `theme.fonts.display` /
  `theme.fonts.body`. A family outside the deck's built-in font registry
  needs a Google Fonts css2 `<link>` in the deck's `index.html` covering
  every weight used.
- Use the radius token as `cornerRadius` on card and panel shapes. Shadows
  do not exist in SDM -- drop shadow tokens.
- Keep the same `theme` block byte-identical in every slide document.

The slides skill's `sdm-design.md` reference (injected when a deck is
created) carries the full mapping table and the deck design language.
