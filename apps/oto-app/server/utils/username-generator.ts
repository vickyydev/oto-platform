import { db } from "../db";
import { users } from "@shared/schema";
import { eq, like, sql } from "drizzle-orm";

export async function generateUniqueUsername(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  nickname: string | null | undefined,
  fallbackId: string
): Promise<string> {
  let base = "";
  
  if (firstName && lastName) {
    base = `${firstName}.${lastName}`;
  } else if (firstName) {
    base = firstName;
  } else if (nickname) {
    base = nickname;
  } else if (lastName) {
    base = lastName;
  } else {
    base = `user${fallbackId.slice(-4)}`;
  }
  
  base = sanitizeUsername(base);
  
  if (base.length < 2) {
    base = `user${fallbackId.slice(-4)}`;
  }
  
  const existingUsernames = await db
    .select({ username: users.username })
    .from(users)
    .where(like(users.username, `${base}%`));
  
  const usernameSet = new Set(existingUsernames.map((u) => u.username));
  
  if (!usernameSet.has(base)) {
    return base;
  }
  
  let suffix = 2;
  while (usernameSet.has(`${base}-${suffix}`)) {
    suffix++;
  }
  
  return `${base}-${suffix}`;
}

function sanitizeUsername(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9.]/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 24);
}

export function generateTempPassword(length: number = 12): string {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}
