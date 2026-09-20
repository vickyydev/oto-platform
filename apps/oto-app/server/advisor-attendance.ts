import crypto from "crypto";

export type AdvisorKioskPolicy = {
  tenantId: string;
  branchScope: "ALL" | "SELECTED";
  branchIds: string[] | null;
};

export function canAdvisorUseKiosk(
  policy: AdvisorKioskPolicy,
  branch: { id: string; tenantId: string },
): boolean {
  return policy.tenantId === branch.tenantId &&
    (policy.branchScope === "ALL" || (policy.branchIds || []).includes(branch.id));
}

export function advisorSessionMetrics(
  checkInAt: Date,
  checkOutAt: Date | null,
  checkInDate: string,
  checkoutLocalDate?: string,
) {
  return {
    totalMinutes: checkOutAt ? Math.max(0, Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000)) : null,
    isOvernight: !!checkOutAt && checkoutLocalDate !== checkInDate,
  };
}

export function advisorSessionCorrectionValues(
  checkInAt: Date,
  checkOutAt: Date | null,
  timezone: string,
) {
  const localDate = (date: Date) => new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const checkInDate = localDate(checkInAt);
  return {
    checkInDate,
    ...advisorSessionMetrics(checkInAt, checkOutAt, checkInDate, checkOutAt ? localDate(checkOutAt) : undefined),
  };
}

const identificationSecret = process.env.KIOSK_IDENTIFICATION_TOKEN_SECRET || process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
export function issueAdvisorIdentificationProof(personId: string, deviceId: string, branchId: string): string {
  const payload = `${personId}.${deviceId}.${branchId}.${Date.now() + 60_000}`;
  const signature = crypto.createHmac("sha256", identificationSecret).update(payload).digest("base64url");
  return Buffer.from(payload).toString("base64url") + "." + signature;
}
export function verifyAdvisorIdentificationProof(token: string, deviceId: string) {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const payload = Buffer.from(encoded, "base64url").toString();
  const expected = crypto.createHmac("sha256", identificationSecret).update(payload).digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;
  const [personId, proofDeviceId, branchId, expiresAt] = payload.split(".");
  return proofDeviceId === deviceId && Number(expiresAt) >= Date.now() ? { personId, branchId } : null;
}