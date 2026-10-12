import type { RequestHandler } from "express";
import multer from "multer";
import { ATTENDANCE_EVIDENCE_MAX_BYTES, ATTENDANCE_EVIDENCE_TYPES } from "../shared/attendance-evidence";

export const attendanceEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  // Leave room for the closing boundary; files/fields each permit one item.
  limits: { fileSize: ATTENDANCE_EVIDENCE_MAX_BYTES, files: 1, fields: 1, fieldSize: 16 * 1024, parts: 3 },
  fileFilter: (_req, file, cb) => {
    if ((ATTENDANCE_EVIDENCE_TYPES as readonly string[]).includes(file.mimetype)) cb(null, true);
    else cb(new Error("Choose a JPEG, PNG, GIF or PDF no larger than 10 MB."));
  },
}).single("file");

export function attendanceConfirmationBody(upload: RequestHandler, faceEnabled: () => boolean, refusal: object): RequestHandler {
  return (req, res, next) => {
    if (!faceEnabled()) { res.status(403).json(refusal); return; }
    if (!req.is("multipart/form-data")) { next(); return; }
    upload(req, res, error => {
      if (error) { res.status(400).json({ message: "Choose one JPEG, PNG, GIF or PDF no larger than 10 MB." }); return; }
      try {
        const payload = JSON.parse(req.body.payload);
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || (req.file && !req.file.size)) throw new Error();
        req.body = payload;
      } catch {
        res.status(400).json({ message: "Invalid attendance confirmation." }); return;
      }
      next();
    });
  };
}
