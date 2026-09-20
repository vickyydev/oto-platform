import type { ModelAdmin } from "./admin";

const registry = new Map<string, ModelAdmin>();

export function register(admin: ModelAdmin): void {
  registry.set(admin.slug, admin);
}

export function getAdmin(slug: string): ModelAdmin | undefined {
  return registry.get(slug);
}

export function getAllAdmins(): ModelAdmin[] {
  return Array.from(registry.values()).sort((a, b) => b.priority - a.priority);
}

export function getAdminMap(): Map<string, ModelAdmin> {
  return registry;
}
