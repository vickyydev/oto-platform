export type EnrollmentIdentityType = "EMPLOYEE" | "ADVISOR";

export interface KioskEnrollmentIdentity {
  sessionId: string;
  token: string;
  identityType: EnrollmentIdentityType;
  person: {
    id: string;
    fullName: string;
  };
}

function isNamedIdentity(value: unknown): value is { id: string; fullName: string } {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.id === "string" &&
    identity.id.length > 0 &&
    typeof identity.fullName === "string" &&
    identity.fullName.trim().length > 0
  );
}

export function normalizeEnrollmentIdentity(
  response: unknown,
  token: string,
): KioskEnrollmentIdentity {
  if (!response || typeof response !== "object") {
    throw new Error("The enrollment response was invalid. Please scan the QR code again.");
  }

  const data = response as Record<string, unknown>;
  if (typeof data.sessionId !== "string" || data.sessionId.length === 0) {
    throw new Error("The enrollment response was invalid. Please scan the QR code again.");
  }

  if (data.identityType === "ADVISOR" && isNamedIdentity(data.advisor)) {
    return {
      sessionId: data.sessionId,
      token,
      identityType: "ADVISOR",
      person: {
        id: data.advisor.id,
        fullName: data.advisor.fullName,
      },
    };
  }

  if (data.identityType === "EMPLOYEE" && isNamedIdentity(data.employee)) {
    return {
      sessionId: data.sessionId,
      token,
      identityType: "EMPLOYEE",
      person: {
        id: data.employee.id,
        fullName: data.employee.fullName,
      },
    };
  }

  throw new Error("The enrollment response was invalid. Please scan the QR code again.");
}