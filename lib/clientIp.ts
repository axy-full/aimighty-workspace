/**
 * Where a request came from, for rate limits and lockouts, in one place.
 *
 * `X-Forwarded-For` is a list that every proxy APPENDS to: the client can
 * write whatever it likes at the left, and only the entries added by proxies
 * we run are true. Reading the leftmost entry (as every limit here once did)
 * lets a caller pick a fresh "address" per request, which turns a per-source
 * login throttle into unlimited guessing and lets anyone lock out someone
 * else's (address, email) pair. So the address is read as follows.
 *
 * - On Vercel (`VERCEL` set): exactly as before, the first `X-Forwarded-For`
 *   entry, then `X-Real-IP`, else "". Vercel's edge overwrites both headers
 *   with the connecting client's address and does not forward a client's own
 *   value, so the first entry is the client; the keys already stored there
 *   keep matching byte for byte.
 * - Behind our own proxy (`SELFHOST_BEHIND_PROXY=1`, never on Vercel):
 *   with `TRUST_CF_CONNECTING_IP=1`, Cloudflare's `CF-Connecting-IP` (set it
 *   only once the server answers Cloudflare alone, or anyone can send the
 *   header); otherwise the entry `TRUSTED_PROXY_HOPS` (default 1, at most 5)
 *   from the RIGHT of `X-Forwarded-For`, which is the peer the outermost
 *   trusted proxy saw. Next itself only fills the header when it is missing.
 *   Anything that is not an IPv4/IPv6 address is not trusted: those requests
 *   share the fixed bucket `UNATTRIBUTED`.
 * - Anywhere else (local, dev, tests, an unconfigured host): forwarded
 *   headers are the client's own words, so nothing is read and every request
 *   shares the fixed bucket `DIRECT`.
 *
 * A fixed bucket fails closed: a misconfigured proxy makes every caller share
 * one allowance (visible, and fixed by configuration) rather than giving each
 * request a fresh one.
 */
import { isIP } from "node:net";

type Env = Record<string, string | undefined>;

/** Not behind a configured proxy: forwarded headers are not trusted. */
export const DIRECT = "direct";
/** Behind the proxy, but the trusted entry is missing or not an address. */
export const UNATTRIBUTED = "unattributed";

const MAX_HOPS = 5;

/** The address when `value` is exactly one IPv4/IPv6 address, else null. */
function address(value: string | null | undefined): string | null {
  const v = value?.trim() ?? "";
  return v && v.length <= 64 && isIP(v) ? v.toLowerCase() : null;
}

/** `TRUSTED_PROXY_HOPS` as an integer 1..5 (unset or blank: 1); null when it is anything else. */
export function trustedProxyHops(env: Env = process.env): number | null {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 1;
  if (!/^[0-9]$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_HOPS ? n : null;
}

let warned = false;

/**
 * The fixed bucket behind the proxy, said once per process so a misconfigured host is visible in its logs. Names the
 * settings to check, never an address or a header value.
 */
function unattributed(): string {
  if (!warned) {
    warned = true;
    console.warn(
      "[client-ip] Behind the proxy, a request carried no usable client address, so rate limits are counting it in one " +
      "shared bucket. Check TRUSTED_PROXY_HOPS (a whole number 1-5, unset = 1), TRUST_CF_CONNECTING_IP (1 only behind " +
      "Cloudflare, which then must send CF-Connecting-IP), and that the proxy appends X-Forwarded-For. Shown once.",
    );
  }
  return UNATTRIBUTED;
}

/** The client's address for rate limiting (see above). Never empty except on Vercel, where it is exactly what it was. */
export function clientIp(req: { headers: Headers }, env: Env = process.env): string {
  const h = req.headers;
  if (env.VERCEL) {
    return h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "";
  }
  if (env.SELFHOST_BEHIND_PROXY !== "1") return DIRECT;
  if (env.TRUST_CF_CONNECTING_IP === "1") return address(h.get("cf-connecting-ip")) ?? unattributed();
  const hops = trustedProxyHops(env);
  if (hops === null) return unattributed();
  const chain = (h.get("x-forwarded-for") ?? "").split(",");
  return address(chain.length >= hops ? chain[chain.length - hops] : null) ?? unattributed();
}
