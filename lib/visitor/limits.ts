import type { Client } from "@libsql/client";
import { isIP } from "node:net";
import { createPlatformDatabaseClient } from "../localDatabaseClient";

/**
 * The visitor bar's limits (v30 Phase A, item 9): how often a visitor may ask, and how many questions the whole platform
 * answers in an hour. The hourly cap is the ceiling on what the bar can cost; the other limits keep one caller from
 * spending all of it. A question needs room in every one of them.
 *
 * Shared by every app process (production runs three, ops/selfhost/cluster.mjs DEFAULT_CONCURRENCY), and kept across
 * restarts, in the platform database (`visitor_bar_hits`):
 *  - the platform-wide cap, per clock hour;
 *  - the per-address cap, per clock hour, by a salted hash of the address (lib/clientIp.ts decides which address is
 *    true; an unconfigured host puts everyone in one bucket, which fails closed). IPv6 is counted per /64, the block one
 *    subscriber is given, so walking the addresses inside it buys nothing;
 *  - for IPv6, a cap per /48 as well (a site's block, many /64s), so walking the /64s inside it buys little.
 * Counted in clock-hour buckets and pruned in the same write, in the style of `underLimit` (lib/security/review-link.ts).
 * A clock hour, not a sliding one: around the turn of the hour a caller can use one hour's allowance at :59 and the
 * next at :00, so over any sixty minutes the most that can be asked is twice a cap (the platform's included). The
 * figures are set with that in mind.
 *
 * Per process, in memory (each process allows this much on its own, so with three processes it is up to three times
 * it, and a restart forgets it):
 *  - the per-visitor cap, by the bar's own cookie. A fairness limit only: dropping the cookie falls back on the
 *    address's and the platform's limits, which are shared;
 *  - the answers in flight at once (the route's).
 *
 * The table holds hour numbers, counts and salted hashes: no workspace, no person, no question.
 */

const HOUR = 60 * 60 * 1000;
type Env = Record<string, string | undefined>;

export type VisitorLimitConfig = { perVisitorHour: number; perAddressHour: number; perNetworkHour: number; platformHour: number; maxKeys: number };
export type VisitorAdmission = { ok: true } | { ok: false; scope: "visitor" | "address" | "network" | "platform"; retryAfterSeconds: number };

/** The defaults, each overridable by its setting's name (a whole number from 1 to 100000; anything else keeps the default). */
export const VISITOR_LIMIT_DEFAULTS: VisitorLimitConfig = { perVisitorHour: 10, perAddressHour: 30, perNetworkHour: 90, platformHour: 200, maxKeys: 20_000 };
const SETTINGS: Record<Exclude<keyof VisitorLimitConfig, "maxKeys">, string> = {
  perVisitorHour: "VISITOR_BAR_PER_VISITOR_HOUR",
  perAddressHour: "VISITOR_BAR_PER_ADDRESS_HOUR",
  perNetworkHour: "VISITOR_BAR_PER_NET48_HOUR",
  platformHour: "VISITOR_BAR_PLATFORM_HOUR",
};

export function visitorLimitConfig(env: Env = process.env): VisitorLimitConfig {
  const out = { ...VISITOR_LIMIT_DEFAULTS };
  for (const [field, name] of Object.entries(SETTINGS) as [keyof typeof SETTINGS, string][]) {
    const raw = env[name]?.trim();
    if (raw && /^\d{1,6}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 100_000) out[field] = Number(raw);
  }
  /* At most platformHour visitors are admitted in an hour, so with room for that many the map never forgets one who
     still has questions counted. */
  out.maxKeys = Math.max(out.maxKeys, out.platformHour + 1);
  return out;
}

/* ── The address, as it is counted ───────────────────────────────────────────────────────────── */

/** Eight full hextets of an IPv6 address, or null when it is not one. */
function hextets(ip: string): string[] | null {
  let text = ip.toLowerCase().split("%")[0];
  /* An embedded IPv4 tail (::ffff:203.0.113.7) as two hextets. */
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const parts = v4[2].split(".").map(Number);
    if (parts.some((part) => part > 255)) return null;
    text = `${v4[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  return all.length === 8 && all.every((part) => /^[0-9a-f]{1,4}$/.test(part)) ? all.map((part) => part.padStart(4, "0")) : null;
}

/**
 * What an address is counted as: an IPv4 address as itself, an IPv4-mapped IPv6 address as that IPv4 address, any other
 * IPv6 address as its /64. Anything else (the fixed buckets from lib/clientIp.ts) as it is.
 */
export function addressBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const parts = hextets(ip);
  if (!parts) return ip;
  if (parts.slice(0, 5).every((part) => part === "0000") && parts[5] === "ffff") {
    const [a, b] = [parseInt(parts[6], 16), parseInt(parts[7], 16)];
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return `${parts.slice(0, 4).join(":")}::/64`;
}

/** The IPv6 /48 an address is in, for the per-network cap; null for IPv4 (and IPv4-mapped) addresses and the fixed buckets. */
export function networkBucket(ip: string): string | null {
  if (isIP(ip) !== 6) return null;
  const counted = addressBucket(ip);
  if (!counted.endsWith("::/64")) return null;
  return `${counted.split(":").slice(0, 3).join(":")}::/48`;
}

/* ── Shared: the platform database ───────────────────────────────────────────────────────────── */

/**
 * The platform database, opened with the settings lib/platform.ts and lib/recovery.ts read (and, for a local file, the
 * same client cache), without importing lib/platform.ts, whose imports reach credits and the provider registry
 * (tests/unit/visitorBar.spec.ts walks them). Not wrapped in the recovery fence: a visitor's counter is not work the
 * recovery checkpoint waits for, so visitor traffic never leaves an "uncertain" record that could block it. A failed
 * read or write refuses the question (the route answers 503): the limits fail closed.
 *
 * MIGRATION: `visitor_bar_hits` is made on first use (CREATE TABLE IF NOT EXISTS, additive; nothing existing changes).
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS visitor_bar_hits (scope TEXT NOT NULL, bucket INTEGER NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, bucket, key))`,
  `CREATE INDEX IF NOT EXISTS idx_visitor_bar_hits_bucket ON visitor_bar_hits(bucket)`,
];
const clients = new Map<string, Client>();
const initialized = new WeakMap<Client, Promise<void>>();

