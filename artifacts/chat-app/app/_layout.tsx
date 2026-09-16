import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { ClerkLoaded, ClerkProvider, useAuth, useClerk } from "@clerk/expo";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppFooter } from "@/components/AppFooter";
import { ScaledText as Text } from "@/components/ScaledText";
import { PRODUCT_NAME } from "@/constants/branding";
import { AppProvider, useApp } from "@/contexts/AppContext";
import { getClerkConfiguration } from "@/lib/clerkConfig";
import { CryptoProvider } from "@/contexts/CryptoContext";
import { SocketProvider } from "@/contexts/SocketContext";
import { clerkTokenCache } from "@/lib/clerkTokenCache";
import { Sentry, sentryEnabled } from "@/lib/sentry";

if (process.env["EXPO_PUBLIC_DOMAIN"]) {
  setBaseUrl(`https://${process.env["EXPO_PUBLIC_DOMAIN"]}`);
}

SplashScreen.preventAutoHideAsync();
import { AccessibilityProvider } from "@/contexts/AccessibilityContext";

const queryClient = new QueryClient();

function RootLayoutContent() {
  const { accessStatus, isReady, username } = useApp();
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const router = useRouter();
  const segments = useSegments();
  const isSetupRoute = segments[0] === "setup";
  const isSentrySmokeRoute =
    (segments as readonly string[])[0] === "sentry-smoke";
  const isAuthRoute =
    isSentrySmokeRoute ||
    (segments as readonly string[]).includes("(auth)") ||
    segments[0] === "sign-in" ||
    segments[0] === "sign-up";
  const canRender = isLoaded && (!isSignedIn || isReady);

  useEffect(() => {
    if (canRender) SplashScreen.hideAsync();
  }, [canRender]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn && !isAuthRoute) {
      router.replace("/(auth)/sign-in" as never);
    } else if (
      isSignedIn &&
      isReady &&
      accessStatus === "ready" &&
      !username &&
      !isSetupRoute
    ) {
      router.replace("/setup");
    } else if (
      isSignedIn &&
      isReady &&
      accessStatus === "ready" &&
      username &&
      !isSentrySmokeRoute &&
      (isSetupRoute || isAuthRoute)
    ) {
      router.replace("/(tabs)");
    }
  }, [
    accessStatus,
    isAuthRoute,
    isLoaded,
    isReady,
    isSentrySmokeRoute,
    isSetupRoute,
    isSignedIn,
    router,
    username,
  ]);

  if (!canRender) {
    return (
      <View
        accessibilityRole="progressbar"
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 24,
          backgroundColor: "#0d0d1a",
        }}
      >
        <ActivityIndicator color="#a5b4fc" />
        <Text style={{ color: "#c7d2fe", fontSize: 15 }}>
          {isLoaded
            ? `Preparing your ${PRODUCT_NAME} workspace…`
            : `Loading ${PRODUCT_NAME}…`}
        </Text>
      </View>
    );
  }
  if (!isSignedIn && !isAuthRoute) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 24,
          backgroundColor: "#0d0d1a",
        }}
      >
        <Text style={{ color: "#f8fafc", fontSize: 22, fontWeight: "700" }}>
          Sign in to continue
        </Text>
      <Text style={{ color: "#c7d2fe", textAlign: "center", lineHeight: 20, fontSize: 14 }}>
          Create an account or sign in to open {PRODUCT_NAME} rooms and sandboxes.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go to sign in"
          onPress={() => router.replace("/(auth)/sign-in" as never)}
          style={{
            borderRadius: 10,
            backgroundColor: "#6366f1",
            paddingHorizontal: 18,
            paddingVertical: 11,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700" }}>Go to sign in</Text>
        </Pressable>
      </View>
    );
  }
  if (isSignedIn && accessStatus !== "ready") {
    const blockedCopy =
      accessStatus === "banned"
        ? {
            title: "Account access blocked",
            description:
              `This ${PRODUCT_NAME} account has been banned. You cannot join rooms, calls, or sandboxes.`,
          }
        : {
            title: "Verify your email",
            description:
              `Verify your email address before entering the ${PRODUCT_NAME} workspace.`,
          };
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 24,
          backgroundColor: "#0d0d1a",
        }}
      >
        <Text style={{ color: "#f8fafc", fontSize: 22, fontWeight: "700" }}>
          {blockedCopy.title}
        </Text>
        <Text style={{ color: "#c7d2fe", textAlign: "center", lineHeight: 20, fontSize: 14 }}>
          {blockedCopy.description}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          onPress={() => void signOut()}
          style={{
            borderRadius: 10,
            backgroundColor: "#6366f1",
            paddingHorizontal: 18,
            paddingVertical: 11,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700" }}>Sign out</Text>
        </Pressable>
      </View>
    );
  }
  if (isSignedIn && !username && !isSetupRoute) {
    return (
      <View
        accessibilityRole="progressbar"
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 24,
          backgroundColor: "#0d0d1a",
        }}
      >
        <ActivityIndicator color="#a5b4fc" />
        <Text style={{ color: "#c7d2fe", fontSize: 15 }}>
          Setting up your {PRODUCT_NAME} account…
        </Text>
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
       <Stack.Screen name="(auth)" />
       <Stack.Screen name="setup" options={{ gestureEnabled: !!username }} />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="new-room" options={{ presentation: "modal" }} />
      <Stack.Screen name="room/[roomId]" />
      <Stack.Screen
        name="call/[roomId]"
        options={{ presentation: "fullScreenModal" }}
      />
      <Stack.Screen
        name="sandbox/[roomId]"
        options={{ presentation: "modal" }}
      />
    </Stack>
  );
}

