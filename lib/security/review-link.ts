import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { db, ready, now, id as newId } from "../db";
import { clientIp } from "../clientIp";
import { mintShare, type Share } from "../shares";

/**
 * The Crew review client link (Gaps A, "Copy client link" and the client's view): one production's review set,
 * opened without signing in, where the client may approve a take or ask for changes and comment, and nothing else.
 *
 * The link itself is the existing client review link (lib/shares.ts): a random secret stored only as a hash in the
 * platform database, scoped to one workspace and one production, with an expiry, revocable at once. What this file
 * adds lives in that workspace's own database, in tables made on first use (additive; nothing existing changes):
 *
 * - `review_link_scopes`: which links open the review set ("review"). A link without a row is an older link and
 *   keeps opening the Approved takes only, exactly as before.
 * - `review_verdicts`: what a client decided on a take, kept beside the team's own review state, never written over
 *   it: a client's Approve tells the production, and a person on the team still approves the take.
 * - `review_link_hits`: a per-link counter, so a link that leaks can't be used to flood the production.
 *
 * Every read here takes the production from the stored link, never from the request, and every write checks the
 * take is in that link's set. Nothing here reads balances, other productions, the workspace's people or settings.
 */
export type LinkScope = "approved" | "review";
export type Verdict = "approved" | "changes";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS review_link_scopes (share_id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS review_verdicts (
    id TEXT PRIMARY KEY, gen_id TEXT NOT NULL, share_id TEXT NOT NULL, guest TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS review_verdicts_gen ON review_verdicts(gen_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS review_link_hits (share_id TEXT NOT NULL, bucket INTEGER NOT NULL, client TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(share_id, bucket, client))`,
];

const initialized = new WeakMap<Client, Promise<void>>();
export async function reviewLinksReady(): Promise<void> {
  await ready();
  const client = db();
  if (!initialized.has(client)) {
    initialized.set(client, client.batch(SCHEMA, "write").then(() => undefined).catch((error) => { initialized.delete(client); throw error; }));
  }
  await initialized.get(client);
}

/** Marks a link as a Crew review link, for the team's list (what it opens is fixed by the link itself: lib/shares.ts). */
export async function markReviewLink(shareId: string): Promise<void> {
  await reviewLinksReady();
  await db().execute({ sql: `INSERT OR IGNORE INTO review_link_scopes (share_id, scope, created_at) VALUES (?, 'review', ?)`, args: [shareId, now()] });
}

/**
 * Makes a Crew review client link (review of #558, L4). What it opens is decided by the one write that makes it (the
 * secret's hash is namespaced, lib/shares.ts), so it can never open as an older link, here or on an older build. The
 * team's list entry is written first, under the id the link will have; if the link's write then fails, that entry
 * names no link and lists nothing.
 */
export async function mintReviewLink(input: { workspaceId: string; projectId: string; by: string; actorId?: string; days?: number }): Promise<{ share: Share; token: string }> {
  const id = newId("shr");
  await markReviewLink(id);
  return mintShare({ ...input, label: "Crew review", neutral: true, id });
}

export async function scopeOf(shareId: string): Promise<LinkScope> {
  await reviewLinksReady();
  const rs = await db().execute({ sql: `SELECT scope FROM review_link_scopes WHERE share_id = ? LIMIT 1`, args: [shareId] });
  return rs.rows[0]?.scope === "review" ? "review" : "approved";
}

/* ── Rate limits ─────────────────────────────────────────────────────────── */

/**
 * Writes (decisions and comments) per Crew review link, per client, per ten minutes (review of #558, L3). Counted per
 * client, so a copy of a leaked link can't use up the real client's allowance; reads are never limited, so nobody is
 * locked out of looking. Older links are not counted at all, as before (L1). Old windows are pruned as new ones fill.
 */
export const WINDOW_MS = 10 * 60_000;
export const LIMITS = { write: 30 } as const;

/**
 * A client, as a link sees them: a salted one-way digest of where they connect from, never stored in the clear.
 * Salted with the same secret, and the same fallback, as `sourceKey` in lib/auth.ts (review of #558, L-C): unsalted,
 * a digest of `share:ip` could be reversed by trying every IPv4 address. Rows counted under the older, unsalted key
 * are simply never matched again and age out of the rate window, pruned as new windows fill (`underLimit`).
 */
export function clientKey(req: { headers: Headers }, shareId: string): string {
  const ip = clientIp(req) || "unknown";
  const salt = process.env.SESSION_SECRET ?? process.env.TURSO_AUTH_TOKEN ?? "particl";
  return createHash("sha256").update(`${salt}:review-link:${shareId}:${ip}`).digest("hex").slice(0, 24);
}

/** Counts one write by this client; false when they are over the limit for this window. */
export async function underLimit(shareId: string, client: string, at = now()): Promise<boolean> {
  await reviewLinksReady();
  const bucket = Math.floor(at / WINDOW_MS);
  const [, counted] = await db().batch([
    { sql: `DELETE FROM review_link_hits WHERE bucket < ?`, args: [bucket - 1] },
    {
      sql: `INSERT INTO review_link_hits (share_id, bucket, client, count) VALUES (?, ?, ?, 1)
            ON CONFLICT(share_id, bucket, client) DO UPDATE SET count = count + 1 RETURNING count`,
      args: [shareId, bucket, client],
    },
  ], "write");
  return Number(counted.rows[0]?.count ?? 1) <= LIMITS.write;
}

/* ── The set ─────────────────────────────────────────────────────────────── */

/** A take is in a link's set: this production's, finished, not deleted, and Approved (or, for a review link, waiting for review). */
const IN_SET = (scope: LinkScope) =>
  `g.project_id = ? AND g.deleted = 0 AND g.status = 'succeeded' AND ${scope === "review" ? "g.review_state IN ('picked','approved')" : "g.review_state = 'approved'"}`;

export async function takeInSet(scope: LinkScope, projectId: string, genId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(genId)) return false;
  const rs = await db().execute({ sql: `SELECT 1 FROM generations g WHERE g.id = ? AND ${IN_SET(scope)} LIMIT 1`, args: [genId, projectId] });
  return rs.rows.length > 0;
}

export type ClientNote = { text: string; author: string; guest: boolean; at: number };
export type ClientTake = {
  id: string; kind: string; shot: string | null; title: string | null; version: number;
  /** The team's state: "approved", or "review" while it waits for a decision. */
  state: "approved" | "review";
  /** What a client decided through this production's links, newest last; null when nobody has. */
  verdict: { verdict: Verdict; guest: string; at: number } | null;
  media: string; notes: ClientNote[];
};

/**
 * A review link's set, as the client sees it: the takes, in shot order, with the comments on each. The team's notes
 * are signed "The production" (no person's name leaves the workspace); a client's carry the name they gave.
 */
export async function reviewSet(token: string, shareId: string, projectId: string): Promise<{ production: { name: string }; takes: ClientTake[] } | null> {
  await reviewLinksReady();
  const project = await db().execute({ sql: `SELECT name FROM projects WHERE id = ? LIMIT 1`, args: [projectId] });
  if (!project.rows.length) return null;
  const takes = await db().execute({
    sql: `SELECT g.id, g.kind, g.version, g.review_state, s.code AS shot_code, s.title AS shot_title
          FROM generations g LEFT JOIN shots s ON s.id = g.shot_id
          WHERE ${IN_SET("review")}
          ORDER BY COALESCE(s.position, 1e9), s.code, g.version, g.created_at LIMIT 200`,
    args: [projectId],
  });
  const ids = takes.rows.map((r) => String(r.id));
  const marks = ids.map(() => "?").join(",");
  /* What this link's client sees (review of #558, L2): their own link's comments and decisions, and the team's
     decisions (each take's state). Never another client's words or name, and never the team's own notes. */
  const [notes, verdicts] = ids.length ? await Promise.all([
    db().execute({ sql: `SELECT gen_id, text, created_at, guest FROM review_notes WHERE share_id = ? AND gen_id IN (${marks}) ORDER BY created_at LIMIT 2000`, args: [shareId, ...ids] }),
    db().execute({ sql: `SELECT gen_id, verdict, guest, created_at FROM review_verdicts WHERE share_id = ? AND gen_id IN (${marks}) ORDER BY created_at`, args: [shareId, ...ids] }),
  ]) : [{ rows: [] }, { rows: [] }];
  const byGen = new Map<string, ClientNote[]>();
  for (const n of notes.rows) {
    const list = byGen.get(String(n.gen_id)) ?? [];
    list.push({ text: String(n.text), author: String(n.guest || "The client"), guest: true, at: Number(n.created_at) });
    byGen.set(String(n.gen_id), list);
  }
  const lastVerdict = new Map<string, ClientTake["verdict"]>();
  for (const v of verdicts.rows) lastVerdict.set(String(v.gen_id), { verdict: v.verdict === "approved" ? "approved" : "changes", guest: String(v.guest), at: Number(v.created_at) });
  return {
    production: { name: String(project.rows[0].name ?? "") },
    takes: takes.rows.map((r) => ({
      id: String(r.id), kind: String(r.kind), shot: r.shot_code ? String(r.shot_code) : null, title: r.shot_title ? String(r.shot_title) : null,
      version: Number(r.version ?? 1), state: r.review_state === "approved" ? "approved" : "review",
      verdict: lastVerdict.get(String(r.id)) ?? null,
      media: `/api/review/${token}/media/${r.id}`, notes: byGen.get(String(r.id)) ?? [],
    })),
  };
}

const cleanName = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60) : "") || "The client";

/** A client's decision on a take in the link's set, with an optional comment. False when the take is not in the set. */
export async function recordVerdict(input: { shareId: string; projectId: string; genId: string; verdict: unknown; name: unknown; text: unknown; client?: string }): Promise<{ ok: true; guest: string } | { ok: false; status: number; error: string }> {
  if (input.verdict !== "approved" && input.verdict !== "changes") return { ok: false, status: 400, error: "Approve, or ask for changes." };
  await reviewLinksReady();
  if (input.client && !(await underLimit(input.shareId, input.client))) return { ok: false, status: 429, error: "Too many changes from here. Wait a few minutes and try again." };
  if (!(await takeInSet("review", input.projectId, input.genId))) return { ok: false, status: 404, error: "Not part of this review." };
  const guest = cleanName(input.name);
  const text = typeof input.text === "string" ? input.text.trim().slice(0, 2000) : "";
  const at = now();
  await db().batch([
    { sql: `INSERT INTO review_verdicts (id, gen_id, share_id, guest, verdict, created_at) VALUES (?,?,?,?,?,?)`, args: [newId("rvd"), input.genId, input.shareId, guest, input.verdict, at] },
    ...(text ? [{ sql: `INSERT INTO review_notes (id, gen_id, share_id, guest, text, created_at) VALUES (?,?,?,?,?,?)`, args: [newId("rnote"), input.genId, input.shareId, guest, text, at] }] : []),
  ], "write");
  return { ok: true, guest };
}

/* ── For the team (Crew review) ───────────────────────────────────────────── */

export type ClientSaid = { genId: string; shot: string | null; version: number; guest: string; verdict: Verdict | null; text: string | null; at: number };

/** What clients said through this production's links, newest first: decisions and comments. */
export async function clientResponses(projectId: string, shareIds: string[]): Promise<ClientSaid[]> {
  if (!shareIds.length) return [];
  await reviewLinksReady();
  const marks = shareIds.map(() => "?").join(",");
  const rs = await db().execute({
    sql: `SELECT x.gen_id, x.guest, x.verdict, x.text, x.created_at, g.version, s.code AS shot_code FROM (
            SELECT gen_id, guest, verdict, NULL AS text, created_at FROM review_verdicts WHERE share_id IN (${marks})
            UNION ALL
            SELECT gen_id, guest, NULL AS verdict, text, created_at FROM review_notes WHERE share_id IN (${marks})
          ) x JOIN generations g ON g.id = x.gen_id LEFT JOIN shots s ON s.id = g.shot_id
          WHERE g.project_id = ? ORDER BY x.created_at DESC LIMIT 50`,
    args: [...shareIds, ...shareIds, projectId],
  });
  /* A decision and the comment sent with it are one thing the client said: same take, same name, same moment. */
  const out: ClientSaid[] = [];
  for (const r of rs.rows) {
    const row: ClientSaid = {
      genId: String(r.gen_id), shot: r.shot_code ? String(r.shot_code) : null, version: Number(r.version ?? 1), guest: String(r.guest || "The client"),
      verdict: r.verdict === "approved" ? "approved" : r.verdict === "changes" ? "changes" : null, text: r.text == null ? null : String(r.text), at: Number(r.created_at),
    };
    const twin = out.find((o) => o.genId === row.genId && o.guest === row.guest && o.at === row.at && (o.verdict == null) !== (row.verdict == null));
    if (twin) { twin.verdict ??= row.verdict; twin.text ??= row.text; } else out.push(row);
  }
  return out;
}