export function visitorDatabase(env: Env = process.env): Client {
  const config = { url: env.PLATFORM_DATABASE_URL ?? env.TURSO_DATABASE_URL ?? "file:.data/ark.db", authToken: env.PLATFORM_AUTH_TOKEN ?? env.TURSO_AUTH_TOKEN };
  const key = JSON.stringify(config);
  let client = clients.get(key);
  if (!client) { client = createPlatformDatabaseClient(config); clients.set(key, client); }
  return client;
}

async function ready(client: Client): Promise<void> {
  if (!initialized.has(client)) {
    initialized.set(client, client.batch(SCHEMA, "write").then(() => undefined).catch((error) => { initialized.delete(client); throw error; }));
  }
  await initialized.get(client);
}

/**
 * Counts one question against the address's, the network's (IPv6 only) and the platform's allowance for this hour, all
 * or none, in one write: the platform row is raised only while every one of them has room, then the address row only
 * when the platform row was, then the network row only when the address row was (SQLite's `changes()`: the statement
 * just before, in the same batch). Earlier hours are pruned in the same write.
 */
export async function admitShared(addressKey: string, networkKey: string | null, config: VisitorLimitConfig = visitorLimitConfig(), at = Date.now(), client: Client = visitorDatabase()): Promise<VisitorAdmission> {
  await ready(client);
  const bucket = Math.floor(at / HOUR);
  const net = networkKey ?? "";
  const count = (scope: string) => `(SELECT count FROM visitor_bar_hits WHERE scope = '${scope}' AND bucket = ? AND key = ?)`;
  const results = await client.batch([
    { sql: `DELETE FROM visitor_bar_hits WHERE bucket < ?`, args: [bucket] },
    { sql: `INSERT OR IGNORE INTO visitor_bar_hits (scope, bucket, key, count) VALUES ('platform', ?, '', 0), ('address', ?, ?, 0)`, args: [bucket, bucket, addressKey] },
    ...(networkKey ? [{ sql: `INSERT OR IGNORE INTO visitor_bar_hits (scope, bucket, key, count) VALUES ('network', ?, ?, 0)`, args: [bucket, net] }] : []),
    {
      sql: `UPDATE visitor_bar_hits SET count = count + 1 WHERE scope = 'platform' AND bucket = ? AND key = '' AND count < ?
              AND ${count("address")} < ? AND (? = '' OR ${count("network")} < ?)`,
      args: [bucket, config.platformHour, bucket, addressKey, config.perAddressHour, net, bucket, net, config.perNetworkHour],
    },
    { sql: `UPDATE visitor_bar_hits SET count = count + 1 WHERE scope = 'address' AND bucket = ? AND key = ? AND changes() = 1`, args: [bucket, addressKey] },
    ...(networkKey ? [{ sql: `UPDATE visitor_bar_hits SET count = count + 1 WHERE scope = 'network' AND bucket = ? AND key = ? AND changes() = 1`, args: [bucket, net] }] : []),
    { sql: `SELECT ${count("platform")} AS platform, ${count("network")} AS network`, args: [bucket, "", bucket, net] },
  ], "write");
  const counts = results[results.length - 1].rows[0] ?? {};
  const raised = results.slice(networkKey ? 3 : 2, -1).every((result) => result.rowsAffected === 1);
  if (raised) return { ok: true };
  const retryAfterSeconds = Math.max(1, Math.ceil(((bucket + 1) * HOUR - at) / 1000));
  const scope = Number(counts.platform ?? 0) >= config.platformHour ? "platform" : networkKey && Number(counts.network ?? 0) >= config.perNetworkHour ? "network" : "address";
  return { ok: false, scope, retryAfterSeconds };
}

/* ── Per process: the visitor's cookie ───────────────────────────────────────────────────────── */

export class VisitorLimiter {
  private readonly visitors = new Map<string, number[]>();

  constructor(private readonly config: () => VisitorLimitConfig = visitorLimitConfig, private readonly clock: () => number = Date.now) {}

  /** Whether this visitor has room in the last hour (a sliding hour); takes nothing. */
  check(visitor: string): VisitorAdmission {
    const now = this.clock(), times = this.fresh(visitor, now);
    if (times.length < this.config().perVisitorHour) return { ok: true };
    return { ok: false, scope: "visitor", retryAfterSeconds: Math.max(1, Math.ceil((times[0] + HOUR - now) / 1000)) };
  }

  /** Counts one question for this visitor, once the shared limits admitted it. */
  take(visitor: string): void {
    const now = this.clock(), times = [...this.fresh(visitor, now), now], { maxKeys } = this.config();
    this.visitors.delete(visitor);
    this.visitors.set(visitor, times);
    /* Bounded: past the cap, the visitors who asked longest ago are forgotten first. */
    while (this.visitors.size > maxKeys) {
      const oldest = this.visitors.keys().next().value;
      if (oldest === undefined) break;
      this.visitors.delete(oldest);
    }
  }

  private fresh(visitor: string, now: number): number[] {
    return (this.visitors.get(visitor) ?? []).filter((at) => at > now - HOUR);
  }
}
