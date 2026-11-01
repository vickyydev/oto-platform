/** Selling readiness is separate from whether an administrator may save a draft. */
export function stationPrefixReadiness(station: { kind: string; codePrefix?: string | null }): {
  ready: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (station.kind === 'till') {
    if (!station.codePrefix) reasons.push('No receipt prefix');
    else if (!/^[0-9A-Z]{1,6}$/.test(station.codePrefix) || station.codePrefix === 'WEB') {
      reasons.push('Set a receipt prefix of one to six capital letters or digits, other than WEB');
    }
  }
  return { ready: reasons.length === 0, reasons };
}
