import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Platform,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { useCrypto } from "@/contexts/CryptoContext";
import { encodeBase64 } from "tweetnacl-util";
import { ScaledText as Text } from "@/components/ScaledText";
import { useColors } from "@/hooks/useColors";

export function prepareWebSandboxHtml(
  html: string,
  apiBase: string,
  roomKeyB64 = "",
): string {
  const apiOrigin = JSON.stringify(apiBase);
  return html
    .replace(
      /(<script\s+src=["']\/api\/crypto-client\.js["']><\/script>)/i,
      `<script>window.__DEVSTUDIO_ROOM_KEY__=${JSON.stringify(roomKeyB64)}</script>$1`,
    )
    .replace(
      /(<script\s+src=["'])\/api\/crypto-client\.js(["'])/i,
      `$1${apiBase}/api/crypto-client.js$2`,
    )
    .replace(
      /(<script\s+src=["'])\/api\/socket-client\.js(["'])/i,
      `$1${apiBase}/api/socket-client.js$2`,
    )
    .replace(/io\(\{path:/g, `io(${apiOrigin},{path:`);
}

const webFrameStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  height: "100%",
  border: "none",
  backgroundColor: "#fff",
};

export default function SandboxScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ roomId: string; roomName?: string }>();
  const roomId = params.roomId ?? "";
  const roomName = params.roomName ?? roomId;
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const {
    getRoomKey,
    loadRoomKey,
    roomKeyPersistenceFailures,
    retryRoomKeyPersistence,
  } = useCrypto();
  const getTokenRef = React.useRef(getToken);
  const [token, setToken] = useState<string | null>(null);
  const [webSandboxHtml, setWebSandboxHtml] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [retryingRoomKey, setRetryingRoomKey] = useState(false);
  const [roomKeyB64, setRoomKeyB64] = useState<string | null>(null);
  const roomKeyPersistenceFailure = roomKeyPersistenceFailures.get(roomId);

  const domain = process.env["EXPO_PUBLIC_DOMAIN"];
  const base = domain ? `https://${domain}` : "http://localhost:5000";
  const url = `${base}/api/rooms/sandbox?roomId=${encodeURIComponent(roomId)}${
    params.roomName ? `&roomName=${encodeURIComponent(params.roomName)}` : ""
  }`;

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    let mounted = true;
    // Always settle: a rejected hydration must not leave the sandbox on its
    // loading state forever.
    void loadRoomKey(roomId)
      .catch((error: unknown) => {
        console.warn(
          "Room key hydration failed",
          error instanceof Error ? error.message : error,
        );
      })
      .then(() => {
        const key = getRoomKey(roomId);
        if (mounted) setRoomKeyB64(key ? encodeBase64(key) : "");
      });
    return () => {
      mounted = false;
    };
  }, [getRoomKey, loadRoomKey, roomId]);

  useEffect(() => {
    if (roomKeyPersistenceFailure) {
      setToken(null);
      setWebSandboxHtml(null);
      setAuthError(null);
      return;
    }
    if (!isLoaded || roomKeyB64 === null) return;

    if (!isSignedIn) {
      setAuthError("You need to sign in before opening the sandbox.");
      return;
    }
    if (!roomKeyB64) {
      setAuthError(
        "This device does not have the room encryption key. Reopen the room and wait for a member to share it.",
      );
      return;
    }

    let isMounted = true;
    getTokenRef.current()
      .then((nextToken) => {
        if (!isMounted) return;
        if (nextToken) {
          setToken(nextToken);
          if (Platform.OS === "web") {
            fetch(url, {
              headers: { Authorization: `Bearer ${nextToken}` },
            })
              .then((response) => {
                if (!response.ok) {
                  throw new Error("Unable to load the sandbox. Please try again.");
                }
                return response.text();
              })
              .then((html) => {
                if (isMounted) {
                  setWebSandboxHtml(prepareWebSandboxHtml(html, base, roomKeyB64));
                }
              })
              .catch((cause: unknown) => {
                if (isMounted) {
                  setAuthError(
                    cause instanceof Error
                      ? cause.message
                      : "Unable to load the sandbox. Please try again.",
                  );
                }
              });
          }
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
  }, [base, isLoaded, isSignedIn, roomKeyB64, roomKeyPersistenceFailure, url]);

  async function retrySavingRoomKey() {
    setRetryingRoomKey(true);
    try {
      await retryRoomKeyPersistence(roomId);
    } finally {
      setRetryingRoomKey(false);
    }
  }

  const topPad = (Platform.OS === "web" ? 67 : insets.top) + 8;

  return (
    <View style={[styles.root, { backgroundColor: "#0d0d1a" }]}>
      <View style={[styles.topBar, { paddingTop: topPad, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.titleArea}>
          <Feather name="code" size={16} color={colors.accent} />
          <Text style={[styles.roomName, { color: colors.foreground }]}>
            {roomName} — Sandbox
          </Text>
        </View>
        <View style={{ width: 22 }} />
      </View>

      {roomKeyPersistenceFailure ? (
        <View
          testID="sandbox-room-key-storage-block"
          accessibilityRole="alert"
          style={styles.loading}
        >
          <Feather name="alert-triangle" size={32} color={colors.destructive} />
          <Text style={[styles.blockedTitle, { color: colors.foreground }]}>
            {roomKeyPersistenceFailure.kind === "load"
              ? "Sandbox blocked until the room key can be read"
              : "Sandbox blocked until the room key is saved"}
          </Text>
          <Text style={[styles.authError, { color: colors.mutedForeground }]}>
            {roomKeyPersistenceFailure.kind === "load"
              ? "This device could not read its saved encryption keys. Make secure storage available, then retry before opening the shared sandbox."
              : "Keep this screen open, make secure storage available, and retry before opening the shared sandbox."}
          </Text>
          <TouchableOpacity
            testID="retry-sandbox-room-key-save-button"
            accessibilityRole="button"
            disabled={retryingRoomKey}
            onPress={() => void retrySavingRoomKey()}
            style={[styles.retryButton, { borderColor: colors.destructive }]}
          >
            <Text style={{ color: colors.destructive, fontSize: 14, fontWeight: "700" }}>
              {retryingRoomKey
                ? "Retrying…"
                : roomKeyPersistenceFailure.kind === "load"
                  ? "Retry reading key"
                  : "Retry saving key"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : !isLoaded ||
      (isSignedIn && !token && !authError) ||
      (Platform.OS === "web" && isSignedIn && !webSandboxHtml && !authError) ? (
        <View style={styles.loading}>
          <Text style={{ color: "#a5b4fc", fontSize: 14 }}>Confirming your signed-in session…</Text>
        </View>
      ) : authError ? (
        <View style={styles.loading}>
          <Feather name="alert-circle" size={32} color="#a5b4fc" />
          <Text style={styles.authError}>{authError}</Text>
        </View>
      ) : Platform.OS === "web" ? (
        React.createElement("iframe", {
          title: `${roomName} sandbox`,
          srcDoc: webSandboxHtml ?? "",
          style: webFrameStyle,
        })
      ) : (
        <WebView
          source={{
            uri: url,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }}
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          injectedJavaScriptBeforeContentLoaded={`window.__DEVSTUDIO_ROOM_KEY__=${JSON.stringify(
            roomKeyB64 ?? "",
          )};true;`}
          allowsInlineMediaPlayback={false}
          startInLoadingState
          renderLoading={() => (
            <View style={[styles.loading, { backgroundColor: "#0d0d1a" }]}>
              <Text style={{ color: "#a5b4fc", fontSize: 14 }}>Loading sandbox…</Text>
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
    paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, gap: 12,
  },
  titleArea: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  roomName: { fontSize: 15, fontWeight: "600" as const },
  webview: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  authError: { color: "#a5b4fc", maxWidth: 280, textAlign: "center", lineHeight: 20, fontSize: 14 },
  blockedTitle: {
    fontSize: 19, fontWeight: "700" as const, marginBottom: 8, marginTop: 16,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: 10, borderWidth: 1, marginTop: 20,
    paddingHorizontal: 16, paddingVertical: 11,
  },
});
