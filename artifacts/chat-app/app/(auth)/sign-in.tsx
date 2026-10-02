import { useOAuth } from "@clerk/expo";
import { useSignIn } from "@clerk/expo/legacy";
import * as WebBrowser from "expo-web-browser";
import { Link } from "expo-router";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PRODUCT_NAME } from "@/constants/branding";
import { AppleSignInButton } from "@/components/AppleSignInButton";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { ScaledText as Text } from "@/components/ScaledText";
import { ScaledTextInput as TextInput } from "@/components/ScaledTextInput";
import { useColors } from "@/hooks/useColors";
import { trackEvent } from "@/utils/analytics";

WebBrowser.maybeCompleteAuthSession();

function clerkError(error: unknown) {
  const candidate = error as { errors?: Array<{ longMessage?: string; message?: string }> };
  return candidate.errors?.[0]?.longMessage ?? candidate.errors?.[0]?.message ?? "Unable to sign in. Please try again.";
}

type ResetStep = "signIn" | "email" | "code" | "password";

export default function SignInScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { signIn, setActive, isLoaded } = useSignIn();
  const { startOAuthFlow } = useOAuth({ strategy: "oauth_google" });
  const { startOAuthFlow: startXOAuthFlow } = useOAuth({ strategy: "oauth_x" });
  const { startOAuthFlow: startAppleOAuthFlow } = useOAuth({ strategy: "oauth_apple" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetStep, setResetStep] = useState<ResetStep>("signIn");
  const [clientTrustCode, setClientTrustCode] = useState("");
  const [awaitingClientTrust, setAwaitingClientTrust] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const signInWithGoogle = useCallback(async () => {
    try {
      setLoading(true); setError("");
      const { createdSessionId, setActive: activate } = await startOAuthFlow();
      if (!createdSessionId || !activate) throw new Error("Google sign-in did not complete.");
      await activate({ session: createdSessionId });
      trackEvent("auth_completed", { flow: "sign_in", method: "google" });
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }, [startOAuthFlow]);
  const signInWithX = useCallback(async () => {
    try {
      setLoading(true); setError("");
      const { createdSessionId, setActive: activate } = await startXOAuthFlow();
      if (!createdSessionId || !activate) throw new Error("X sign-in did not complete.");
      await activate({ session: createdSessionId });
      trackEvent("auth_completed", { flow: "sign_in", method: "x" });
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }, [startXOAuthFlow]);
  const signInWithApple = useCallback(async () => {
    try {
      setLoading(true); setError("");
      const { createdSessionId, setActive: activate } = await startAppleOAuthFlow();
      if (!createdSessionId || !activate) throw new Error("Apple sign-in did not complete.");
      await activate({ session: createdSessionId });
      trackEvent("auth_completed", { flow: "sign_in", method: "apple" });
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }, [startAppleOAuthFlow]);

  function clearReset() {
    setResetStep("signIn");
    setResetCode("");
    setNewPassword("");
    setClientTrustCode("");
    setAwaitingClientTrust(false);
    setError("");
  }

  function enterResetFlow() {
    setError("");
    setResetStep("email");
  }

  async function submitSignIn() {
    if (!isLoaded || !signIn) return;
    try {
      setLoading(true); setError("");
      const result = await signIn.create({ identifier: email.trim(), password });
      if (result.status === "needs_client_trust") {
        const emailFactor = result.supportedFirstFactors?.find(
          (factor) => factor.strategy === "email_code",
        );
        if (!emailFactor) {
          setError("Email verification is unavailable for this account.");
          return;
        }
        await signIn.prepareFirstFactor({
          strategy: "email_code",
          emailAddressId: emailFactor.emailAddressId,
        });
        setAwaitingClientTrust(true);
        return;
      }
      if (result.status !== "complete" || !result.createdSessionId) {
        setError("Additional verification is required to sign in.");
        return;
      }
      await setActive({ session: result.createdSessionId });
      trackEvent("auth_completed", { flow: "sign_in", method: "password" });
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }

  async function verifyClientTrust() {
    if (!isLoaded || !signIn || !clientTrustCode.trim()) return;
    try {
      setLoading(true); setError("");
      const result = await signIn.attemptFirstFactor({
        strategy: "email_code",
        code: clientTrustCode.trim(),
      });
      if (result.status !== "complete" || !result.createdSessionId) {
        setError("Account verification is not complete yet.");
        return;
      }
      await setActive({ session: result.createdSessionId });
      trackEvent("auth_completed", {
        flow: "sign_in",
        method: "password_email_code",
      });
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }

  async function requestPasswordReset() {
    if (!isLoaded || !signIn || !email.trim()) return;
    try {
      setLoading(true); setError("");
      await signIn.create({
        strategy: "reset_password_email_code",
        identifier: email.trim(),
      });
      setResetStep("code");
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }

  async function verifyResetCode() {
    if (!isLoaded || !signIn || !resetCode.trim()) return;
    try {
      setLoading(true); setError("");
      const result = await signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code: resetCode.trim(),
      });
      if (result.status !== "needs_new_password") {
        setError("This reset code could not be verified. Please request a new code.");
        return;
      }
      setResetStep("password");
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }

  async function updatePassword() {
    if (!isLoaded || !signIn || !newPassword) return;
    try {
      setLoading(true); setError("");
      const result = await signIn.resetPassword({ password: newPassword });
      if (result.status !== "complete" || !result.createdSessionId) {
        setError("Your password could not be updated. Please try again.");
        return;
      }
      await setActive({ session: result.createdSessionId });
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }

  const isAlternateFlow = awaitingClientTrust || resetStep !== "signIn";
  const title = awaitingClientTrust ? "Verify your account" : resetStep === "signIn" ? `Sign in to your ${PRODUCT_NAME} Workspace` : resetStep === "email" ? "Reset your password" : resetStep === "code" ? "Check your email" : "Create a new password";
  const subtitle = awaitingClientTrust
    ? "Enter the code sent to your email."
    : resetStep === "signIn"
    ? `Sign in to your ${PRODUCT_NAME} workspace.`
    : resetStep === "email"
      ? "Enter your account email and we'll send you a reset code."
    : resetStep === "code"
      ? `Enter the reset code sent to ${email.trim()}.`
      : `Choose a new password for your ${PRODUCT_NAME} account.`;
  const action = awaitingClientTrust ? verifyClientTrust : resetStep === "signIn" ? submitSignIn : resetStep === "email" ? requestPasswordReset : resetStep === "code" ? verifyResetCode : updatePassword;
  const actionLabel = awaitingClientTrust ? "Verify" : resetStep === "signIn" ? "Sign in" : resetStep === "email" ? "Send reset code" : resetStep === "code" ? "Verify reset code" : "Update password";
  const actionDisabled = loading || (awaitingClientTrust ? !clientTrustCode : resetStep === "signIn" ? !email || !password : resetStep === "email" ? !email : resetStep === "code" ? !resetCode : !newPassword);

  return (
    <KeyboardAwareScrollViewCompat
      testID="sign-in-scroll"
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.root,
        {
          paddingTop: (Platform.OS === "web" ? 67 : insets.top) + 28,
          paddingBottom: (Platform.OS === "web" ? 34 : insets.bottom) + 28,
        },
      ]}
      bottomOffset={68}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      <>
        <Text
          accessibilityRole="header"
          {...{ role: "heading", "aria-level": 1 }}
          style={[styles.title, { color: colors.foreground }]}
        >
          {title}
        </Text>
        {!awaitingClientTrust && resetStep === "signIn" ? (
          <Text
            accessibilityRole="header"
            {...{ role: "heading", "aria-level": 2 }}
            style={[styles.greeting, { color: colors.foreground }]}
          >
            welcome back
          </Text>
        ) : null}
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>{subtitle}</Text>
        {awaitingClientTrust ? (
          <TextInput testID="sign-in-client-trust-code" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius }]} placeholder="6-digit code" placeholderTextColor={colors.mutedForeground} keyboardType="number-pad" value={clientTrustCode} onChangeText={setClientTrustCode} editable={!loading} onSubmitEditing={verifyClientTrust} />
        ) : resetStep === "signIn" ? (
          <>
            <TextInput testID="sign-in-email" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius }]} placeholder="Email address" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} editable={!loading} />
            <TextInput testID="sign-in-password" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius }]} placeholder="Password" placeholderTextColor={colors.mutedForeground} autoComplete="password" secureTextEntry value={password} onChangeText={setPassword} editable={!loading} onSubmitEditing={submitSignIn} />
          </>
        ) : resetStep === "email" ? (
          <TextInput testID="password-reset-email" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius }]} placeholder="Email address" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} editable={!loading} onSubmitEditing={requestPasswordReset} />
        ) : resetStep === "code" ? (
          <TextInput testID="password-reset-code" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius }]} placeholder="Reset code" placeholderTextColor={colors.mutedForeground} keyboardType="number-pad" value={resetCode} onChangeText={setResetCode} editable={!loading} onSubmitEditing={verifyResetCode} />
        ) : (
          <TextInput testID="password-reset-new-password" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius }]} placeholder="New password" placeholderTextColor={colors.mutedForeground} autoComplete="new-password" secureTextEntry value={newPassword} onChangeText={setNewPassword} editable={!loading} onSubmitEditing={updatePassword} />
        )}
        {error ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}
        <TouchableOpacity testID="sign-in-primary-action" accessibilityRole="button" accessibilityLabel={actionLabel} disabled={actionDisabled} onPress={action} style={[styles.button, { backgroundColor: colors.primary, borderRadius: colors.radius }]}>
          {loading ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>{actionLabel}</Text>}
        </TouchableOpacity>
        {!isAlternateFlow ? (
          <>
            <TouchableOpacity testID="forgot-password-button" accessibilityRole="button" accessibilityLabel="Forgot password" disabled={loading} onPress={enterResetFlow} style={styles.textButton}>
              <Text style={[styles.linkText, { color: colors.primary }]}>Forgot password?</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Continue with Google" disabled={loading} onPress={signInWithGoogle} style={[styles.oauth, { borderColor: colors.border, borderRadius: colors.radius }]}>
              <Text style={[styles.oauthText, { color: colors.foreground }]}>Continue with Google</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Continue with X" disabled={loading} onPress={signInWithX} style={[styles.oauth, { borderColor: colors.border, borderRadius: colors.radius }]}>
              <Text style={[styles.oauthText, { color: colors.foreground }]}>Continue with X</Text>
            </TouchableOpacity>
            <AppleSignInButton disabled={loading} onPress={signInWithApple} />
            <Text style={[styles.linkText, { color: colors.mutedForeground }]}>New here? <Link href={"/(auth)/sign-up" as never} style={{ color: colors.primary }}>Create an account</Link></Text>
          </>
        ) : (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to sign in" disabled={loading} onPress={clearReset} style={styles.textButton}>
            <Text style={[styles.linkText, { color: colors.primary }]}>Back to sign in</Text>
          </TouchableOpacity>
        )}
      </>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  root: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 14,
  },
  title: { fontSize: 28, fontWeight: "700", flexShrink: 1, lineHeight: 34 },
  greeting: { fontSize: 20, fontWeight: "600" },
  subtitle: { fontSize: 15, marginBottom: 12 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    paddingHorizontal: 15,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  buttonText: { fontSize: 16, fontWeight: "700", textAlign: "center" },
  oauth: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  oauthText: { fontSize: 15, fontWeight: "600", textAlign: "center" },
  error: { fontSize: 13, lineHeight: 18 },
  linkText: { fontSize: 14, textAlign: "center", marginTop: 8 },
  textButton: { alignItems: "center" },
});