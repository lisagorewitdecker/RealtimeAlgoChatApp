import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { useCrypto } from "@/contexts/CryptoContext";
import { ScaledText as Text } from "@/components/ScaledText";
import { useColors } from "@/hooks/useColors";

type CallControlBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CallLayoutReport = {
  type: "call-layout";
  viewport: { width: number; height: number };
  controls: CallControlBounds[];
};

const CALL_LAYOUT_PROBE = `
(() => {
  const report = () => {
    const ids = ["muteBtn", "cameraBtn", "endBtn"];
    const controls = ids.map((id) => {
      const rect = document.getElementById(id)?.getBoundingClientRect();
      return rect
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null;
    });
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: "call-layout",
      viewport: { width: window.innerWidth, height: window.innerHeight },
      controls,
    }));
  };
  report();
  window.addEventListener("resize", report);
})();
true;
`;

function callControlsFitViewport(report: CallLayoutReport): boolean {
  const { width, height } = report.viewport;
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    report.controls.length === 3 &&
    report.controls.every((control) => {
      if (
        !control ||
        ![control.x, control.y, control.width, control.height].every(Number.isFinite)
      ) {
        return false;
      }
      return (
        control.x >= 0 &&
        control.y >= 0 &&
        control.width >= 44 &&
        control.height >= 44 &&
        control.x + control.width <= width + 0.5 &&
        control.y + control.height <= height + 0.5
      );
    })
  );
}

