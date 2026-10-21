import crypto from "crypto";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

const PIN_FINGERPRINT_SECRET = process.env.PIN_FINGERPRINT_SECRET || process.env.SESSION_SECRET || "default-pin-secret";

export function generatePinFingerprint(pin: string): string {
  return crypto
    .createHmac("sha256", PIN_FINGERPRINT_SECRET)
    .update(pin)
    .digest("hex");
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(pin, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  const [hashedPassword, salt] = storedHash.split(".");
  if (!hashedPassword || !salt) return false;
  const hashedPasswordBuf = Buffer.from(hashedPassword, "hex");
  const suppliedPasswordBuf = (await scryptAsync(pin, salt, 64)) as Buffer;
  if (hashedPasswordBuf.length !== suppliedPasswordBuf.length) return false;
  return timingSafeEqual(hashedPasswordBuf, suppliedPasswordBuf);
}

/** An employee PIN stored before SCRUM-605: an unsalted sha256, 64 hex characters. */
export function isLegacyPinDigest(stored: string): boolean {
  return /^[a-f0-9]{64}$/.test(stored);
}

/**
 * Check an employee's timeclock PIN against what is stored (SCRUM-605). A
 * salted scrypt hash (hashPin) is checked as such; an old unsalted sha256
 * digest is checked once the old way and reported with `rehash: true`, so
 * the caller replaces it with hashPin's form on that success.
 */
export async function verifyEmployeePin(pin: string, stored: string | null | undefined): Promise<{ ok: boolean; rehash: boolean }> {
  if (!stored) return { ok: false, rehash: false };
  if (isLegacyPinDigest(stored)) {
    const supplied = Buffer.from(crypto.createHash("sha256").update(pin).digest("hex"), "utf8");
    const held = Buffer.from(stored, "utf8");
    const ok = supplied.length === held.length && timingSafeEqual(supplied, held);
    return { ok, rehash: ok };
  }
  return { ok: await verifyPin(pin, stored), rehash: false };
}

export function validatePin(pin: string): { valid: boolean; error?: string } {
  if (!pin || pin.length < 4) {
    return { valid: false, error: "PIN must be at least 4 digits" };
  }
  if (pin.length > 8) {
    return { valid: false, error: "PIN must be at most 8 digits" };
  }
  if (!/^\d+$/.test(pin)) {
    return { valid: false, error: "PIN must contain only digits" };
  }
  return { valid: true };
}
