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
  return timingSafeEqual(hashedPasswordBuf, suppliedPasswordBuf);
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
