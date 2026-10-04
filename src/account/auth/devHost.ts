/**
 * DEV ONLY (see docs/PRODUCTION_CHECKLIST.md). Which page addresses the real-database test login (`realtest`) may run on:
 * this computer (localhost / loopback) and a private network (home Wi-Fi: 10.x, 172.16–31.x, 192.168.x, *.local), so the
 * flow can be tried on a phone. Anything else — any public name or public IP — is refused.
 *
 * Imported only by `testMemberAuth.ts`, which only a `VITE_CUSTOMER_AUTH=realtest` dev-server build contains, so this
 * allowance does not exist in any normal build. It is a second belt: `vite.config.ts` already refuses to build `realtest`.
 */
export function isDevHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "") return false;
  if (host === "localhost" || host === "::1") return true;
  if (/^[a-z0-9-]+\.local$/.test(host)) return true; // mDNS names of machines on the local network

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false; // a real domain name (including look-alikes such as 192.168.1.1.evil.com)
  const [a, b, c, d] = octets.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 127) return true; // loopback
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
