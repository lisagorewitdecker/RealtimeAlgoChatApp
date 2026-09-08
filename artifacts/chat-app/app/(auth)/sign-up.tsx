import { useOAuth } from "@clerk/expo";
import { useSignUp } from "@clerk/expo/legacy";
import * as WebBrowser from "expo-web-browser";
import { Link } from "expo-router";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, StyleSheet, TouchableOpacity, View } from "react-native";
import { PRODUCT_NAME } from "@/constants/branding";
import { ScaledText as Text } from "@/components/ScaledText";
import { ScaledTextInput as TextInput } from "@/components/ScaledTextInput";
import { useColors } from "@/hooks/useColors";
import { trackEvent } from "@/utils/analytics";

WebBrowser.maybeCompleteAuthSession();

function clerkError(error: unknown) {
  const candidate = error as { errors?: Array<{ longMessage?: string; message?: string }> };
  return candidate.errors?.[0]?.longMessage ?? candidate.errors?.[0]?.message ?? "Unable to create your account. Please try again.";
}

export default function SignUpScreen() {
  const colors = useColors();
  const { signUp, setActive, isLoaded } = useSignUp();
  const { startOAuthFlow } = useOAuth({ strategy: "oauth_google" });
  const { startOAuthFlow: startXOAuthFlow } = useOAuth({ strategy: "oauth_x" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const signUpWithGoogle = useCallback(async () => {
    try {
      setLoading(true); setError("");
      const { createdSessionId, setActive: activate } = await startOAuthFlow();
      if (!createdSessionId || !activate) throw new Error("Google sign-up did not complete.");
      await activate({ session: createdSessionId });
      trackEvent("auth_completed", { flow: "sign_up", method: "google" });
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }, [startOAuthFlow]);
  const signUpWithX = useCallback(async () => {
    try {
      setLoading(true); setError("");
      const { createdSessionId, setActive: activate } = await startXOAuthFlow();
      if (!createdSessionId || !activate) throw new Error("X sign-up did not complete.");
      await activate({ session: createdSessionId });
      trackEvent("auth_completed", { flow: "sign_up", method: "x" });
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }, [startXOAuthFlow]);

  async function createAccount() {
    if (!isLoaded || !signUp) return;
    try {
      setLoading(true); setError("");
      await signUp.create({ emailAddress: email.trim(), password });
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setAwaitingCode(true);
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }

  async function verifyEmail() {
    if (!signUp) return;
    try {
      setLoading(true); setError("");
      const result = await signUp.attemptEmailAddressVerification({ code: code.trim() });
      if (result.status !== "complete" || !result.createdSessionId) {
        setError("Email verification is not complete yet.");
        return;
      }
      await setActive({ session: result.createdSessionId });
      trackEvent("auth_completed", {
        flow: "sign_up",
        method: "email_code",
      });
    } catch (cause) {
      setError(clerkError(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={styles.card}>
        <Text style={[styles.title, { color: colors.foreground }]}>{awaitingCode ? "Verify your email" : "Create your account"}</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>{awaitingCode ? "Enter the code sent to your email address." : `Join ${PRODUCT_NAME} to chat, call, and build together.`}</Text>
        {!awaitingCode ? <><TextInput style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius }]} placeholder="Email address" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} editable={!loading} /><TextInput style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius }]} placeholder="Password" placeholderTextColor={colors.mutedForeground} autoComplete="new-password" secureTextEntry value={password} onChangeText={setPassword} editable={!loading} /></> : <TextInput style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius }]} placeholder="Email verification code" placeholderTextColor={colors.mutedForeground} keyboardType="number-pad" value={code} onChangeText={setCode} editable={!loading} onSubmitEditing={verifyEmail} />}
        {error ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={awaitingCode ? "Verify email" : "Create account"} disabled={loading || (!awaitingCode && (!email || !password)) || (awaitingCode && !code)} onPress={awaitingCode ? verifyEmail : createAccount} style={[styles.button, { backgroundColor: colors.primary, borderRadius: colors.radius }]}>{loading ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={[styles.buttonText, { color: colors.primaryForeground }]}>{awaitingCode ? "Verify email" : "Create account"}</Text>}</TouchableOpacity>
        {!awaitingCode ? <><TouchableOpacity accessibilityRole="button" accessibilityLabel="Continue with Google" disabled={loading} onPress={signUpWithGoogle} style={[styles.oauth, { borderColor: colors.border, borderRadius: colors.radius }]}><Text style={[styles.oauthText, { color: colors.foreground }]}>Continue with Google</Text></TouchableOpacity><TouchableOpacity accessibilityRole="button" accessibilityLabel="Continue with X" disabled={loading} onPress={signUpWithX} style={[styles.oauth, { borderColor: colors.border, borderRadius: colors.radius }]}><Text style={[styles.oauthText, { color: colors.foreground }]}>Continue with X</Text></TouchableOpacity></> : null}
        <Text style={[styles.linkText, { color: colors.mutedForeground }]}>Already have an account? <Link href={"/(auth)/sign-in" as never} style={{ color: colors.primary }}>Sign in</Link></Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, justifyContent: "center", padding: 28 }, card: { gap: 14 }, title: { fontSize: 28, fontWeight: "700", flexShrink: 1, lineHeight: 34 }, subtitle: { fontSize: 15, marginBottom: 12, flexShrink: 1 }, input: { height: 52, borderWidth: 1, paddingHorizontal: 15, fontSize: 16 }, button: { height: 52, alignItems: "center", justifyContent: "center", marginTop: 4 }, buttonText: { fontSize: 16, fontWeight: "700" }, oauth: { height: 52, alignItems: "center", justifyContent: "center", borderWidth: 1 }, oauthText: { fontSize: 15, fontWeight: "600" }, error: { fontSize: 13, lineHeight: 18 }, linkText: { fontSize: 14, textAlign: "center", marginTop: 8 } });