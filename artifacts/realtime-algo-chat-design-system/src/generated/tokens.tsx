/* GENERATED FROM tokens.json -- DO NOT EDIT. Run scripts/build-tokens.mjs. */
// Portable design tokens (colors as hex). Web consumes the theme via
// src/index.css; mobile (Expo) and any other platform import this object so the
// whole product shares one source of truth.
export const tokens = {
  "color": {
    "light": {
      "background": "#0E1118",
      "foreground": "#F4F6FA",
      "border": "#343D4C",
      "card": "#171B24",
      "cardForeground": "#F4F6FA",
      "popover": "#171B24",
      "popoverForeground": "#F4F6FA",
      "primary": "#5AA5FA",
      "primaryForeground": "#FFFFFF",
      "secondary": "#202938",
      "secondaryForeground": "#D8E9FF",
      "muted": "#1C222D",
      "mutedForeground": "#9AA4B5",
      "accent": "#79BAFF",
      "accentForeground": "#0E1118",
      "destructive": "#F97070",
      "destructiveForeground": "#FFFFFF",
      "input": "#343D4C",
      "ring": "#79BAFF",
      "chart1": "#5AA5FA",
      "chart2": "#55C995",
      "chart3": "#79BAFF",
      "chart4": "#F6C453",
      "chart5": "#F97070",
      "sidebar": "#171B24",
      "sidebarForeground": "#F4F6FA",
      "sidebarBorder": "#343D4C",
      "sidebarPrimary": "#5AA5FA",
      "sidebarPrimaryForeground": "#FFFFFF",
      "sidebarAccent": "#202938",
      "sidebarAccentForeground": "#D8E9FF",
      "sidebarRing": "#79BAFF"
    },
    "dark": {
      "background": "#0E1118",
      "foreground": "#F4F6FA",
      "border": "#343D4C",
      "card": "#171B24",
      "cardForeground": "#F4F6FA",
      "popover": "#171B24",
      "popoverForeground": "#F4F6FA",
      "primary": "#5AA5FA",
      "primaryForeground": "#FFFFFF",
      "secondary": "#202938",
      "secondaryForeground": "#D8E9FF",
      "muted": "#1C222D",
      "mutedForeground": "#9AA4B5",
      "accent": "#79BAFF",
      "accentForeground": "#0E1118",
      "destructive": "#F97070",
      "destructiveForeground": "#FFFFFF",
      "input": "#343D4C",
      "ring": "#79BAFF",
      "chart1": "#5AA5FA",
      "chart2": "#55C995",
      "chart3": "#79BAFF",
      "chart4": "#F6C453",
      "chart5": "#F97070",
      "sidebar": "#171B24",
      "sidebarForeground": "#F4F6FA",
      "sidebarBorder": "#343D4C",
      "sidebarPrimary": "#5AA5FA",
      "sidebarPrimaryForeground": "#FFFFFF",
      "sidebarAccent": "#202938",
      "sidebarAccentForeground": "#D8E9FF",
      "sidebarRing": "#79BAFF"
    }
  },
  "fontFamily": {
    "sans": [
      "Inter",
      "sans-serif"
    ],
    "serif": [
      "Georgia",
      "serif"
    ],
    "mono": [
      "Courier New",
      "monospace"
    ]
  },
  "radius": "0.75rem",
  "spacing": "0.25rem"
} as const;

export type Tokens = typeof tokens;
export default tokens;
