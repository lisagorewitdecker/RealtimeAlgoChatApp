import type { Event } from "@sentry/react-native";
import {
  SENTRY_FILTERED,
  scrubSensitiveText,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from "@/lib/sentryScrub";

const ROOM_CAPABILITY = "eyJyb29tSWQiOiJyb29tLTEifQ.c2lnbmF0dXJl";

describe("mobile Sentry credential scrubbing", () => {
  it("removes credential headers case-insensitively and drops request cookies", () => {
    const event = scrubSentryEvent({
      request: {
        url: "https://api.example.test/api/rooms/call?roomId=room-1",
        headers: {
          Authorization: "Bearer clerk-session-jwt",
          "PROXY-AUTHORIZATION": "Basic c2VjcmV0",
          cookie: "__session=clerk-session-jwt; theme=dark",
          "Set-Cookie": "__client=refresh; HttpOnly",
          "User-Agent": "Expo/1",
        },
        cookies: { __session: "clerk-session-jwt" },
      },
    } satisfies Event);

    expect(event.request?.headers).toEqual({
      Authorization: SENTRY_FILTERED,
      "PROXY-AUTHORIZATION": SENTRY_FILTERED,
      cookie: SENTRY_FILTERED,
      "Set-Cookie": SENTRY_FILTERED,
      "User-Agent": "Expo/1",
    });
    expect(event.request).not.toHaveProperty("cookies");
    expect(event.request?.url).toBe(
      "https://api.example.test/api/rooms/call?roomId=room-1",
    );
  });

  it.each([
    "token",
    "capability",
    "__session",
    "__session_Abc123",
    "__clerk_db_jwt",
    "__clerk_handshake",
    "__clerk_testing_token",
  ])("filters the %s parameter in URLs and query strings", (name) => {
    const event = scrubSentryEvent({
      request: {
        url: `https://api.example.test/api/socket.io/?EIO=4&${name}=${ROOM_CAPABILITY}&transport=polling`,
        query_string: `EIO=4&${name}=${ROOM_CAPABILITY}`,
      },
    } satisfies Event);

    expect(event.request?.url).toBe(
      `https://api.example.test/api/socket.io/?EIO=4&${name}=${SENTRY_FILTERED}&transport=polling`,
    );
    expect(event.request?.query_string).toBe(
      `EIO=4&${name}=${SENTRY_FILTERED}`,
    );
  });

  it("filters structured query strings by parameter name", () => {
    const pairs = scrubSentryEvent({
      request: {
        query_string: [
          ["roomId", "room-1"],
          ["Token", ROOM_CAPABILITY],
        ],
      },
    } satisfies Event);
    const record = scrubSentryEvent({
      request: { query_string: { roomId: "room-1", capability: ROOM_CAPABILITY } },
    } satisfies Event);

    expect(pairs.request?.query_string).toEqual([
      ["roomId", "room-1"],
      ["Token", SENTRY_FILTERED],
    ]);
    expect(record.request?.query_string).toEqual({
      roomId: "room-1",
      capability: SENTRY_FILTERED,
    });
  });

  it("scrubs bearer tokens and token parameters from messages and exceptions", () => {
    const event = scrubSentryEvent({
      message: "fetch failed: Authorization: Bearer abc.def.ghi",
      exception: {
        values: [
          {
            type: "Error",
            value: `GET /api/rooms/sandbox?roomId=r&token=${ROOM_CAPABILITY} failed`,
          },
        ],
      },
    } satisfies Event);

    expect(event.message).toBe(
      `fetch failed: Authorization: Bearer ${SENTRY_FILTERED}`,
    );
    expect(event.exception?.values?.[0]?.value).toBe(
      `GET /api/rooms/sandbox?roomId=r&token=${SENTRY_FILTERED} failed`,
    );
  });

  it("scrubs breadcrumbs attached to the event and nested data by key", () => {
    const event = scrubSentryEvent({
      breadcrumbs: [
        {
          category: "http",
          data: {
            url: `https://api.example.test/api/rooms/call?token=${ROOM_CAPABILITY}`,
            auth: { token: ROOM_CAPABILITY },
            status_code: 200,
          },
        },
      ],
    } satisfies Event);

    expect(event.breadcrumbs?.[0]?.data).toEqual({
      url: `https://api.example.test/api/rooms/call?token=${SENTRY_FILTERED}`,
      auth: { token: SENTRY_FILTERED },
      status_code: 200,
    });
  });

  it("scrubs a standalone breadcrumb's message and headers", () => {
    const breadcrumb = scrubSentryBreadcrumb({
      message: `socket handshake __clerk_db_jwt=dev-browser-jwt`,
      data: { headers: { Cookie: "__session=jwt" } },
    });

    expect(breadcrumb).toEqual({
      message: `socket handshake __clerk_db_jwt=${SENTRY_FILTERED}`,
      data: { headers: { Cookie: SENTRY_FILTERED } },
    });
  });

  it("scrubs credentials inside arrays and filters containers beyond the depth limit", () => {
    const breadcrumb = scrubSentryBreadcrumb({
      data: {
        arguments: [
          { token: ROOM_CAPABILITY, roomId: "room-1" },
          `GET /api/rooms/call?token=${ROOM_CAPABILITY}`,
          3,
        ],
        a: { b: { c: { d: { e: { token: ROOM_CAPABILITY } } } } },
      },
    });

    expect(breadcrumb.data).toEqual({
      arguments: [
        { token: SENTRY_FILTERED, roomId: "room-1" },
        `GET /api/rooms/call?token=${SENTRY_FILTERED}`,
        3,
      ],
      a: { b: { c: { d: { e: SENTRY_FILTERED } } } },
    });
  });

  it("drops request bodies and scrubs extra and contexts", () => {
    const event = scrubSentryEvent({
      request: {
        url: "https://api.example.test/api/profile",
        data: { capability: ROOM_CAPABILITY },
      },
      extra: { auth: { token: ROOM_CAPABILITY }, note: "ok" },
      contexts: {
        session: { __session: ROOM_CAPABILITY },
        app: { app_name: "chat-app" },
      },
    } satisfies Event);

    expect(event.request).not.toHaveProperty("data");
    expect(event.extra).toEqual({ auth: { token: SENTRY_FILTERED }, note: "ok" });
    expect(event.contexts).toEqual({
      session: { __session: SENTRY_FILTERED },
      app: { app_name: "chat-app" },
    });
  });

  it("leaves unrelated parameters that merely contain a sensitive word alone", () => {
    expect(scrubSensitiveText("?tokenizer=on&roomId=token-room")).toBe(
      "?tokenizer=on&roomId=token-room",
    );
  });
});
