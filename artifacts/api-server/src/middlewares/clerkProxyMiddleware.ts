import type { RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { getAllowedOrigins } from "../lib/origins";

const CLERK_FAPI = "https://frontend-api.clerk.dev";
export const CLERK_PROXY_PATH = "/api/__clerk";
const HOST_HEADER_PATTERN = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

export function getClerkProxyHost(req: {
  headers: IncomingHttpHeaders;
}): string | undefined {
  const forwarded = req.headers["x-forwarded-host"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstHop = raw?.split(",")[0]?.trim();
  return [firstHop, req.headers.host?.trim()].find(isAllowedProxyHost);
}

function isAllowedProxyHost(host: string | undefined): host is string {
  if (!host || !HOST_HEADER_PATTERN.test(host)) return false;
  const normalizedHost = host.toLowerCase();
  return getAllowedOrigins().some((origin) => {
    try {
      return new URL(origin).host.toLowerCase() === normalizedHost;
    } catch {
      return false;
    }
  });
}

export function clerkProxyMiddleware(): RequestHandler {
  if (process.env["NODE_ENV"] !== "production") {
    return (_req, _res, next) => next();
  }

  const secretKey = process.env["CLERK_SECRET_KEY"];
  if (!secretKey) {
    return (_req, _res, next) => next();
  }

  const proxyMiddleware = createProxyMiddleware({
    target: CLERK_FAPI,
    changeOrigin: true,
    selfHandleResponse: true,
    pathRewrite: (path: string) =>
      path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ""),
    on: {
      proxyReq: (proxyReq, req) => {
        const host = getClerkProxyHost(req) || "";
        proxyReq.setHeader(
          "Clerk-Proxy-Url",
          `https://${host}${CLERK_PROXY_PATH}`,
        );
        proxyReq.setHeader("Clerk-Secret-Key", secretKey);
      },
      proxyRes: (proxyRes, req, res) => {
        const headers = { ...proxyRes.headers };
        delete headers["transfer-encoding"];
        delete headers["connection"];
        delete headers["keep-alive"];

        const status = proxyRes.statusCode ?? 502;
        const bodyless =
          req.method === "HEAD" ||
          status < 200 ||
          status === 204 ||
          status === 304;
        if (bodyless) delete headers["content-length"];

        if (headers["content-length"] !== undefined || bodyless) {
          res.writeHead(status, headers);
          proxyRes.on("error", () => res.destroy());
          proxyRes.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const body = Buffer.concat(chunks);
          headers["content-length"] = String(body.length);
          res.writeHead(status, headers);
          res.end(body);
        });
        proxyRes.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(502, { "content-length": "0" });
          }
          res.end();
        });
      },
    },
  }) as RequestHandler;
  return (req, res, next) => {
    if (!getClerkProxyHost(req)) {
      res.status(400).end();
      return;
    }
    return proxyMiddleware(req, res, next);
  };
}