function RootLayoutNav() {
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <RootLayoutContent />
      </View>
      <AppFooter />
    </View>
  );
}

function ClerkConfigurationScreen({ message }: { message: string }) {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 28,
        backgroundColor: "#0d0d1a",
      }}
    >
      <Text
        accessibilityRole="header"
        {...{ role: "heading", "aria-level": 1 }}
        style={{ color: "#f8fafc", fontSize: 24, fontWeight: "700", textAlign: "center" }}
      >
        Authentication setup needed
      </Text>
      <Text
        accessibilityRole="alert"
        style={{ color: "#c7d2fe", fontSize: 15, lineHeight: 22, textAlign: "center" }}
      >
        {message}
      </Text>
    </View>
  );
}

function AuthTokenBridge({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();

  useEffect(() => {
    setAuthTokenGetter(() => getToken());
    return () => setAuthTokenGetter(null);
  }, [getToken]);

  return <CryptoProvider>{children}</CryptoProvider>;
}

function RootLayout() {
  const clerkConfiguration = getClerkConfiguration();
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      // SplashScreen hidden by RootLayoutNav once app context is ready
    }
  }, [fontsLoaded, fontError]);

  // Every palette is dark, so the system bars must always use light content.
  // Android draws its status and navigation bars over the app (edge-to-edge)
  // and would otherwise follow the device theme, hiding dark icons on the dark
  // background. Declared once here; no screen overrides it.
  const statusBar = <StatusBar style="light" />;

  if (clerkConfiguration.status !== "ready") {
    return (
      <>
        {statusBar}
        <ClerkConfigurationScreen message={clerkConfiguration.message} />
      </>
    );
  }

  return (
    <>
      {statusBar}
      <ClerkProvider
        publishableKey={clerkConfiguration.publishableKey}
        tokenCache={clerkTokenCache}
      >
        <ClerkLoaded>
          <SafeAreaProvider>
            <AccessibilityProvider>
              <ErrorBoundary>
                <QueryClientProvider client={queryClient}>
                  <AuthTokenBridge>
                    <AppProvider>
                      <SocketProvider>
                        <GestureHandlerRootView style={{ flex: 1 }}>
                          <KeyboardProvider>
                            <RootLayoutNav />
                          </KeyboardProvider>
                        </GestureHandlerRootView>
                      </SocketProvider>
                    </AppProvider>
                  </AuthTokenBridge>
                </QueryClientProvider>
              </ErrorBoundary>
            </AccessibilityProvider>
          </SafeAreaProvider>
        </ClerkLoaded>
      </ClerkProvider>
    </>
  );
}

export default sentryEnabled ? Sentry.wrap(RootLayout) : RootLayout;
