import type { NextFunction, Request, Response } from "express";
import type { Pool, PoolClient } from "pg";
import { createHash, randomBytes } from "crypto";
import type { DirectoryClientScope } from "@shared/schema";

/**
 * A directory caller that names its tenant (events-kiosk PLAN s8, round 0).
 *
 * The directory API's HR reads (`/api/directory/employee/:id` and the rest)
 * authenticate one shared key, `HR_DIRECTORY_API_KEY`. A shared key proves the
 * caller is a service; it says nothing about whose data that service may touch,
 * and on a database that holds more than one tenant that is the question that
 * matters. Those routes are left exactly as they are.
 *
 * The write routes for the POS seam take one of these instead: a key issued to
 * one caller for one tenant (`directory_clients`, migration 0003). The tenant a
 * request acts in is read off the key, never off the request, so a caller
 * holding tenant A's key cannot name tenant B's event into existence — it gets
 * the same 404 as an event that does not exist.
 *
 * The key is 32 random bytes and is stored only as its sha256, the way the
 * kiosks' device secrets are (`hashDeviceSecret` in kiosk-auth.ts): there is
 * nothing to guess, so a slow hash would buy nothing. The plaintext is shown
 * once, by `script/directory-client.mjs`, and never again.
 */

export const DIRECTORY_KEY_PREFIX = "odk_";

/** A fresh key. The prefix makes one recognisable in a secret store or a log scrubber. */
export function generateDirectoryKey(): string {
  return DIRECTORY_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** What is stored, and what a presented key is looked up by. */
export function hashDirectoryKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface DirectoryClientIdentity {
  id: string;
  tenantId: string;
  name: string;
  scopes: string[];
}

type Queryable = Pool | PoolClient;

/** The active, unrevoked caller a key belongs to, or null. */
export async function resolveDirectoryClient(
  db: Queryable,
  presentedKey: string,
): Promise<DirectoryClientIdentity | null> {
  const { rows } = await db.query<{ id: string; tenant_id: string; name: string; scopes: string[] }>(
    `select id, tenant_id, name, scopes
       from directory_clients
      where key_hash = $1 and is_active and revoked_at is null`,
    [hashDirectoryKey(presentedKey)],
  );
  const row = rows[0];
  return row ? { id: row.id, tenantId: row.tenant_id, name: row.name, scopes: row.scopes } : null;
}

/** The caller a request was authenticated as. Set by `requireDirectoryClient`. */
export function directoryClientOf(res: Response): DirectoryClientIdentity {
  const client = res.locals.directoryClient as DirectoryClientIdentity | undefined;
  if (!client) throw new Error("directoryClientOf called on a route without requireDirectoryClient");
  return client;
}

// --- Rate limiting, per caller ----------------------------------------------

/**
 * The same window and ceiling as the HR reads (`directoryApiRateLimit`, read
 * from the same two environment variables), counted per caller rather than per
 * presented header — a shared bucket would let one caller's retries starve
 * another's.
 */
interface RateLimitEntry {
  count: number;
  resetAt: number;
}
const rateLimits = new Map<string, RateLimitEntry>();

function windowMs(): number {
  return parseInt(process.env.DIRECTORY_API_RATE_LIMIT_WINDOW_SECONDS || "60", 10) * 1000;
}

function maxRequests(): number {
  return parseInt(process.env.DIRECTORY_API_RATE_LIMIT_MAX_REQUESTS || "100", 10);
}

/** Over the ceiling: the seconds to wait. Under it: null. */
function overLimit(clientId: string): number | null {
  const now = Date.now();
  for (const [key, entry] of rateLimits) if (entry.resetAt < now) rateLimits.delete(key);
  let entry = rateLimits.get(clientId);
  if (!entry) {
    entry = { count: 0, resetAt: now + windowMs() };
    rateLimits.set(clientId, entry);
  }
  entry.count += 1;
  return entry.count > maxRequests() ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : null;
}

// --- The middleware ---------------------------------------------------------

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Authenticate a directory caller by `Authorization: Bearer <key>` and require
 * one scope.
 *
 * 401 with no key; 403 for a key that resolves to no active caller or to one
 * without the scope; 429 over the rate limit. The answers follow the directory
 * API's existing `{ error, message }` shape.
 */
export function requireDirectoryClient(pool: Pool, scope: DirectoryClientScope) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const presented = typeof header === "string" ? BEARER.exec(header.trim())?.[1] : undefined;
    if (!presented) {
      return res.status(401).json({
        error: "Authentication required",
        message: "Send the directory key as Authorization: Bearer <key>",
      });
    }
    try {
      const client = await resolveDirectoryClient(pool, presented);
      if (!client) {
        return res.status(403).json({
          error: "Invalid directory key",
          message: "The key is not one this app issued, or it has been revoked",
        });
      }
      if (!client.scopes.includes(scope)) {
        return res.status(403).json({
          error: "Scope required",
          message: `This directory key does not carry ${scope}`,
        });
      }
      const retryAfter = overLimit(client.id);
      if (retryAfter !== null) {
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({
          error: "Too many requests",
          message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          retryAfter,
        });
      }
      // When the key was last used, for whoever has to decide whether a key
      // nobody uses can be revoked. Once a minute is enough to answer that.
      await pool.query(
        `update directory_clients set last_used_at = now()
          where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
        [client.id],
      );
      res.locals.directoryClient = client;
      next();
    } catch (error) {
      next(error);
    }
  };
}
