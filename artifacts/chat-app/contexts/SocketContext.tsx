import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { useAuth } from "@clerk/expo";
import { io, Socket } from "socket.io-client";
import { useApp } from "./AppContext";

interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  connectionError: string | null;
}

const SocketContext = createContext<SocketContextValue>({
  socket: null,
  isConnected: false,
  connectionError: null,
});

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { isSignedIn, getToken } = useAuth();
  const { username, avatarEmoji, setAccessStatus } = useApp();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const getTokenRef = React.useRef(getToken);

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    if (!isSignedIn || !username) {
      setSocket(null);
      setIsConnected(false);
      setConnectionError(null);
      return;
    }
    const domain = process.env["EXPO_PUBLIC_DOMAIN"];
    const url = domain ? `https://${domain}` : "http://localhost:5000";

    const s = io(url, {
      path: "/api/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 15,
      reconnectionDelay: 1500,
      auth: async (callback) => {
        try {
          callback({ token: await getTokenRef.current() });
        } catch {
          callback({ token: null });
        }
      },
    });

    s.on("connect", () => {
      setIsConnected(true);
      setConnectionError(null);
    });
    s.on("disconnect", () => setIsConnected(false));
    s.on("access-revoked", (payload: { reason?: string }) => {
      if (payload.reason === "banned") {
        setAccessStatus("banned");
      }
    });
    s.on("connect_error", (error) => {
      setIsConnected(false);
      setConnectionError(error.message || "Unable to connect to chat.");
    });
    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, [avatarEmoji, isSignedIn, setAccessStatus, username]);

  return (
    <SocketContext.Provider value={{ socket, isConnected, connectionError }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { useAuth } from "@clerk/expo";
import { io, Socket } from "socket.io-client";
import { useApp } from "./AppContext";

interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  connectionError: string | null;
}

const SocketContext = createContext<SocketContextValue>({
  socket: null,
  isConnected: false,
  connectionError: null,
});

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { isSignedIn, getToken } = useAuth();
  const { username, avatarEmoji, setAccessStatus } = useApp();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const getTokenRef = React.useRef(getToken);

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    if (!isSignedIn || !username) {
      setSocket(null);
      setIsConnected(false);
      setConnectionError(null);
      return;
    }
    const domain = process.env["EXPO_PUBLIC_DOMAIN"];
    const url = domain ? `https://${domain}` : "http://localhost:5000";

    const s = io(url, {
      path: "/api/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 15,
      reconnectionDelay: 1500,
      auth: async (callback) => {
        try {
          callback({ token: await getTokenRef.current() });
        } catch {
          callback({ token: null });
        }
      },
    });

    s.on("connect", () => {
      setIsConnected(true);
      setConnectionError(null);
    });
    s.on("disconnect", () => setIsConnected(false));
    s.on("access-revoked", (payload: { reason?: string }) => {
      if (payload.reason === "banned") {
        setAccessStatus("banned");
      }
    });
    s.on("connect_error", (error) => {
      setIsConnected(false);
      setConnectionError(error.message || "Unable to connect to chat.");
    });
    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, [avatarEmoji, isSignedIn, setAccessStatus, username]);

  return (
    <SocketContext.Provider value={{ socket, isConnected, connectionError }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { useAuth } from "@clerk/expo";
import { io, Socket } from "socket.io-client";
import { useApp } from "./AppContext";

interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  connectionError: string | null;
}

const SocketContext = createContext<SocketContextValue>({
  socket: null,
  isConnected: false,
  connectionError: null,
});

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { isSignedIn, getToken } = useAuth();
  const { username, avatarEmoji, setAccessStatus } = useApp();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const getTokenRef = React.useRef(getToken);

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    if (!isSignedIn || !username) {
      setSocket(null);
      setIsConnected(false);
      setConnectionError(null);
      return;
    }
    const domain = process.env["EXPO_PUBLIC_DOMAIN"];
    const url = domain ? `https://${domain}` : "http://localhost:5000";

    const s = io(url, {
      path: "/api/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 15,
      reconnectionDelay: 1500,
      auth: async (callback) => {
        try {
          callback({ token: await getTokenRef.current() });
        } catch {
          callback({ token: null });
        }
      },
    });

    s.on("connect", () => {
      setIsConnected(true);
      setConnectionError(null);
    });
    s.on("disconnect", () => setIsConnected(false));
    s.on("access-revoked", (payload: { reason?: string }) => {
      if (payload.reason === "banned") {
        setAccessStatus("banned");
      }
    });
    s.on("connect_error", (error) => {
      setIsConnected(false);
      setConnectionError(error.message || "Unable to connect to chat.");
    });
    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, [avatarEmoji, isSignedIn, setAccessStatus, username]);

  return (
    <SocketContext.Provider value={{ socket, isConnected, connectionError }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { useAuth } from "@clerk/expo";
import { io, Socket } from "socket.io-client";
import { useApp } from "./AppContext";

interface SocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  connectionError: string | null;
}

const SocketContext = createContext<SocketContextValue>({
  socket: null,
  isConnected: false,
  connectionError: null,
});

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { isSignedIn, getToken } = useAuth();
  const { username, avatarEmoji, setAccessStatus } = useApp();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const getTokenRef = React.useRef(getToken);

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    if (!isSignedIn || !username) {
      setSocket(null);
      setIsConnected(false);
      setConnectionError(null);
      return;
    }
    const domain = process.env["EXPO_PUBLIC_DOMAIN"];
    const url = domain ? `https://${domain}` : "http://localhost:5000";

    const s = io(url, {
      path: "/api/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 15,
      reconnectionDelay: 1500,
      auth: async (callback) => {
        try {
          callback({ token: await getTokenRef.current() });
        } catch {
          callback({ token: null });
        }
      },
    });

    s.on("connect", () => {
      setIsConnected(true);
      setConnectionError(null);
    });
    s.on("disconnect", () => setIsConnected(false));
    s.on("access-revoked", (payload: { reason?: string }) => {
      if (payload.reason === "banned") {
        setAccessStatus("banned");
      }
    });
    s.on("connect_error", (error) => {
      setIsConnected(false);
      setConnectionError(error.message || "Unable to connect to chat.");
    });
    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, [avatarEmoji, isSignedIn, setAccessStatus, username]);

  return (
    <SocketContext.Provider value={{ socket, isConnected, connectionError }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}
