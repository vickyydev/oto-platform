import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const PREFIX = "v1:";

function vaultKey(tenantId: string): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Vault key unavailable");
  return Buffer.from(hkdfSync("sha256", secret, tenantId, "otoapp-access-vault", 32));
}

export function sealAccessPassword(tenantId: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(tenantId), iv);
  cipher.setAAD(Buffer.from(tenantId));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function openAccessPassword(tenantId: string, stored: string): string | null {
  // Rows from the original app predate encryption. They are resealed when revealed.
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    if (raw.length < 28) return null;
    const decipher = createDecipheriv("aes-256-gcm", vaultKey(tenantId), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(tenantId));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function isSealedAccessPassword(stored: string): boolean {
  return stored.startsWith(PREFIX);
}
