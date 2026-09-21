import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  customFetch,
  ResponseParseError,
  setAuthTokenGetter,
  setBaseUrl,
} from "./custom-fetch";

const jsonHeaders = { "content-type": "application/json" };

function reactNativeResponse(
  body: string,
  init: ResponseInit = {},
): Response {
  const response = new Response(body, {
    headers: jsonHeaders,
    ...init,
  });

  // React Native does not implement ReadableStream-backed response bodies.
  Object.defineProperty(response, "body", {
    configurable: true,
    value: undefined,
  });

  return response;
}

function responseWithoutBlob(response: Response): Response {
  Object.defineProperty(response, "blob", {
    configurable: true,
    value: undefined,
  });
  return response;
}

function installFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  setBaseUrl(null);
  setAuthTokenGetter(null);
  vi.unstubAllGlobals();
});

describe("customFetch URL handling", () => {
  it("accepts URL-like React Native polyfill values and joins relative paths", async () => {
    setBaseUrl("https://api.example.test/root///");
    const fetchMock = installFetch(reactNativeResponse("ok"));
    const polyfilledUrl = {
      href: "/rooms",
      toString: () => "/rooms",
    } as unknown as URL;

    await expect(
      customFetch(polyfilledUrl, { responseType: "text" }),
    ).resolves.toBe("ok");

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.example.test/root/rooms"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("does not prepend the base URL to an explicit absolute URL", async () => {
    setBaseUrl("https://api.example.test/root");
    const fetchMock = installFetch(reactNativeResponse("ok"));

    await expect(
      customFetch("https://other.example.test/rooms", {
        responseType: "text",
      }),
    ).resolves.toBe("ok");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://other.example.test/rooms",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("customFetch authentication", () => {
  it("adds a bearer token when no Authorization header is supplied", async () => {
    const fetchMock = installFetch(reactNativeResponse("ok"));
    setAuthTokenGetter(() => "clerk-token");

    await customFetch("/profile", { responseType: "text" });

    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.headers).toBeInstanceOf(Headers);
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer clerk-token",
    );
  });

  it("preserves an explicit Authorization header", async () => {
    const fetchMock = installFetch(reactNativeResponse("ok"));
    setAuthTokenGetter(() => "ignored-token");

    await customFetch("/profile", {
      responseType: "text",
      headers: { Authorization: "Basic explicit-credentials" },
    });

    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.headers).toBeInstanceOf(Headers);
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Basic explicit-credentials",
    );
  });
});

describe("customFetch response parsing", () => {
  it("parses a JSON success response when response.body is unavailable", async () => {
    installFetch(
      reactNativeResponse(JSON.stringify({ profile: "ready" }), {
        status: 200,
      }),
    );

    await expect(
      customFetch<{ profile: string }>("/profile"),
    ).resolves.toEqual({ profile: "ready" });
  });

  it("preserves the raw body when a successful JSON response is malformed", async () => {
    const rawBody = '{"profile":';
    installFetch(reactNativeResponse(rawBody, { status: 200 }));

    const error = await customFetch("/profile").catch((caught) => caught);

    expect(error).toBeInstanceOf(ResponseParseError);
    expect(error).toMatchObject({
      status: 200,
      method: "GET",
      url: "/profile",
      rawBody,
    });
    expect((error as ResponseParseError).cause).toBeInstanceOf(SyntaxError);
  });

  it("parses a JSON error response and exposes it on ApiError", async () => {
    installFetch(
      reactNativeResponse(
        JSON.stringify({ title: "Invalid profile", detail: "Name is required" }),
        {
          status: 422,
          statusText: "Unprocessable Entity",
        },
      ),
    );

    const error = await customFetch("/profile").catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      data: { title: "Invalid profile", detail: "Name is required" },
      message:
        "HTTP 422 Unprocessable Entity: Invalid profile — Name is required",
    });
  });

  it.each([
    ["a non-empty text response", "plain text", "plain text"],
    ["an empty text response", "", null],
  ])(
    "parses %s when response.body is unavailable",
    async (_label, body, expected) => {
      installFetch(
        reactNativeResponse(body, {
          headers: { "content-type": "text/plain" },
        }),
      );

      await expect(
        customFetch<string | null>("/status", { responseType: "text" }),
      ).resolves.toBe(expected);
    },
  );

  it("returns a Blob response when blob() is available", async () => {
    const blob = new Blob(["file contents"], {
      type: "application/octet-stream",
    });
    const response = responseWithoutBlob(
      reactNativeResponse("file contents", {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const blobMock = vi.fn<() => Promise<Blob>>().mockResolvedValue(blob);
    Object.defineProperty(response, "blob", {
      configurable: true,
      value: blobMock,
    });
    installFetch(response);

    await expect(
      customFetch<Blob>("/download", { responseType: "blob" }),
    ).resolves.toBe(blob);
    expect(blobMock).toHaveBeenCalledOnce();
  });

  it("fails clearly when a Blob response is requested without blob()", async () => {
    const response = responseWithoutBlob(
      reactNativeResponse("file contents", {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    installFetch(response);

    await expect(
      customFetch("/download", { responseType: "blob" }),
    ).rejects.toThrow(
      'Blob responses are not supported in this runtime. Use responseType "json" or "text" instead.',
    );
  });
});

describe("customFetch request body guard", () => {
  it.each(["GET", "HEAD"])(
    "rejects a %s request with a body before calling fetch",
    async (method) => {
      const fetchMock = installFetch(reactNativeResponse(""));

      await expect(
        customFetch("/profile", { method, body: "not allowed" }),
      ).rejects.toThrow(`customFetch: ${method} requests cannot have a body.`);

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
