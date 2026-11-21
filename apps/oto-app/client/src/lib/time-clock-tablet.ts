const legacyKey = "kiosk_device_secret";
const keyFor = (branchId: string) => `${legacyKey}:${branchId}`;

export function timeClockSecret(branchId?: string) {
  if (!branchId) return "";
  return localStorage.getItem(keyFor(branchId)) || localStorage.getItem(legacyKey) || "";
}

export interface TimeClockBranch {
  id: string;
  name: string;
  logoUrl: string | null;
  faceClockInEnabled?: boolean;
  tabletRegistered?: boolean;
}

export async function readTimeClockBranch(branchId: string): Promise<TimeClockBranch> {
  const secret = timeClockSecret(branchId);
  const response = await fetch(`/api/public/branches/${encodeURIComponent(branchId)}`, {
    headers: secret ? { "x-kiosk-device-secret": secret } : {},
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Could not load this branch.");
  return response.json();
}

export async function registerTimeClockTablet(branchId: string, name: string) {
  const register = () => registerIfNeeded(branchId, name);
  return navigator.locks ? navigator.locks.request(keyFor(branchId), register) : register();
}

async function registerIfNeeded(branchId: string, name: string) {
  if ((await readTimeClockBranch(branchId)).tabletRegistered) return;
  const response = await fetch("/api/kiosk-devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branchId, name }),
  });
  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? "Sign in as an HR administrator to register this tablet."
      : "Could not register this tablet for the selected branch.");
  }
  const device = await response.json();
  if (device.branchId !== branchId || typeof device.deviceSecret !== "string" || !device.deviceSecret) {
    throw new Error("Could not confirm tablet registration.");
  }
  try {
    localStorage.setItem(keyFor(branchId), device.deviceSecret);
  } catch {
    await fetch(`/api/kiosk-devices/${encodeURIComponent(device.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    throw new Error("This browser could not save the registration. Allow site storage and try again.");
  }
}
