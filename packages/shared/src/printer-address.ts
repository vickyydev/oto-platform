/**
 * SCRUM-899 — THE ADDRESS A PRINTER IS REACHED AT, in the forms the box prints
 * to and no other.
 *
 * The box opens every printer the same way: a raw TCP socket to a host on a
 * port, 9100 when the address names none (`parseAddress` in
 * `packages/box-agent/src/printing/channel.ts`). So the three kinds of printer
 * the park has are one form of address:
 *
 *   - a printer on the park's network, at its own address:
 *     `192.168.88.204:9100`;
 *   - a USB printer on the Pi, through the box's USB bridge, which listens on
 *     the Pi itself: `127.0.0.1:9100` (and `127.0.0.1:9101` for a second);
 *   - a simulated printer, which the box finds by the address on its row
 *     (`createPrinting` in `packages/box-agent/src/printing/index.ts`): any
 *     such `host:port`, often the park printer it stands in for.
 *
 * A printer saved with no address is skipped `DEVICE_NO_ADDRESS` on every job
 * (`adapterFor` in `printing/queue.ts`) — paper routed to it never comes out —
 * and an address outside this form is a socket the box cannot open. The box
 * reads a host as written, so a host here is a dotted IPv4 address or a host
 * name; the port, when written, is 1 to 65535.
 */

/** What a printer's address field says to fill in. */
export const PRINTER_ADDRESS_HINT =
  'The address the box prints to: 192.168.88.204:9100 for a printer on the park network, 127.0.0.1:9100 for a USB printer on the box.';

/** The port the box uses when an address names none. */
export const PRINTER_DEFAULT_PORT = 9100;

/** Whether a device of this kind prints, and so is reached at an address the box opens. */
export const isPrinterKind = (kind: string): boolean => kind.endsWith('printer');

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * The host and port the box opens for this address, exactly as its own
 * `parseAddress` reads it, or null when the box could not open it: nothing
 * written, a host that is neither a dotted IPv4 address nor a host name, or a
 * port that is not a whole number from 1 to 65535.
 */
export function parsePrinterAddress(address: string | null | undefined): { host: string; port: number } | null {
  const trimmed = address?.trim() ?? '';
  if (!trimmed) return null;
  const at = trimmed.lastIndexOf(':');
  const host = at < 0 ? trimmed : trimmed.slice(0, at);
  let port = PRINTER_DEFAULT_PORT;
  if (at >= 0) {
    const written = trimmed.slice(at + 1);
    if (!/^\d{1,5}$/.test(written)) return null;
    port = Number(written);
    if (port < 1 || port > 65535) return null;
  }
  if (!host || host.length > 253) return null;
  const labels = host.split('.');
  if (!labels.every((label) => LABEL.test(label))) return null;
  // All digits is an IPv4 address, and then it is four numbers up to 255.
  if (labels.every((label) => /^\d+$/.test(label))) {
    if (labels.length !== 4 || labels.some((label) => Number(label) > 255)) return null;
  }
  return { host, port };
}

/** Why an address will not do for a printer: none written, or not one the box can open. */
export type PrinterAddressProblem = 'missing' | 'invalid';

export function printerAddressProblem(address: string | null | undefined): PrinterAddressProblem | null {
  if (!address?.trim()) return 'missing';
  return parsePrinterAddress(address) ? null : 'invalid';
}

/** The sentence for each problem, the same in the Console and in the api's refusal. */
export function printerAddressWords(problem: PrinterAddressProblem): string {
  return problem === 'missing'
    ? 'A printer needs the address the box prints to: 192.168.88.204:9100 for a printer on the park network, 127.0.0.1:9100 for a USB printer on the box. Without one nothing prints on it.'
    : 'That is not an address the box can print to. Write it as 192.168.88.204:9100, the printer’s address and its port (9100 when left off).';
}
