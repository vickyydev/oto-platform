export function normalizeThaiPhone(input: string, defaultCountryCode: string = "+66"): string {
  let cleaned = input.replace(/[\s\-\(\)\.]/g, "");

  if (cleaned.startsWith("+")) {
    return cleaned;
  }

  if (cleaned.startsWith("0")) {
    return defaultCountryCode + cleaned.substring(1);
  }

  if (/^\d{9,10}$/.test(cleaned) && !cleaned.startsWith("0")) {
    return defaultCountryCode + cleaned;
  }

  return defaultCountryCode + cleaned;
}

export function validatePhoneInput(input: string): { valid: boolean; error?: string } {
  const cleaned = input.replace(/[\s\-\(\)\.]/g, "");
  if (!cleaned) {
    return { valid: false, error: "Phone number is required" };
  }
  if (cleaned.startsWith("+")) {
    if (!/^\+\d{10,15}$/.test(cleaned)) {
      return { valid: false, error: "Invalid international phone number format" };
    }
    return { valid: true };
  }
  if (!/^\d{9,10}$/.test(cleaned)) {
    return { valid: false, error: "Phone number must be 9-10 digits (Thai format) or start with +" };
  }
  return { valid: true };
}

export function formatPhoneDisplay(e164: string): string {
  if (e164.startsWith("+66") && e164.length === 12) {
    const local = "0" + e164.substring(3);
    return local.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
  }
  return e164;
}

export function identifyEmployeeByPhoneInput(phoneInput: string, defaultCountryCode: string = "+66"): { normalized: string; error?: string } {
  const validation = validatePhoneInput(phoneInput);
  if (!validation.valid) {
    return { normalized: "", error: validation.error };
  }
  const normalized = normalizeThaiPhone(phoneInput, defaultCountryCode);
  return { normalized };
}
