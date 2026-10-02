import { Feather } from "@expo/vector-icons";
import { useClerk } from "@clerk/expo";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PRODUCT_NAME } from "@/constants/branding";
import { useApp } from "@/contexts/AppContext";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { ScaledText as Text } from "@/components/ScaledText";
import { ScaledTextInput as TextInput } from "@/components/ScaledTextInput";
import { useColors } from "@/hooks/useColors";

export default function SetupScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { setUsername } = useApp();
  const { signOut } = useClerk();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function handleContinue() {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError("Name must be at least 2 characters.");
      return;
    }
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await setUsername(trimmed);
      router.replace("/(tabs)");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save your display name. Please try again.",
      );
    }
  }

  return (
    <KeyboardAwareScrollViewCompat
      testID="setup-scroll"
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.inner,
        {
          paddingTop: (Platform.OS === "web" ? 67 : insets.top) + 24,
          paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 24,
        },
      ]}
      bottomOffset={72}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      <>
        <View
          style={[
            styles.iconRing,
            { backgroundColor: colors.secondary, borderRadius: colors.radius * 3 },
          ]}
        >
          <Feather name="terminal" size={36} color={colors.primary} />
        </View>
        <View style={styles.brandBlock}>
          <Text style={[styles.headline, { color: colors.foreground }]}>{PRODUCT_NAME}</Text>
          <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
            Build · Call · Ship
          </Text>
        </View>

        <View style={styles.capabilities}>
          <View style={styles.capabilityRow}>
            <View style={[styles.capabilityIcon, { backgroundColor: colors.muted }]}>
              <Feather name="video" size={18} color={colors.mutedForeground} />
            </View>
            <Text style={[styles.capabilityText, { color: colors.secondaryForeground }]}>
              WebRTC video rooms with peers
            </Text>
          </View>
          <View style={styles.capabilityRow}>
            <View style={[styles.capabilityIcon, { backgroundColor: colors.muted }]}>
              <Feather name="code" size={18} color={colors.mutedForeground} />
            </View>
            <Text style={[styles.capabilityText, { color: colors.secondaryForeground }]}>
              HTML, CSS & JS playground
            </Text>
          </View>
        </View>

        <View style={styles.form}>
          <Text style={[styles.label, { color: colors.secondaryForeground }]}>DISPLAY NAME</Text>
          <TextInput
            testID="setup-display-name-input"
            style={[
              styles.input,
              {
                backgroundColor: colors.card,
                color: colors.foreground,
                borderColor: error ? colors.destructive : colors.border,
                borderRadius: colors.radius,
              },
            ]}
            placeholder="How should your team know you?"
            placeholderTextColor={colors.mutedForeground}
            value={name}
            onChangeText={(t) => { setName(t); setError(""); }}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={handleContinue}
            maxLength={30}
          />
          {error ? (
            <Text accessibilityRole="alert" style={[styles.error, { color: colors.destructive }]}>{error}</Text>
          ) : null}

          <TouchableOpacity
            testID="setup-submit-button"
            style={[
              styles.btn,
              {
                backgroundColor: name.trim().length >= 2 ? colors.primary : colors.muted,
                borderRadius: colors.radius,
              },
            ]}
            onPress={handleContinue}
            activeOpacity={0.8}
          >
            <Text
              style={[
                styles.btnText,
                { color: name.trim().length >= 2 ? colors.primaryForeground : colors.mutedForeground },
              ]}
            >
              Enter workspace
            </Text>
            <Feather
              name="arrow-right"
              size={18}
              color={name.trim().length >= 2 ? colors.primaryForeground : colors.mutedForeground}
            />
          </TouchableOpacity>
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            Choose the display name your team will see.
          </Text>
          <TouchableOpacity
            testID="setup-sign-out-button"
            onPress={async () => {
              await signOut();
              router.replace("/(auth)/sign-in" as never);
            }}
            activeOpacity={0.8}
          >
            <Text style={[styles.signOut, { color: colors.mutedForeground }]}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  inner: { flexGrow: 1, paddingHorizontal: 28, justifyContent: "center" },
  iconRing: {
    width: 54, height: 54, alignItems: "center",
    justifyContent: "center", alignSelf: "center", marginBottom: 16,
  },
  headline: {
    fontSize: 28, fontWeight: "700" as const, textAlign: "center",
    flexShrink: 1, lineHeight: 34,
  },
  brandBlock: { alignItems: "center", marginBottom: 28 },
  eyebrow: { fontSize: 14, marginTop: 4 },
  capabilities: { gap: 14, marginBottom: 34 },
  capabilityRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  capabilityIcon: {
    width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center",
  },
  capabilityText: { fontSize: 15, fontWeight: "500" as const },
  form: { gap: 10 },
  label: { fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.8 },
  input: {
    minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, fontSize: 16,
    borderWidth: 1.5,
  },
  error: { fontSize: 12, marginTop: 2 },
  btn: {
    minHeight: 54, flexDirection: "row", alignItems: "center",
    justifyContent: "center", gap: 8, marginTop: 8,
    paddingHorizontal: 12, paddingVertical: 12,
  },
  btnText: { fontSize: 16, fontWeight: "700" as const, textAlign: "center", flexShrink: 1 },
  hint: { fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 8 },
  signOut: { fontSize: 13, fontWeight: "600" as const, textAlign: "center", marginTop: 10 },
});
