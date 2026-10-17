import type { Client } from "@libsql/client";
import { isIP } from "node:net";
import { createPlatformDatabaseClient } from "../localDatabaseClient";

/**
 * The visitor bar's limits (v30 Phase A, item 9). The owner's figures (17 Oct 2026): 20 messages per visitor per day,
 * and 2,000 messages a day across the site; the per-address and per-/48 caps are proposals in the same unit. A day is a
 * UTC calendar day. A question needs room in every one of them, and is counted against all of them or none.
 *
 * All four are shared by every app process (production runs three, ops/selfhost/cluster.mjs DEFAULT_CONCURRENCY) and
 * kept across restarts, in the platform database (`visitor_bar_hits`), counted in UTC-day buckets and pruned in the same
 * write, in the style of `underLimit` (lib/security/review-link.ts):
 *  - per visitor, by a salted hash of the bar's own cookie (a fairness limit: dropping the cookie falls back on the
 *    address's and the site's);
 *  - per address, by a salted hash of the address (lib/clientIp.ts decides which address is true; an unconfigured host
 *    puts everyone in one bucket, which fails closed). IPv6 is counted per /64, the block one subscriber is given;
 *  - for IPv6, per /48 as well (a site's block, many /64s), so walking the /64s inside it buys little;
 *  - the whole site: the ceiling on what the bar can cost.
 * A calendar day, not a sliding one: around midnight UTC a caller can use one day's allowance at 23:59 and the next
 * day's at 00:00, so over any twenty-four hours the most that can be asked is twice a cap (the site's included).
 *
 * Per process, in memory: only the answers in flight at once (the route's).
 *
 * The table holds day numbers, counts and salted hashes: no workspace, no person, no question. It holds only today's
 * rows, and only rows that counted a question: at most one per visitor, address and /48 admitted today, plus the site's.
 */

const DAY = 24 * 60 * 60 * 1000;
type Env = Record<string, string | undefined>;

export type VisitorLimitConfig = { perVisitorDay: number; perAddressDay: number; perNetworkDay: number; platformDay: number };
export type VisitorLimitScope = "visitor" | "address" | "network" | "platform";
export type VisitorAdmission = { ok: true } | { ok: false; scope: VisitorLimitScope; retryAfterSeconds: number };

/** The defaults, each overridable by its setting's name (a whole number from 1 to 1000000; anything else keeps the default). */
export const VISITOR_LIMIT_DEFAULTS: VisitorLimitConfig = { perVisitorDay: 20, perAddressDay: 60, perNetworkDay: 180, platformDay: 2000 };
const SETTINGS: Record<keyof VisitorLimitConfig, string> = {
  perVisitorDay: "VISITOR_BAR_PER_VISITOR_DAY",
  perAddressDay: "VISITOR_BAR_PER_ADDRESS_DAY",
  perNetworkDay: "VISITOR_BAR_PER_NET48_DAY",
  platformDay: "VISITOR_BAR_PLATFORM_DAY",
};

export function visitorLimitConfig(env: Env = process.env): VisitorLimitConfig {
  const out = { ...VISITOR_LIMIT_DEFAULTS };
  for (const [field, name] of Object.entries(SETTINGS) as [keyof VisitorLimitConfig, string][]) {
    const raw = env[name]?.trim();
    if (raw && /^\d{1,7}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 1_000_000) out[field] = Number(raw);
  }
  return out;
}

/** Seconds until the next UTC midnight, when every allowance starts again. */
export function secondsToNextDay(at: number): number {
  return Math.max(1, Math.ceil(((Math.floor(at / DAY) + 1) * DAY - at) / 1000));
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
 * Its `bucket` is a UTC day number.
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
 * Counts one question against the visitor's, the address's, the network's (IPv6 only) and the site's allowance for
 * this UTC day, all or none, in one write: the site's row is raised only while every one of them has room, then each
 * other row only when the row before it was (SQLite's `changes()`: the statement just before, in the same batch).
 * Earlier days are pruned in the same write, and so are this request's own rows when it was refused and they still
 * count nothing: a refused request (a cookieless script, say) leaves no row behind, so the table holds only what was
 * actually counted today.
 */
export async function admitShared(keys: { visitor: string; address: string; network: string | null }, config: VisitorLimitConfig = visitorLimitConfig(), at = Date.now(), client: Client = visitorDatabase()): Promise<VisitorAdmission> {
  await ready(client);
  const bucket = Math.floor(at / DAY);
  const net = keys.network ?? "";
  const count = (scope: VisitorLimitScope) => `(SELECT count FROM visitor_bar_hits WHERE scope = '${scope}' AND bucket = ? AND key = ?)`;
  const rows: [VisitorLimitScope, string][] = [["visitor", keys.visitor], ["address", keys.address], ...(keys.network ? [["network", net] as [VisitorLimitScope, string]] : [])];
  const results = await client.batch([
    { sql: `DELETE FROM visitor_bar_hits WHERE bucket < ?`, args: [bucket] },
    { sql: `INSERT OR IGNORE INTO visitor_bar_hits (scope, bucket, key, count) VALUES ('platform', ?, '', 0)`, args: [bucket] },
    ...rows.map(([scope, key]) => ({ sql: `INSERT OR IGNORE INTO visitor_bar_hits (scope, bucket, key, count) VALUES (?, ?, ?, 0)`, args: [scope, bucket, key] })),
    {
      sql: `UPDATE visitor_bar_hits SET count = count + 1 WHERE scope = 'platform' AND bucket = ? AND key = '' AND count < ?
              AND ${count("visitor")} < ? AND ${count("address")} < ? AND (? = '' OR ${count("network")} < ?)`,
      args: [bucket, config.platformDay, bucket, keys.visitor, config.perVisitorDay, bucket, keys.address, config.perAddressDay, net, bucket, net, config.perNetworkDay],
    },
    ...rows.map(([scope, key]) => ({ sql: `UPDATE visitor_bar_hits SET count = count + 1 WHERE scope = ? AND bucket = ? AND key = ? AND changes() = 1`, args: [scope, bucket, key] })),
    /* Refused: this request's own rows that still count nothing go again (by primary key), the site's row included. */
    {
      sql: `DELETE FROM visitor_bar_hits WHERE bucket = ? AND count = 0
              AND ((scope = 'platform' AND key = '') OR (scope = 'visitor' AND key = ?) OR (scope = 'address' AND key = ?) OR (scope = 'network' AND key = ?))`,
      args: [bucket, keys.visitor, keys.address, net],
    },
    { sql: `SELECT ${count("platform")} AS platform, ${count("visitor")} AS visitor, ${count("network")} AS network`, args: [bucket, "", bucket, keys.visitor, bucket, net] },
  ], "write");
  /* The site's raise and each scope row's: the statements after the inserts, before the clean-up and the read. */
  const raised = results.slice(2 + rows.length, 3 + 2 * rows.length);
  if (raised.every((result) => result.rowsAffected === 1)) return { ok: true };
  const counts = results[results.length - 1].rows[0] ?? {};
  const scope: VisitorLimitScope = Number(counts.platform ?? 0) >= config.platformDay ? "platform"
    : Number(counts.visitor ?? 0) >= config.perVisitorDay ? "visitor"
    : keys.network && Number(counts.network ?? 0) >= config.perNetworkDay ? "network" : "address";
  return { ok: false, scope, retryAfterSeconds: secondsToNextDay(at) };
}
