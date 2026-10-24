import { z } from "zod";

export const managedInAdminResponseSchema = z.object({
  code: z.literal("managed_in_admin"),
  message: z.literal("Managed in Admin. Open Admin to make changes."),
}).strict();

export type ManagedInAdminResponse = z.infer<typeof managedInAdminResponseSchema>;

export const managedInAdminResponse: Readonly<ManagedInAdminResponse> = Object.freeze({
  code: "managed_in_admin",
  message: "Managed in Admin. Open Admin to make changes.",
});

export function isManagedInAdmin(actorManaged: boolean, targetManaged: boolean): boolean {
  return actorManaged || targetManaged;
}
