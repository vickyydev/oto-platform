import { STORAGE_ENV_PREFIX } from "../config/env";

export function buildStorageKey(tenantId: string, parts: string[]): string {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }
  if (!parts || parts.length === 0) {
    throw new Error("parts array is required and must not be empty");
  }

  const safeParts = parts.map((part) => {
    return part
      .replace(/\.\./g, "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\/+/g, "/");
  });

  const joinedParts = safeParts.filter(Boolean).join("/");

  return `${STORAGE_ENV_PREFIX}/tenants/${tenantId}/${joinedParts}`;
}
