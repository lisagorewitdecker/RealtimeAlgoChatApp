import React from "react";
import {
  TextInput,
  type TextInputProps,
  type TextStyle,
} from "react-native";
import { useFontScale } from "@/contexts/AccessibilityContext";
import { scaleTextStyle } from "@/components/ScaledText";

export const ScaledTextInput = React.forwardRef<TextInput, TextInputProps>(
  ({ style, ...props }, ref) => {
    const fontScale = useFontScale();
    return (
      <TextInput
        ref={ref}
        {...props}
        style={scaleTextStyle(style as TextStyle, fontScale)}
      />
    );
  },
);

ScaledTextInput.displayName = "ScaledTextInput";