import type { NextFunction, Request, Response } from "express";
import { requireAuthorizedUser } from "../lib/requireAccountAccess";

export interface AuthRequest extends Request {
  userId: string;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void requireAuthorizedUser(req, res)
    .then((userId) => {
      if (!userId) return;
      (req as AuthRequest).userId = userId;
      next();
    })
    .catch(next);
}