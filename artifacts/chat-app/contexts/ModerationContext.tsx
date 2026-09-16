/**
 * ModerationContext — provides moderator/admin status and mod actions.
 *
 * isModerator: true when the current user is the room creator.
 * isAdmin:     true when the API has confirmed the current account is an
 * administrator. The client never receives the full administrator list.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useState,
} from "react";
import { Alert } from "react-native";
import { useAuth } from "@clerk/expo";
import { useApp } from "./AppContext";

interface ModerationContextValue {
  isModerator: boolean;
  isAdmin: boolean;
  moderatorId: string | null; // room creator's userId
  setRoomCreator: (creatorId: string) => void;
  deleteMessage: (roomId: string, messageId: string) => Promise<boolean>;
  kickUser: (roomId: string, targetUserId: string, username: string) => Promise<boolean>;
  banUser: (
    roomId: string,
    targetUserId: string,
    username: string,
  ) => Promise<boolean>;
}

const ModerationContext = createContext<ModerationContextValue | null>(null);

async function modFetch(
  path: string,
  method: string,
  body: Record<string, unknown>,
  getToken: () => Promise<string | null>,
): Promise<boolean> {
  try {
    const token = await getToken();
    const domain = process.env["EXPO_PUBLIC_DOMAIN"];
    const base = domain ? `https://${domain}` : "http://localhost:5000";
    const res = await fetch(`${base}/api/moderation/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function ModerationProvider({ children }: { children: React.ReactNode }) {
  const { userId, isAdmin } = useApp();
  const { getToken } = useAuth();
  const [moderatorId, setModeratorId] = useState<string | null>(null);

  const isModerator = isAdmin || moderatorId === userId;

  const setRoomCreator = useCallback((creatorId: string) => {
    setModeratorId(creatorId);
  }, []);

  const deleteMessage = useCallback(
    async (roomId: string, messageId: string): Promise<boolean> => {
      return modFetch(
        `${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
        "DELETE",
        {},
        getToken,
      );
    },
    [getToken],
  );

  const kickUser = useCallback(
    async (roomId: string, targetUserId: string, username: string): Promise<boolean> => {
      return new Promise((resolve) => {
        Alert.alert(
          "Remove user",
          `Remove ${username} from this room?`,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            {
              text: "Remove",
              style: "destructive",
              onPress: async () => {
                const ok = await modFetch(
                  `${encodeURIComponent(roomId)}/kick`,
                  "POST",
                  { userId: targetUserId },
                  getToken,
                );
                resolve(ok);
              },
            },
          ],
        );
      });
    },
    [getToken],
  );

  const banUser = useCallback(
    async (
      roomId: string,
      targetUserId: string,
      username: string,
    ): Promise<boolean> => {
      const label = isAdmin ? "Permanently ban" : "Ban for 24 hours";
      return new Promise((resolve) => {
        Alert.alert(
          "Ban user",
          `${label} ${username}? They will be removed from this room.`,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            {
              text: label,
              style: "destructive",
              onPress: async () => {
                const ok = await modFetch(
                  `${encodeURIComponent(roomId)}/ban`,
                  "POST",
                  { userId: targetUserId },
                  getToken,
                );
                resolve(ok);
              },
            },
          ],
        );
      });
    },
    [getToken, isAdmin],
  );

  return (
    <ModerationContext.Provider
      value={{
        isModerator,
        isAdmin,
        moderatorId,
        setRoomCreator,
        deleteMessage,
        kickUser,
        banUser,
      }}
    >
      {children}
    </ModerationContext.Provider>
  );
}

export function useModeration(): ModerationContextValue {
  const ctx = useContext(ModerationContext);
  if (!ctx) throw new Error("useModeration must be inside ModerationProvider");
  return ctx;
}
