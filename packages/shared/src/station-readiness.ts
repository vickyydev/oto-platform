import { PaymentRoutingSchema } from './payments';

/** The box speaks these two dialects, including on its simulated transport. */
export const SELLING_TERMINAL_PROTOCOLS = ['ghl_linkpos', 'digio_tlv'] as const;
export function supportedSellingTerminalProtocol(protocol?: string | null): boolean {
  return (SELLING_TERMINAL_PROTOCOLS as readonly string[]).includes(protocol ?? '');
}

/**
 * The terminals a press of Card or QR reaches, read as the tender service reads
 * them (`startPaymentTender`, `startTerminalTender`): only `card: 'manual'`,
 * `qr: 'gateway'` and `qr: 'none'` go elsewhere. Unset means the terminal, and a
 * routing that fails to parse is treated as unset because the tender ignores it.
 */
export function routedTerminalRoles(paymentRouting: unknown): Array<'card_terminal' | 'qr_terminal'> {
  const parsed = PaymentRoutingSchema.safeParse(paymentRouting ?? {});
  const routing = parsed.success ? parsed.data : {};
  const roles: Array<'card_terminal' | 'qr_terminal'> = [];
  if (routing.card !== 'manual') roles.push('card_terminal');
  if (routing.qr !== 'gateway' && routing.qr !== 'none') roles.push('qr_terminal');
  return roles;
}

export interface SellingStationSetup {
  kind: string;
  codePrefix?: string | null;
  boxId: string | null;
  paymentRouting?: unknown;
}
export interface SellingTerminalAssignment {
  role: string;
  kind: string;
  boxId: string | null;
  protocol?: string | null;
}

/** Callers supply only active devices in this operator; the role and box must also match. */
export function stationSellingReadiness(station: SellingStationSetup, assignments: SellingTerminalAssignment[]) {
  const { reasons } = stationPrefixReadiness(station);
  if (station.kind === 'till') {
    for (const role of routedTerminalRoles(station.paymentRouting)) {
      const assigned = assignments.filter(d => d.role === role && d.kind === 'terminal');
      const terminal = assigned.find(d => station.boxId !== null && d.boxId === station.boxId);
      if (terminal) {
        if (!supportedSellingTerminalProtocol(terminal.protocol)) reasons.push('The assigned terminal has no supported protocol');
      } else if (assigned.length > 0) reasons.push('The assigned terminal is on another box');
      else reasons.push(`${role === 'card_terminal' ? 'Card' : 'QR'} is routed to the terminal but no terminal is assigned`);
    }
  }
  return { ready: reasons.length === 0, reasons: [...new Set(reasons)] };
}

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
