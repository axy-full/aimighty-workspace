/**
 * The visitor bar's limits (v30 Phase A, item 9): how often one visitor may ask, and how many questions the whole
 * platform answers in an hour. The hourly cap is the ceiling on what the bar can cost; the per-visitor limits keep one
 * caller from spending all of it.
 *
 * A visitor is counted twice, and must have room in both: by the bar's own cookie, and by a salted hash of the
 * address (lib/clientIp.ts decides which address is true; an unconfigured host puts everyone in one bucket, which
 * fails closed). Dropping the cookie therefore buys nothing. Nothing about the visitor is kept but the hashes and the
 * times they asked, for at most an hour, in this process's memory: no table, no workspace, nothing written.
 *
 * Per process: a deployment that runs several app processes multiplies the hourly cap by their number (see the PR's
 * security note). Pure apart from the clock, which tests pass in.
 */

const HOUR = 60 * 60 * 1000;

export type VisitorLimitConfig = { perVisitorHour: number; perAddressHour: number; platformHour: number; maxKeys: number };
export type VisitorAdmission = { ok: true } | { ok: false; scope: "visitor" | "address" | "platform"; retryAfterSeconds: number };

/** The defaults, each overridable by its setting's name (a whole number from 1 to 100000; anything else keeps the default). */
export const VISITOR_LIMIT_DEFAULTS: VisitorLimitConfig = { perVisitorHour: 10, perAddressHour: 30, platformHour: 200, maxKeys: 20_000 };
const SETTINGS: Record<Exclude<keyof VisitorLimitConfig, "maxKeys">, string> = {
  perVisitorHour: "VISITOR_BAR_PER_VISITOR_HOUR",
  perAddressHour: "VISITOR_BAR_PER_ADDRESS_HOUR",
  platformHour: "VISITOR_BAR_PLATFORM_HOUR",
};

export function visitorLimitConfig(env: Record<string, string | undefined> = process.env): VisitorLimitConfig {
  const out = { ...VISITOR_LIMIT_DEFAULTS };
  for (const [field, name] of Object.entries(SETTINGS) as [keyof typeof SETTINGS, string][]) {
    const raw = env[name]?.trim();
    if (raw && /^\d{1,6}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 100_000) out[field] = Number(raw);
  }
  return out;
}

export class VisitorLimiter {
  private readonly visitors = new Map<string, number[]>();
  private readonly addresses = new Map<string, number[]>();
  private platform: number[] = [];

  constructor(private readonly config: () => VisitorLimitConfig = visitorLimitConfig, private readonly clock: () => number = Date.now) {}

  /** Takes one question from each allowance when all three have room; takes nothing when any is full. */
  admit(visitor: string, address: string): VisitorAdmission {
    const now = this.clock(), since = now - HOUR, config = this.config();
    const fresh = (times: number[] | undefined) => (times ?? []).filter((at) => at > since);
    const wait = (times: number[]) => Math.max(1, Math.ceil((times[0] + HOUR - now) / 1000));
    this.platform = fresh(this.platform);
    const mine = fresh(this.visitors.get(visitor)), theirs = fresh(this.addresses.get(address));
    if (this.platform.length >= config.platformHour) return { ok: false, scope: "platform", retryAfterSeconds: wait(this.platform) };
    if (theirs.length >= config.perAddressHour) return { ok: false, scope: "address", retryAfterSeconds: wait(theirs) };
    if (mine.length >= config.perVisitorHour) return { ok: false, scope: "visitor", retryAfterSeconds: wait(mine) };
    this.platform.push(now);
    this.remember(this.visitors, visitor, [...mine, now], config.maxKeys);
    this.remember(this.addresses, address, [...theirs, now], config.maxKeys);
    return { ok: true };
  }

  /** Keeps the maps bounded: past the cap, the visitors who asked longest ago are forgotten first. */
  private remember(map: Map<string, number[]>, key: string, times: number[], maxKeys: number) {
    map.delete(key);
    map.set(key, times);
    while (map.size > maxKeys) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
