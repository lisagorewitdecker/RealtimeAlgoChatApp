const colors = {
  light: {
    text: "#F4F6FA",
    tint: "#5AA5FA",
    background: "#0E1118",
    foreground: "#F4F6FA",
    card: "#171B24",
    cardForeground: "#F4F6FA",
    primary: "#5AA5FA",
    primaryForeground: "#FFFFFF",
    secondary: "#202938",
    secondaryForeground: "#D8E9FF",
    muted: "#1C222D",
    mutedForeground: "#9AA4B5",
    accent: "#79BAFF",
    accentForeground: "#0E1118",
    destructive: "#F97070",
    destructiveForeground: "#FFFFFF",
    border: "#343D4C",
    input: "#343D4C",
    bubbleSelf: "#357FD5",
    bubbleSelfText: "#FFFFFF",
    bubbleOther: "#202631",
    bubbleOtherText: "#F4F6FA",
    systemMsg: "#9AA4B5",
    online: "#55C995",
    // Surface of the classic tab bar on web: `background` at partial opacity,
    // so content scrolling under the absolutely positioned bar shows through
    // it the way it does through the iOS blur (Android paints the bar with
    // the opaque `background` instead). The alpha keeps the tab tints
    // (`primary`, `mutedForeground`) at 4.5:1 or better even over white
    // content; `__tests__/TabLayout.test.tsx` checks it. iOS only draws this
    // panel in the high-contrast palette below.
    tabBarBackground: "rgba(14, 17, 24, 0.85)",
  },
  dark: {
    text: "#F4F6FA",
    tint: "#5AA5FA",
    background: "#0E1118",
    foreground: "#F4F6FA",
    card: "#171B24",
    cardForeground: "#F4F6FA",
    primary: "#5AA5FA",
    primaryForeground: "#FFFFFF",
    secondary: "#202938",
    secondaryForeground: "#D8E9FF",
    muted: "#1C222D",
    mutedForeground: "#9AA4B5",
    accent: "#79BAFF",
    accentForeground: "#0E1118",
    destructive: "#F97070",
    destructiveForeground: "#FFFFFF",
    border: "#343D4C",
    input: "#343D4C",
    bubbleSelf: "#357FD5",
    bubbleSelfText: "#FFFFFF",
    bubbleOther: "#202631",
    bubbleOtherText: "#F4F6FA",
    systemMsg: "#9AA4B5",
    online: "#55C995",
    tabBarBackground: "rgba(14, 17, 24, 0.85)",
  },
  // High-contrast palette — WCAG AA/AAA compliant with much stronger contrast
  highContrast: {
    text: "#FFFFFF",
    tint: "#60BFFF",
    background: "#000000",
    foreground: "#FFFFFF",
    card: "#0A0A0A",
    cardForeground: "#FFFFFF",
    primary: "#60BFFF",
    primaryForeground: "#000000",
    secondary: "#111111",
    secondaryForeground: "#FFFFFF",
    muted: "#111111",
    mutedForeground: "#CCCCCC",
    accent: "#80D0FF",
    accentForeground: "#000000",
    destructive: "#FF6060",
    destructiveForeground: "#FFFFFF",
    border: "#555555",
    input: "#555555",
    bubbleSelf: "#0055CC",
    bubbleSelfText: "#FFFFFF",
    bubbleOther: "#1A1A1A",
    bubbleOtherText: "#FFFFFF",
    systemMsg: "#BBBBBB",
    online: "#00EE88",
    // The panel web draws and iOS swaps in for its native blur while high
    // contrast is on — on iOS 26 the native Liquid Glass bar takes the same
    // panel as its `backgroundColor`. Denser than the default palettes on
    // purpose: still see-through, but low-vision users get less visual noise
    // behind the tab controls (the same idea as the system "Reduce
    // Transparency" setting, which the app's Reduce transparency toggle
    // follows to a fully opaque bar). `__tests__/TabLayout.test.tsx` checks
    // it stays denser.
    tabBarBackground: "rgba(0, 0, 0, 0.9)",
  },
  radius: 12,
};

export default colors;
