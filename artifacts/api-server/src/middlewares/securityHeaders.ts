import type { NextFunction, Request, Response } from "express";

export function noSniff(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}

/**
 * Forbids embedding a document by URL. The room call/sandbox documents are
 * safe to lock down: native apps load them as the WebView's top-level page,
 * the web app renders fetched markup through `iframe srcdoc` (response
 * headers do not apply), and their own `srcdoc` preview child is unaffected.
 * Only the `frame-ancestors` directive is set; this is not a full CSP.
 */
export function denyFraming(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  next();
}
