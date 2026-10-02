import React from "react";
import {
  StyleSheet,
  Text,
  type StyleProp,
  type TextProps,
  type TextStyle,
} from "react-native";
import { useFontScale } from "@/contexts/AccessibilityContext";

export const MIN_LEGIBLE_FONT_SIZE = 12;

export function scaleTextStyle(
  style: StyleProp<TextStyle>,
  fontScale: number,
): TextStyle | undefined {
  const flattened = StyleSheet.flatten(style);
  if (!flattened) return undefined;

  const scaled = { ...flattened };
  if (typeof scaled.fontSize === "number") {
    scaled.fontSize = Math.max(
      scaled.fontSize * fontScale,
      MIN_LEGIBLE_FONT_SIZE,
    );
  }
  if (typeof scaled.lineHeight === "number") {
    scaled.lineHeight *= fontScale;
  }
  return scaled;
}

/**
 * Applies the user's in-app text-size preference to every text style,
 * including line height, without changing color or motion preferences.
 */
export function ScaledText({ style, ...props }: TextProps) {
  const fontScale = useFontScale();
  return <Text {...props} style={scaleTextStyle(style, fontScale)} />;
}