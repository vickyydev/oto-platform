// Builds a standards-compliant EMVCo PromptPay QR payload string so the
// generated QR is genuinely scannable / importable by Thai banking apps.
// Spec: EMVCo Merchant-Presented QR + Bank of Thailand PromptPay (AID
// A000000677010111). The QR encodes the payee + amount; the customer's bank
// app reads it and lets them confirm the transfer.

function field(id: string, value: string): string {
  const len = value.length.toString().padStart(2, '0');
  return `${id}${len}${value}`;
}

// PromptPay mobile-number target: "00" + the full E.164 digits (no "+").
// Handles both new international format (+66XXXXXXXXX) and legacy local Thai
// format (0XXXXXXXXX) so existing stored values still produce a valid QR.
function formatPhoneTarget(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith('+')) {
    // "+66818953926" → "0066818953926"
    return '00' + trimmed.replace(/\D/g, '');
  }
  // Local Thai "0XXXXXXXXX" → "0066XXXXXXXXX" (strip leading national 0)
  const digits = trimmed.replace(/\D/g, '').replace(/^0/, '');
  return `0066${digits}`;
}

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the payload incl. "6304".
function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function buildPromptPayPayload(phone: string, amountTHB: number): string {
  const merchantAccount =
    field('00', 'A000000677010111') + field('01', formatPhoneTarget(phone));

  const payload =
    field('00', '01') + // Payload Format Indicator
    field('01', '12') + // Point of Initiation: 12 = dynamic (amount included)
    field('29', merchantAccount) + // Merchant Account Info (PromptPay)
    field('53', '764') + // Currency: THB
    field('54', amountTHB.toFixed(2)) + // Transaction amount
    field('58', 'TH') + // Country
    '6304'; // CRC tag + length, value appended below

  return payload + crc16(payload);
}
