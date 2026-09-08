import { useColorScheme } from "react-native";
import colors from "@/constants/colors";
import { useAccessibility } from "@/contexts/AccessibilityContext";

/**
 * Returns the design tokens for the current color scheme, respecting
 * high-contrast and font-scale accessibility preferences.
 *
 * When highContrast is enabled the dedicated high-contrast palette is
 * returned regardless of the system dark/light setting — it already
 * targets WCAG AA/AAA contrast ratios.
 */
export function useColors() {
  const scheme = useColorScheme();
  const { highContrast } = useAccessibility();

  const palette = highContrast
    ? colors.highContrast
    : scheme === "dark"
      ? colors.dark
      : colors.light;

  return { ...palette, radius: colors.radius };
}