export default function CallScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ roomId: string; roomName?: string }>();
  const roomId = params.roomId ?? "";
  const roomName = params.roomName ?? roomId;
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { roomKeyPersistenceFailures, retryRoomKeyPersistence } = useCrypto();
  const webViewRef = useRef<WebView<unknown>>(null);
  const [token, setToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [retryingRoomKey, setRetryingRoomKey] = useState(false);
  const [callControlsFit, setCallControlsFit] = useState<boolean | null>(null);
  const roomKeyPersistenceFailure = roomKeyPersistenceFailures.get(roomId);

  const domain = process.env["EXPO_PUBLIC_DOMAIN"];
  const base = domain ? `https://${domain}` : "http://localhost:5000";
  const url = `${base}/api/rooms/call?roomId=${encodeURIComponent(roomId)}${
    params.roomName ? `&roomName=${encodeURIComponent(params.roomName)}` : ""
  }`;

  useEffect(() => {
    if (roomKeyPersistenceFailure) {
      setToken(null);
      setAuthError(null);
      return;
    }
    if (!isLoaded) return;

    if (!isSignedIn) {
      setAuthError("You need to sign in before joining a call.");
      return;
    }

    let isMounted = true;
    getToken()
      .then((nextToken) => {
        if (!isMounted) return;
        if (nextToken) {
          setToken(nextToken);
        } else {
          setAuthError("Your signed-in session could not be verified. Please sign in again.");
        }
      })
      .catch(() => {
        if (isMounted) {
          setAuthError("Your signed-in session could not be verified. Please sign in again.");
        }
      });

    return () => {
      isMounted = false;
    };
  }, [getToken, isLoaded, isSignedIn, roomKeyPersistenceFailure]);

  async function retrySavingRoomKey() {
    setRetryingRoomKey(true);
    try {
      await retryRoomKeyPersistence(roomId);
    } finally {
      setRetryingRoomKey(false);
    }
  }

  function onMessage(event: { nativeEvent: { data: string } }) {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as
        | { type?: string }
        | CallLayoutReport;
      if (msg.type === "end-call") router.back();
      if (msg.type === "call-layout") {
        setCallControlsFit(callControlsFitViewport(msg as CallLayoutReport));
      }
    } catch {
      // Ignore malformed bridge messages from the embedded call page.
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.topBar,
          { paddingTop: (Platform.OS === "web" ? 67 : insets.top) + 8 },
        ]}
      >
        <TouchableOpacity
          testID="call-dismiss-button"
          accessibilityRole="button"
          accessibilityLabel="Close call"
          onPress={() => router.back()}
          hitSlop={12}
        >
          <Feather name="chevron-down" size={26} color={colors.secondaryForeground} />
        </TouchableOpacity>
        <Text style={[styles.roomName, { color: colors.foreground }]}>
          {roomName}
        </Text>
        <View
          testID="call-surface-layout-status"
          accessible
          accessibilityLabel={
            callControlsFit === true
              ? "Embedded call controls fit the viewport"
              : callControlsFit === false
                ? "Embedded call controls overflow the viewport"
                : "Checking embedded call controls"
          }
          style={styles.layoutStatus}
        />
        <View style={{ width: 26 }} />
      </View>

      {roomKeyPersistenceFailure ? (
        <View
          testID="call-room-key-storage-block"
          accessibilityRole="alert"
          style={[styles.loading, { backgroundColor: colors.background }]}
        >
          <Feather name="alert-triangle" size={32} color={colors.destructive} />
          <Text style={[styles.blockedTitle, { color: colors.foreground }]}>
            Call blocked until the room key is saved
          </Text>
          <Text style={[styles.authError, { color: colors.mutedForeground }]}>
            Keep this screen open, make secure storage available, and retry before
            joining the call.
          </Text>
          <TouchableOpacity
            testID="retry-call-room-key-save-button"
            accessibilityRole="button"
            disabled={retryingRoomKey}
            onPress={() => void retrySavingRoomKey()}
            style={[styles.retryButton, { borderColor: colors.destructive }]}
          >
            <Text style={{ color: colors.destructive, fontSize: 14, fontWeight: "700" }}>
              {retryingRoomKey ? "Retrying…" : "Retry saving key"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : !isLoaded || (isSignedIn && !token && !authError) ? (
        <View style={[styles.loading, { backgroundColor: colors.background }]}>
          <Text style={{ color: colors.secondaryForeground, fontSize: 14 }}>
            Confirming your signed-in session…
          </Text>
        </View>
      ) : authError ? (
        <View style={[styles.loading, { backgroundColor: colors.background }]}>
          <Feather name="alert-circle" size={32} color={colors.mutedForeground} />
          <Text style={[styles.authError, { color: colors.secondaryForeground }]}>
            {authError}
          </Text>
        </View>
      ) : Platform.OS === "web" ? (
        <View style={styles.webFallback}>
          <Feather name="video-off" size={48} color={colors.mutedForeground} />
          <Text style={[styles.webFallbackTitle, { color: colors.foreground }]}>Video calls</Text>
          <Text style={[styles.webFallbackText, { color: colors.mutedForeground }]}>
            Open this app on a mobile device to use video and audio calls.
          </Text>
        </View>
      ) : (
        <WebView<unknown>
          ref={webViewRef}
          testID="call-webview"
          accessibilityLabel="Embedded call controls"
          source={{
            uri: url,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }}
          style={[styles.webview, { backgroundColor: colors.background }]}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          javaScriptEnabled
          domStorageEnabled
          onMessage={onMessage}
          injectedJavaScript={CALL_LAYOUT_PROBE}
          startInLoadingState
          renderLoading={() => (
            <View style={[styles.loading, { backgroundColor: colors.background }]}>
              <Text style={{ color: colors.secondaryForeground, fontSize: 14 }}>Joining call…</Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingBottom: 10,
  },
  roomName: { fontSize: 16, fontWeight: "600" as const, flex: 1, textAlign: "center" },
  layoutStatus: { width: 1, height: 1 },
  webview: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  authError: { maxWidth: 280, textAlign: "center", lineHeight: 20, fontSize: 14 },
  blockedTitle: {
    fontSize: 19, fontWeight: "700" as const, marginBottom: 8, marginTop: 16,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: 10, borderWidth: 1, marginTop: 20,
    paddingHorizontal: 16, paddingVertical: 11,
  },
  webFallback: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 40 },
  webFallbackTitle: { fontSize: 20, fontWeight: "700" as const },
  webFallbackText: { fontSize: 14, textAlign: "center", lineHeight: 20 },
});
