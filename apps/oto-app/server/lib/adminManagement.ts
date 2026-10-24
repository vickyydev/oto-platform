import { isManagedInAdmin } from "@shared/adminManagement";

export interface AdminManagementOperator {
  id: string;
  tenantId: string;
  platformRolesEnabled: boolean;
}

export interface AdminManagementReader {
  getOperators(): Promise<readonly AdminManagementOperator[]>;
}

export interface AdminManagement {
  readonly actorManaged: boolean;
  operatorManaged(operatorId: string | null | undefined): boolean;
  writeManaged(operatorIds?: readonly (string | null | undefined)[]): boolean;
}

/** Resolve actual entity flags once for this request, after the route's ownership checks. */
export async function loadAdminManagement(
  tenantId: string,
  actorOperatorId: string | null | undefined,
  reader: AdminManagementReader,
): Promise<AdminManagement> {
  const operators = await reader.getOperators();
  const managedOperatorIds = new Set(operators
    .filter(operator => operator.tenantId === tenantId && operator.platformRolesEnabled === true)
    .map(operator => operator.id));
  const operatorManaged = (operatorId: string | null | undefined): boolean =>
    typeof operatorId === "string" && managedOperatorIds.has(operatorId);
  const actorManaged = operatorManaged(actorOperatorId);

  return {
    actorManaged,
    operatorManaged,
    writeManaged: (operatorIds = []) => isManagedInAdmin(
      actorManaged,
      operatorIds.some(operatorManaged),
    ),
  };
}
