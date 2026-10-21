/**
 * The address classifier behind `netguard`, in a module with no imports so
 * `http` can use it without pulling `undici` (an optional peer dependency)
 * into every `createApiClient` consumer (fleet-audit#1450). Re-exported from
 * `@chrischall/mcp-utils/netguard`.
 */

// ---------------------------------------------------------------------------
// isPublicAddress
// ---------------------------------------------------------------------------

/**
 * Is this textual IP address one the public internet routes?
 *
 * `false` for everything else — and for anything that is not a well-formed
 * IPv4 dotted quad or IPv6 literal (a bracketed `[::1]`, a zone id
 * `fe80::1%eth0`, the `127.1` shorthand, a leading-zero octet such as
 * `012.0.0.1`, which a resolver may read as octal): a guard that admits what it does not
 * understand is the wrong default for this control.
 *
 * The ranges:
 *
 *   IPv4  0/8 this-network, 10/8 + 172.16/12 + 192.168/16 RFC 1918,
 *         100.64/10 CGNAT, 127/8 loopback, 169.254/16 link-local (the cloud
 *         metadata service), 192.0.0/24 protocol assignments, 192.0.2/24 +
 *         198.51.100/24 + 203.0.113/24 TEST-NET, 192.88.99/24 6to4 relay
 *         anycast, 198.18/15 benchmarking, 224/4 multicast, 240/4 reserved
 *         including broadcast.
 *   IPv6  ::/96 (unspecified, loopback, and the deprecated IPv4-compatible
 *         form — refused WHOLE, even around a public IPv4), 64:ff9b:1::/48
 *         local-use NAT64, 100::/64 discard, 2001::/32 Teredo, 2001:2::/48
 *         benchmarking, 2001:10::/28 + 2001:20::/28 ORCHID, 2001:db8::/32 +
 *         3fff::/20 documentation, 5f00::/16 SRv6, fc00::/7 ULA (Fly's 6PN
 *         `fdaa::/16` lives here), fe80::/10 link-local, fec0::/10
 *         site-local, ff00::/8 multicast.
 *   Embedded IPv4 — `::ffff:a.b.c.d` (mapped, what a dual-stack resolver
 *         returns for an A record), `::ffff:0:a.b.c.d` (SIIT), 64:ff9b::/96
 *         (NAT64) and 2002::/16 (6to4) — judged by the IPv4 they carry, so
 *         `::ffff:7f00:1` is loopback and `::ffff:8.8.8.8` is public.
 *
 * Consolidates accessoticketing-mcp `isPrivateAddress`, gemini-mcp
 * `isPrivateIpv4`/`isPrivateIpv6` and mcp-host `isPublicAddress`.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return isPublicIPv6(v6);
  return false;
}

/**
 * Four octets for a canonical dotted quad, else `undefined`. An octet with a
 * leading zero is refused: `inet_aton` and most libc resolvers read `012` as
 * OCTAL (10), so `012.0.0.1` may mean 10.0.0.1 — reading it as decimal 12
 * would admit a private address (fleet-audit#1298).
 */
function parseIPv4(text: string): number[] | undefined {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(text)) return undefined;
  const octets = text.split('.').map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

/** 16 bytes, or `undefined` for anything that is not a well-formed IPv6 literal. */
function parseIPv6(text: string): number[] | undefined {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(':')) return undefined;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (const [i, piece] of pieces.entries()) {
      if (i === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIPv4(piece);
        if (!v4) return undefined;
        const [a = 0, b = 0, c = 0, d = 0] = v4;
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (!head || !tail) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const words = [...head, ...new Array<number>(fill).fill(0), ...tail];
  const bytes: number[] = [];
  for (const w of words) bytes.push(w >> 8, w & 0xff);
  return bytes;
}

function inRange(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i += 1) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

const BLOCKED_V4: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0, 0, 0, 0], 8], // this network
  [[10, 0, 0, 0], 8], // RFC 1918
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, incl. cloud metadata
  [[172, 16, 0, 0], 12], // RFC 1918
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast (deprecated)
  [[192, 168, 0, 0], 16], // RFC 1918
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + broadcast
];

function isPublicIPv4(octets: readonly number[]): boolean {
  return !BLOCKED_V4.some(([prefix, bits]) => inRange(octets, prefix, bits));
}

const V6 = (hex: string): number[] => parseIPv6(hex) as number[];
const BLOCKED_V6: ReadonlyArray<readonly [readonly number[], number]> = [
  [V6('::'), 96], // ::, ::1 and the deprecated IPv4-compatible form, refused whole
  [V6('64:ff9b:1::'), 48], // local-use NAT64 (RFC 8215)
  [V6('100::'), 64], // discard-only
  [V6('2001::'), 32], // Teredo
  [V6('2001:2::'), 48], // benchmarking
  [V6('2001:10::'), 28], // ORCHID (deprecated)
  [V6('2001:20::'), 28], // ORCHIDv2
  [V6('2001:db8::'), 32], // documentation
  [V6('3fff::'), 20], // documentation (RFC 9637)
  [V6('5f00::'), 16], // SRv6 SIDs
  [V6('fc00::'), 7], // unique local
  [V6('fe80::'), 10], // link-local
  [V6('fec0::'), 10], // site-local (deprecated)
  [V6('ff00::'), 8], // multicast
];
const MAPPED_V4 = V6('::ffff:0:0');
const SIIT_V4 = V6('::ffff:0:0:0');
const NAT64 = V6('64:ff9b::');
const SIX_TO_FOUR = V6('2002::');

function isPublicIPv6(bytes: readonly number[]): boolean {
  if (inRange(bytes, MAPPED_V4, 96) || inRange(bytes, SIIT_V4, 96) || inRange(bytes, NAT64, 96)) {
    return isPublicIPv4(bytes.slice(12, 16));
  }
  if (inRange(bytes, SIX_TO_FOUR, 16)) return isPublicIPv4(bytes.slice(2, 6));
  return !BLOCKED_V6.some(([prefix, bits]) => inRange(bytes, prefix, bits));
}
