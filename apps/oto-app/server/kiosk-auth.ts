import { Request, Response, NextFunction } from "express";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { eq, and, gt, isNull } from "drizzle-orm";
import { db } from "./db";
import { kioskSessions, kioskDevices, kioskCodes, tenants } from "@shared/schema";
import { storage } from "./storage";

const KIOSK_CODE_PEPPER = process.env.KIOSK_CODE_PEPPER || "default-kiosk-pepper-change-in-production";
const SESSION_PEPPER = process.env.SESSION_PEPPER || "default-session-pepper-change-in-production";

export const kioskPermissions = [
  "core.checkin.read",
  "core.checkin.update",
  "core.guest.read_minimal",
] as const;

export type KioskPermission = typeof kioskPermissions[number];

interface KioskSessionData {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  branchId: string;
  kioskType: string;
}

declare global {
  namespace Express {
    interface Request {
      kioskSession?: KioskSessionData;
    }
  }
}

export function hashKioskCode(code: string): string {
  return createHash("sha256").update(code + KIOSK_CODE_PEPPER).digest("hex");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token + SESSION_PEPPER).digest("hex");
}

export function generateKioskCode(): string {
  return randomBytes(32).toString("base64url");
}

export function generateSessionToken(): string {
  return randomBytes(48).toString("base64url");
}

export function generateDeviceSecret(): string {
  return randomBytes(32).toString("hex");
}

// Matches the hashing the face-recognition kiosks already use for their device
// secret, so a secret issued here resolves through getKioskDeviceBySecret too.
// Unpeppered sha256 is weak against an offline attack on a guessable input; a
// device secret is 32 random bytes, so there is nothing to guess.
export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function verifyDeviceSecret(secret: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashDeviceSecret(secret), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

export async function validateKioskSession(tokenHash: string): Promise<KioskSessionData | null> {
  const now = new Date();
  
  const [session] = await db
    .select({
      sessionId: kioskSessions.id,
      deviceId: kioskSessions.kioskDeviceId,
      tenantId: kioskSessions.tenantId,
      branchId: kioskDevices.branchId,
      kioskType: kioskDevices.kioskType,
    })
    .from(kioskSessions)
    .innerJoin(kioskDevices, eq(kioskSessions.kioskDeviceId, kioskDevices.id))
    .where(
      and(
        eq(kioskSessions.sessionTokenHash, tokenHash),
        gt(kioskSessions.expiresAt, now),
        eq(kioskDevices.isActive, true)
      )
    )
    .limit(1);

  if (!session) return null;

  await db
    .update(kioskSessions)
    .set({ lastSeenAt: now })
    .where(eq(kioskSessions.id, session.sessionId));

  await db
    .update(kioskDevices)
    .set({ lastSeenAt: now })
    .where(eq(kioskDevices.id, session.deviceId));

  return {
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    tenantId: session.tenantId,
    branchId: session.branchId,
    kioskType: session.kioskType || "reception",
  };
}

export function requireKioskSession(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Kiosk session required" });
  }

  const token = authHeader.substring(7);
  const tokenHash = hashSessionToken(token);

  validateKioskSession(tokenHash)
    .then((session) => {
      if (!session) {
        return res.status(401).json({ error: "Invalid or expired kiosk session" });
      }
      req.kioskSession = session;
      next();
    })
    .catch((error) => {
      console.error("Kiosk session validation error:", error);
      return res.status(500).json({ error: "Session validation failed" });
    });
}

export function requireKioskPermission(...permissions: KioskPermission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.kioskSession) {
      return res.status(401).json({ error: "Kiosk session required" });
    }

    const hasPermission = permissions.every((p) => kioskPermissions.includes(p));
    
    if (!hasPermission) {
      return res.status(403).json({ error: "Permission denied" });
    }

    next();
  };
}

const KIOSK_CODE_EXPIRY_SECONDS_DEFAULT = 600; // 10 minutes

/** The park group's kiosk code lifetime (S2-17b round 4a), the default park group's where it has none. */
async function getKioskCodeExpirySeconds(tenantId: string): Promise<number> {
  const row = await storage.getSetting("auth_kiosk_code_expiry_seconds", tenantId);
  if (!row) return KIOSK_CODE_EXPIRY_SECONDS_DEFAULT;
  const parsed = parseInt(row.value, 10);
  return isNaN(parsed) || parsed <= 0 ? KIOSK_CODE_EXPIRY_SECONDS_DEFAULT : parsed;
}

export async function createKioskCode(
  tenantId: string,
  branchId: string,
): Promise<{ code: string; expiresAt: Date }> {
  const expirySeconds = await getKioskCodeExpirySeconds(tenantId);
  const code = generateKioskCode();
  const codeHash = hashKioskCode(code);
  const expiresAt = new Date(Date.now() + expirySeconds * 1000);

  await db.insert(kioskCodes).values({
    tenantId,
    branchId,
    codeHash,
    expiresAt,
  });

  return { code, expiresAt };
}

