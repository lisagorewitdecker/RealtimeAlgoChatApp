import { useAuth } from "@clerk/expo";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AVATAR_EMOJIS,
  DEFAULT_AVATAR_EMOJI,
  type AvatarEmoji,
} from "@/constants/avatarEmojis";

interface AppContextValue {
  userId: string;
  username: string;
  avatarEmoji: AvatarEmoji;
  isAdmin: boolean;
  setUsername: (name: string) => Promise<void>;
  setAvatarEmoji: (emoji: AvatarEmoji) => Promise<void>;
  isReady: boolean;
  accessStatus: "loading" | "ready" | "banned" | "unverified";
  setAccessStatus: (
    status: "loading" | "ready" | "banned" | "unverified",
  ) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId: clerkUserId } = useAuth();
  const getTokenRef = useRef(getToken);
  const [userId, setUserId] = useState("");
  const [username, setUsernameState] = useState("");
  const [avatarEmoji, setAvatarEmojiState] = useState<AvatarEmoji>(DEFAULT_AVATAR_EMOJI);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [accessStatus, setAccessStatus] = useState<
    "loading" | "ready" | "banned" | "unverified"
  >("loading");

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isLoaded) {
        setIsReady(false);
        return;
      }
      if (!isSignedIn || !clerkUserId) {
        if (!cancelled) {
          setUserId("");
          setUsernameState("");
          setAvatarEmojiState(DEFAULT_AVATAR_EMOJI);
          setIsAdmin(false);
          setAccessStatus("ready");
          setIsReady(true);
        }
        return;
      }

      setIsReady(false);
      setUserId("");
      setUsernameState("");
      setAvatarEmojiState(DEFAULT_AVATAR_EMOJI);

      try {
        const token = await getTokenRef.current();
        const domain = process.env["EXPO_PUBLIC_DOMAIN"];
        const response = await fetch(
          `${domain ? `https://${domain}` : "http://localhost:5000"}/api/profile`,
          {
            cache: "no-store",
            headers: {
              Authorization: `Bearer ${token ?? ""}`,
              "Cache-Control": "no-cache",
            },
          },
        );
        if (!response.ok) {
          const error = (await response.json().catch(() => null)) as {
            code?: string;
          } | null;
          if (!cancelled && error?.code === "BANNED") {
            setAccessStatus("banned");
            setUserId(clerkUserId);
            setUsernameState("");
            setAvatarEmojiState(DEFAULT_AVATAR_EMOJI);
            setIsAdmin(false);
            setIsReady(true);
            return;
          }
          if (!cancelled && error?.code === "EMAIL_UNVERIFIED") {
            setAccessStatus("unverified");
            setUserId(clerkUserId);
            setUsernameState("");
            setAvatarEmojiState(DEFAULT_AVATAR_EMOJI);
            setIsAdmin(false);
            setIsReady(true);
            return;
          }
          throw new Error("Unable to load your account profile.");
        }
        const data = (await response.json()) as {
          profile: { username: string; avatarEmoji: AvatarEmoji };
          isAdmin?: boolean;
        };
        const savedAvatarEmoji = AVATAR_EMOJIS.includes(data.profile.avatarEmoji)
          ? data.profile.avatarEmoji
          : DEFAULT_AVATAR_EMOJI;
        if (!cancelled) {
          setUserId(clerkUserId);
          setUsernameState(data.profile.username);
          setAvatarEmojiState(savedAvatarEmoji);
          setIsAdmin(data.isAdmin === true);
          setAccessStatus("ready");
          setIsReady(true);
        }
      } catch {
        if (!cancelled) {
          setUserId(clerkUserId);
          setUsernameState("");
          setAvatarEmojiState(DEFAULT_AVATAR_EMOJI);
          setIsAdmin(false);
          setAccessStatus("ready");
          setIsReady(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [clerkUserId, isLoaded, isSignedIn]);

  const setUsername = useCallback(async (name: string) => {
    if (!clerkUserId) throw new Error("You must be signed in to update your profile.");
    const profile = await saveProfile({ username: name });
    setUsernameState(profile.username);
    setAvatarEmojiState(profile.avatarEmoji);
  }, [clerkUserId, getToken]);

  const setAvatarEmoji = useCallback(async (emoji: AvatarEmoji) => {
    if (!clerkUserId) throw new Error("You must be signed in to update your profile.");
    const profile = await saveProfile({ avatarEmoji: emoji });
    setUsernameState(profile.username);
    setAvatarEmojiState(profile.avatarEmoji);
  }, [clerkUserId, getToken]);

  async function saveProfile(update: Partial<{
    username: string;
    avatarEmoji: AvatarEmoji;
  }>) {
    const token = await getToken();
    const domain = process.env["EXPO_PUBLIC_DOMAIN"];
    const response = await fetch(
      `${domain ? `https://${domain}` : "http://localhost:5000"}/api/profile`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(update),
      },
    );
    if (!response.ok) throw new Error("Unable to save your profile.");
    const data = (await response.json()) as {
      profile: { username: string; avatarEmoji: AvatarEmoji };
    };
    return data.profile;
  }

  return (
    <AppContext.Provider
      value={{
        userId,
        username,
        avatarEmoji,
        isAdmin,
        setUsername,
        setAvatarEmoji,
        isReady,
        accessStatus,
        setAccessStatus,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
