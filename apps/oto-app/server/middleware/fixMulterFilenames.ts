import { Request, Response, NextFunction } from "express";

/**
 * Multer decodes multipart filenames as Latin-1 by default (RFC 2388).
 * This middleware re-encodes them as UTF-8 so Thai and other non-ASCII
 * filenames are preserved correctly.
 *
 * Apply immediately after any multer middleware.
 */
export function fixMulterFilenames(req: Request, _res: Response, next: NextFunction): void {
  const fix = (f: Express.Multer.File) => {
    f.originalname = Buffer.from(f.originalname, "latin1").toString("utf8");
  };
  if (req.file) fix(req.file);
  if (req.files) {
    if (Array.isArray(req.files)) req.files.forEach(fix);
    else Object.values(req.files).flat().forEach(fix);
  }
  next();
}