export async function exchangeKioskCode(
  code: string,
  ip?: string,
  userAgent?: string
): Promise<{ token: string; expiresAt: Date; deviceSecret: string; device: { id: string; name: string | null; branchId: string } } | null> {
  const codeHash = hashKioskCode(code);
  const now = new Date();

  const [existingCode] = await db
    .select()
    .from(kioskCodes)
    .where(eq(kioskCodes.codeHash, codeHash))
    .limit(1);

  if (!existingCode) {
    console.warn("[kiosk-exchange] failed: code not found", { ip, userAgent });
    return null;
  }

  if (existingCode.usedAt) {
    console.warn("[kiosk-exchange] failed: code already used", {
      usedAt: existingCode.usedAt,
      ip,
      userAgent,
    });
    return null;
  }

  if (existingCode.expiresAt <= now) {
    console.warn("[kiosk-exchange] failed: code expired", {
      expiresAt: existingCode.expiresAt,
      now,
      expiredAgoMs: now.getTime() - existingCode.expiresAt.getTime(),
      ip,
      userAgent,
    });
    return null;
  }

  const [updatedCode] = await db
    .update(kioskCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(kioskCodes.codeHash, codeHash),
        gt(kioskCodes.expiresAt, now),
        isNull(kioskCodes.usedAt)
      )
    )
    .returning();

  if (!updatedCode) {
    console.warn("[kiosk-exchange] failed: update matched no rows (race condition?)", { ip, userAgent });
    return null;
  }

  const kioskCode = updatedCode;

  // The device gets its own secret at activation. The id alone is not a
  // credential: it is handed to the browser and travels in responses, so a
  // silent reconnect has to prove possession of something the browser was given
  // once and nothing else carries. Hashed the same way as a face kiosk's secret
  // (plain sha256, no pepper) so one device secret works on both paths.
  const deviceSecret = generateDeviceSecret();
  const deviceSecretHash = hashDeviceSecret(deviceSecret);

  const [device] = await db
    .insert(kioskDevices)
    .values({
      tenantId: kioskCode.tenantId,
      branchId: kioskCode.branchId,
      kioskType: "reception",
      deviceSecretHash,
      isActive: true,
      lastSeenAt: now,
      lastIp: ip,
      lastUserAgent: userAgent,
    })
    .returning();

  const sessionToken = generateSessionToken();
  const sessionTokenHash = hashSessionToken(sessionToken);
  const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.insert(kioskSessions).values({
    tenantId: kioskCode.tenantId,
    kioskDeviceId: device.id,
    sessionTokenHash,
    expiresAt: sessionExpiresAt,
    lastSeenAt: now,
  });

  return {
    token: sessionToken,
    expiresAt: sessionExpiresAt,
    deviceSecret,
    device: {
      id: device.id,
      name: device.name,
      branchId: device.branchId,
    },
  };
}

export async function refreshKioskSession(
  deviceId: string,
  deviceSecret: string,
  ip?: string,
  userAgent?: string
): Promise<{ token: string; expiresAt: Date; device: { id: string; name: string | null; branchId: string } } | null> {
  const now = new Date();

  const [row] = await db
    .select({ device: kioskDevices })
    .from(kioskDevices)
    .innerJoin(tenants, eq(kioskDevices.tenantId, tenants.id))
    .where(
      and(
        eq(kioskDevices.id, deviceId),
        eq(kioskDevices.isActive, true)
      )
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const device = row.device;

  // A session minted here lasts 30 days, so the id is not enough: the caller
  // must present the secret the device was given when it was activated. A
  // device with no stored secret was activated before secrets existed and
  // cannot reconnect silently — it has to be activated again from a QR code.
  if (!device.deviceSecretHash || !verifyDeviceSecret(deviceSecret, device.deviceSecretHash)) {
    console.warn("[kiosk-refresh] failed: device secret did not verify", { deviceId, ip, userAgent });
    return null;
  }

  const sessionToken = generateSessionToken();
  const sessionTokenHash = hashSessionToken(sessionToken);
  const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await db.insert(kioskSessions).values({
    tenantId: device.tenantId,
    kioskDeviceId: device.id,
    sessionTokenHash,
    expiresAt: sessionExpiresAt,
    lastSeenAt: now,
  });

  await db
    .update(kioskDevices)
    .set({ lastSeenAt: now, lastIp: ip, lastUserAgent: userAgent })
    .where(eq(kioskDevices.id, device.id));

  return {
    token: sessionToken,
    expiresAt: sessionExpiresAt,
    device: {
      id: device.id,
      name: device.name,
      branchId: device.branchId,
    },
  };
}

export async function revokeKioskSession(sessionId: string, tenantId: string): Promise<boolean> {
  const deleted = await db
    .delete(kioskSessions)
    .where(
      and(
        eq(kioskSessions.id, sessionId),
        eq(kioskSessions.tenantId, tenantId)
      )
    )
    .returning();

  return deleted.length > 0;
}

// The device first, held to the park group; its sessions only when that
// matched (S2-17b round 5 review, F3). The sessions used to go first, so
// another park group's revoke signed the tablet out and was answered 200.
export async function revokeKioskDevice(deviceId: string, tenantId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(kioskDevices)
      .set({ isActive: false, updatedAt: new Date() })
      .where(
        and(
          eq(kioskDevices.id, deviceId),
          eq(kioskDevices.tenantId, tenantId)
        )
      )
      .returning({ id: kioskDevices.id });

    if (updated.length === 0) return false;

    await tx
      .delete(kioskSessions)
      .where(eq(kioskSessions.kioskDeviceId, deviceId));

    return true;
  });
}
