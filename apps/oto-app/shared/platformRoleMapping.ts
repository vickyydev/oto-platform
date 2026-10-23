import { z } from "zod";

export const mappedOtoAppRoleSchema = z.enum(["admin", "manager", "staff"]);
export type MappedOtoAppRole = z.infer<typeof mappedOtoAppRoleSchema>;

export const otoAppRoleContextSchema = z.object({
  platformRolesEnabled: z.literal(true),
  userId: z.string().min(1),
  operatorId: z.string().uuid(),
  tenantId: z.string().uuid(),
  role: mappedOtoAppRoleSchema,
  permissions: z.object({ "hr:salary:view": z.boolean() }).strict(),
}).strict();
export type OtoAppRoleContext = z.infer<typeof otoAppRoleContextSchema>;

export class PlatformRoleMappingError extends Error {
  constructor() {
    super("The platform role context does not match this app identity.");
    this.name = "PlatformRoleMappingError";
  }
}

/** Only absence is the legacy contract; a present malformed claim never becomes legacy. */
export function readOtoAppRoleContext(value: unknown): OtoAppRoleContext | undefined {
  if (value === undefined) return undefined;
  const parsed = otoAppRoleContextSchema.safeParse(value);
  if (!parsed.success) throw new PlatformRoleMappingError();
  return parsed.data;
}
