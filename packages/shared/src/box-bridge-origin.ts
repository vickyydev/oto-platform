/** Only a DNS child of the configured box zone may receive a staff credential. */
export function trustedBoxBridgeOrigin(
  value: string | null | undefined,
  zone: string | null | undefined,
  allowLocalHttp = false,
): string | null {
  if (!value || !zone) return null;
  const dnsName = (name: string) => name.length <= 253
    && name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    && !/^[0-9.]+$/.test(name);
  if (!dnsName(zone) || (!zone.includes('.') && !(allowLocalHttp && zone === 'localhost'))) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (value !== url.origin && value !== `${url.origin}/`) return null;
  const host = url.hostname;
  // URL normalizes decimal/hex/short IPv4 before this check. IPv6 has brackets.
  if (!dnsName(host) || !host.endsWith(`.${zone.toLowerCase()}`)) return null;
  const local = host.endsWith('.localhost');
  if (local && !allowLocalHttp) return null;
  if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) return null;
  return url.origin;
}
