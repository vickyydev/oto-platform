import { apiRequest } from "./queryClient";

export async function submitAttendanceConfirmation(url: string, data: object, file: File | null): Promise<Response> {
  if (!file) return apiRequest("POST", url, data);
  const body = new FormData();
  body.append("payload", JSON.stringify(data));
  body.append("file", file);
  const response = await fetch(url, { method: "POST", credentials: "include", body });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.message || "Unable to submit attendance evidence.");
  }
  return response;
}
