import { Feather } from "@expo/vector-icons";
import { useSignIn } from "@clerk/expo";
import { Link, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScaledText as Text } from "@/components/ScaledText";
import { ScaledTextInput as TextInput } from "@/components/ScaledTextInput";
import { PRODUCT_NAME } from "@/constants/branding";
import { useColors } from "@/hooks/useColors";

type ResetStep = "email" | "code" | "password";

export default function ForgotPasswordScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn, errors, fetchStatus } = useSignIn();
  const [step, setStep] = useState<ResetStep>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const isLoading = fetchStatus === "fetching";

  async function sendResetCode() {
    if (!email.trim() || isLoading) return;
    const identified = await signIn.create({ identifier: email.trim() });
    if (identified.error) return;
    const sent = await signIn.resetPasswordEmailCode.sendCode();
    if (!sent.error) setStep("code");
  }

  async function verifyCode() {
    if (!code.trim() || isLoading) return;
    const verified = await signIn.resetPasswordEmailCode.verifyCode({
      code: code.trim(),
    });
    if (!verified.error && signIn.status === "needs_new_password") {
      setStep("password");
    }
  }

  async function savePassword() {
    if (password.length < 8 || isLoading) return;
    const result = await signIn.resetPasswordEmailCode.submitPassword({
      password,
      signOutOfOtherSessions: true,
    });
    if (result.error || signIn.status !== "complete") return;
    await signIn.finalize({
      navigate: ({ session }) => {
        if (!session?.currentTask) router.replace("/(tabs)");
      },
    });
  }

  const title =
    step === "email"
      ? "Reset your password"
      : step === "code"
        ? "Check your email"
        : "Choose a new password";
  const subtitle =
    step === "email"
      ? "We’ll send a secure verification code."
      : step === "code"
        ? `Enter the code sent to ${email}.`
        : "Use at least 8 characters.";
  const fieldError =
    errors?.fields?.identifier?.message ||
    errors?.fields?.code?.message ||
    errors?.fields?.password?.message;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View
        style={[
          styles.inner,
          {
            paddingTop: (Platform.OS === "web" ? 67 : insets.top) + 32,
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        <View style={styles.brandRow}>
          <View style={[styles.iconRing, { backgroundColor: colors.secondary }]}>
            <Feather name="lock" size={26} color={colors.primary} />
          </View>
          <Text style={[styles.brand, { color: colors.foreground }]}>{PRODUCT_NAME}</Text>
        </View>

        <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {subtitle}
        </Text>

        <View style={styles.form}>
          {step === "email" ? (
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  color: colors.foreground,
                  borderColor: fieldError ? colors.destructive : colors.border,
                  borderRadius: colors.radius,
                },
              ]}
              placeholder="you@example.com"
              placeholderTextColor={colors.mutedForeground}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoFocus
              returnKeyType="send"
              onSubmitEditing={sendResetCode}
            />
          ) : step === "code" ? (
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  color: colors.foreground,
                  borderColor: fieldError ? colors.destructive : colors.border,
                  borderRadius: colors.radius,
                },
              ]}
              placeholder="6-digit code"
              placeholderTextColor={colors.mutedForeground}
              value={code}
              onChangeText={setCode}
              keyboardType="numeric"
              autoFocus
              returnKeyType="done"
              onSubmitEditing={verifyCode}
            />
          ) : (
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  color: colors.foreground,
                  borderColor: fieldError ? colors.destructive : colors.border,
                  borderRadius: colors.radius,
                },
              ]}
              placeholder="New password"
              placeholderTextColor={colors.mutedForeground}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoFocus
              returnKeyType="done"
              onSubmitEditing={savePassword}
            />
          )}

          {fieldError ? (
            <Text style={[styles.error, { color: colors.destructive }]}>
              {fieldError}
            </Text>
          ) : null}

          <TouchableOpacity
            style={[
              styles.button,
              {
                backgroundColor: colors.primary,
                borderRadius: colors.radius,
                opacity: isLoading ? 0.65 : 1,
              },
            ]}
            onPress={
              step === "email"
                ? sendResetCode
                : step === "code"
                  ? verifyCode
                  : savePassword
            }
            disabled={isLoading}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>
                {step === "email"
                  ? "Send reset code"
                  : step === "code"
                    ? "Verify code"
                    : "Save new password"}
              </Text>
            )}
          </TouchableOpacity>

          {step === "code" ? (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => signIn.resetPasswordEmailCode.sendCode()}
            >
              <Text style={[styles.link, { color: colors.primary }]}>Resend code</Text>
            </TouchableOpacity>
          ) : null}

          <Link href="/(auth)/sign-in" asChild>
            <TouchableOpacity style={styles.secondaryButton}>
              <Text style={[styles.link, { color: colors.mutedForeground }]}>
                Back to sign in
              </Text>
            </TouchableOpacity>
          </Link>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  inner: { flex: 1, paddingHorizontal: 28, justifyContent: "center" },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    marginBottom: 32,
  },
  iconRing: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: { fontSize: 22, fontWeight: "800" as const },
  title: { fontSize: 26, fontWeight: "700" as const, marginBottom: 6 },
  subtitle: { fontSize: 14, lineHeight: 20, marginBottom: 28 },
  form: { gap: 12 },
  input: { height: 52, paddingHorizontal: 16, fontSize: 16, borderWidth: 1.5 },
  error: { fontSize: 12 },
  button: {
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  buttonText: { fontSize: 16, fontWeight: "700" as const },
  secondaryButton: { alignItems: "center", paddingVertical: 10 },
  link: { fontSize: 14, fontWeight: "600" as const },
});