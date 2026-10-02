import { useLocalSearchParams } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";

import { ScaledText as Text } from "@/components/ScaledText";
import {
  RELEASE_CRASH_REPORTING_BUILD_EVIDENCE,
  RELEASE_SENTRY_BUILD_ID,
  RELEASE_SENTRY_DIST,
  RELEASE_SENTRY_RELEASE,
} from "@/constants/releaseCrashReporting";
import { useColors } from "@/hooks/useColors";
import {
  captureNativeSourceMapProbe,
  captureRoomKeyPersistenceRetryFailure,
  Sentry,
  sentryEnabled,
} from "@/lib/sentry";

const RELEASE_EVIDENCE = "SENTRY_RELEASE_PREFLIGHT_PASSED_V1";
const MARKER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

type ProbeStatus = "blocked" | "sending" | "sent" | "failed";

export default function SentrySmokeScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{
    marker?: string | string[];
    buildId?: string | string[];
  }>();
  const marker = typeof params.marker === "string" ? params.marker : "";
  const candidateBuildId =
    typeof params.buildId === "string" ? params.buildId : "";
  const platform = Platform.OS;
  const started = useRef(false);
  const [status, setStatus] = useState<ProbeStatus>("sending");

  const canRun =
    String(RELEASE_CRASH_REPORTING_BUILD_EVIDENCE) === RELEASE_EVIDENCE &&
    Boolean(RELEASE_SENTRY_RELEASE) &&
    Boolean(RELEASE_SENTRY_DIST) &&
    candidateBuildId === RELEASE_SENTRY_BUILD_ID &&
    sentryEnabled &&
    (platform === "ios" || platform === "android") &&
    MARKER_PATTERN.test(marker) &&
    BUILD_ID_PATTERN.test(candidateBuildId);

  useEffect(() => {
    if (!canRun) {
      setStatus("blocked");
      return;
    }
    if (platform !== "ios" && platform !== "android") {
      setStatus("blocked");
      return;
    }
    if (started.current) return;
    started.current = true;

    const sendProbe = async () => {
      captureNativeSourceMapProbe({
        marker,
        platform,
        candidateBuildId,
      });
      try {
        await Promise.reject(new Error("Controlled room-key save retry rejection"));
      } catch {
        captureRoomKeyPersistenceRetryFailure("save", {
          marker,
          platform,
          candidateBuildId,
        });
      }
      const delivered = await Sentry.flush();
      setStatus(delivered ? "sent" : "failed");
    };

    void sendProbe().catch(() => setStatus("failed"));
  }, [canRun, candidateBuildId, marker, platform]);

  const copy: Record<ProbeStatus, string> = {
    blocked: "Source-map probe unavailable",
    sending: "Sending controlled crash report…",
    sent: "Controlled crash report sent",
    failed: "Controlled crash report failed",
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <Text
        accessibilityRole="header"
        aria-level={1}
        testID={`sentry-probe-${status}`}
        style={[styles.title, { color: colors.foreground }]}
      >
        {copy[status]}
      </Text>
      <Text style={[styles.copy, { color: colors.mutedForeground }]}>
        This diagnostic is available only to the native release runner.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  copy: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
});