import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";

const SOCKET_REVOCATION_CHANNEL = "realtimealgo_socket_revocations";
const RECONNECT_DELAY_MS = 1_000;
const instanceId = randomUUID();

export type SocketRevocation =
  | { type: "account-ban"; userId: string }
  | {
      type: "room-revocation";
      roomId: string;
      userId: string;
      banned: boolean;
    };

type PublishedSocketRevocation = SocketRevocation & { source: string };
type Notification = { channel?: string; payload?: string };

interface RevocationClient {
  query(queryText: string): Promise<unknown>;
  on(event: "notification", listener: (notification: Notification) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeListener(
    event: "notification",
    listener: (notification: Notification) => void,
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  release(error?: Error): void;
}

export async function publishSocketRevocation(
  revocation: SocketRevocation,
): Promise<void> {
  await pool.query("SELECT pg_notify($1, $2)", [
    SOCKET_REVOCATION_CHANNEL,
    JSON.stringify({ ...revocation, source: instanceId }),
  ]);
}

export function startSocketRevocationListener(
  onRevocation: (revocation: SocketRevocation) => void,
  onUnavailable: (error: Error) => void,
): {
  waitUntilReady(): Promise<void>;
  close(): void;
} {
  let client: RevocationClient | undefined;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let ready = false;
  let removeClientListeners: (() => void) | undefined;
  let resolveReady: (() => void) | undefined;
  let readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, RECONNECT_DELAY_MS);
    reconnectTimer.unref();
  };

  const connect = async () => {
    if (closed || client) return;
    let nextClient: RevocationClient | undefined;
    try {
      nextClient = await acquireClient();
      await nextClient.query(`LISTEN ${SOCKET_REVOCATION_CHANNEL}`);
      if (closed) {
        nextClient.release();
        return;
      }

      client = nextClient;
      ready = true;
      resolveReady?.();
      const onNotification = (notification: Notification) => {
        if (
          notification.channel !== SOCKET_REVOCATION_CHANNEL ||
          !notification.payload
        ) {
          return;
        }
        try {
          const event = JSON.parse(
            notification.payload,
          ) as Partial<PublishedSocketRevocation>;
          if (
            event.source === instanceId ||
            typeof event.source !== "string" ||
            !isSocketRevocation(event)
          ) {
            return;
          }
          onRevocation(
            event.type === "account-ban"
              ? { type: event.type, userId: event.userId }
              : {
                  type: event.type,
                  roomId: event.roomId,
                  userId: event.userId,
                  banned: event.banned,
                },
          );
        } catch (error) {
          logger.warn({ err: error }, "Ignoring malformed socket revocation");
        }
      };
      const onClientError = (error: Error) => {
        if (client !== nextClient) return;
        client = undefined;
        ready = false;
        removeClientListeners?.();
        removeClientListeners = undefined;
        readyPromise = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
        onUnavailable(error);
        nextClient?.release(error);
        scheduleReconnect();
      };
      nextClient.on("notification", onNotification);
      nextClient.on("error", onClientError);
      removeClientListeners = () => {
        nextClient?.removeListener("notification", onNotification);
        nextClient?.removeListener("error", onClientError);
      };
    } catch (error) {
      nextClient?.release(error instanceof Error ? error : undefined);
      logger.error({ err: error }, "Socket revocation listener could not connect");
      scheduleReconnect();
    }
  };

  void connect();

  return {
    waitUntilReady() {
      return ready ? Promise.resolve() : readyPromise;
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const activeClient = client;
      client = undefined;
      ready = false;
      if (activeClient) {
        removeClientListeners?.();
        removeClientListeners = undefined;
        activeClient.release();
      }
    },
  };
}

function acquireClient(): Promise<RevocationClient> {
  return new Promise((resolve, reject) => {
    pool.connect((error, connectedClient) => {
      if (error || !connectedClient) {
        reject(error ?? new Error("PostgreSQL did not provide a listener client."));
        return;
      }
      resolve(connectedClient as unknown as RevocationClient);
    });
  });
}

function isSocketRevocation(
  event: Partial<PublishedSocketRevocation>,
): event is PublishedSocketRevocation {
  if (event.type === "account-ban") {
    return typeof event.userId === "string" && event.userId.length > 0;
  }
  return (
    event.type === "room-revocation" &&
    typeof event.roomId === "string" &&
    event.roomId.length > 0 &&
    typeof event.userId === "string" &&
    event.userId.length > 0 &&
    typeof event.banned === "boolean"
  );
}
