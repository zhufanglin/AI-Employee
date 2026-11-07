import type { NextFunction, Request, Response } from "express";

/** Workspace files contain customer data and must never be served as public static files. */
export function denyWorkspaceStatic(req: Request, res: Response, next: NextFunction) {
  let path: string;
  try {
    path = decodeURIComponent(req.path);
  } catch {
    return res.sendStatus(400);
  }
  // Reject encoded separators and any case variant as well, including on Windows.
  if (path.split(/[\\/]+/).some((segment) => segment.toLowerCase() === "workspace")) {
    return res.sendStatus(404);
  }
  return next();
}
