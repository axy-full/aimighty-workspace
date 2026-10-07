import type { InStatement } from "@libsql/client";
import { db, ready } from "./db";
import { isHouseWorkspace } from "./houseWorkspace";
import { platformDb, platformReady } from "./platform";
import {
  isOwnerAddress, isOwnerIdentity, platformOwnerIdentity, SUPPORT_ACTOR, SUPPORT_MIRROR_DOMAIN, type PlatformOwnerIdentity,
} from "./platformOwnerPrivacy";
import { currentTenant } from "./tenant";
import { collabConfigured } from "./collab";
import { canvasOpsReady, insertCanvasOp } from "./workbench/canvas-ops-log";
import type { NodeChange } from "./workbench/canvas-ops-model";

/**
 * Rewrites what a client workspace stored about the platform owner before
 * the rule (lib/platformOwnerPrivacy.ts), so it reads "Particl support".
 *
 * Never automatic. A platform-admin route runs it (app/api/admin/
 * owner-privacy/route.ts): a dry run first, reporting what it would change
 * column by column, and the rewrite only when the platform owner confirms
 * that count. It touches only the workspace in scope — its own database, and
 * its own rows of the platform's share table — never another. And it runs
 * only on the production deployment, or off Vercel with an explicit opt-in
 * (`scrubAllowedHere`, OWNER_PRIVACY_SCRUB_LOCAL=1): on a
 * preview or staging deployment a restored workspace row can name a
 * production database, so even the workspace in scope may not be its own.
 *
 * Matching, per column: by the owner's account id where the table stores
 * one; otherwise by the owner's exact address (or a removed member's
 * "<address>#deleted-<ts>"); otherwise by the owner's exact name, and only
 * where no other member of this workspace goes by that name. A name shared
 * with another member is skipped and counted as ambiguous.
 */

/** `changed`: rows that changed between the read and the write, left as they are ("changed, run again"). */
export type ScrubLine = { store: "workspace" | "platform"; table: string; column: string; matched: number; ambiguous: number; changed?: number };
export type ScrubReport = { workspaceId: string; applied: boolean; lines: ScrubLine[]; total: number; ambiguous: number; changed?: number; note?: string };

type Clause = { sql: string; args: (string | number)[] };
type Row = Record<string, unknown>;

const missing = (error: unknown) => /no such (table|column)/i.test(String(error));
const or = (parts: (Clause | null)[]): Clause | null => {
  const kept = parts.filter((p): p is Clause => Boolean(p));
  return kept.length ? { sql: `(${kept.map((p) => p.sql).join(" OR ")})`, args: kept.flatMap((p) => p.args) } : null;
};

/** The owner's address in `col`: exact (case aside), or as a removed member's mangled address. Exact prefix, no LIKE. */
function addressIn(col: string, identity: PlatformOwnerIdentity): Clause | null {
  if (!identity.email) return null;
  const prefix = `${identity.email}#deleted-`;
  return { sql: `(LOWER(${col}) = ? OR substr(LOWER(${col}), 1, ?) = ?)`, args: [identity.email, prefix.length, prefix] };
}
function idIn(col: string, identity: PlatformOwnerIdentity): Clause | null {
  if (!identity.accountIds.length) return null;
  return { sql: `${col} IN (${identity.accountIds.map(() => "?").join(",")})`, args: identity.accountIds };
}
function namesIn(col: string, names: string[]): Clause | null {
  if (!names.length) return null;
  return { sql: `${col} IN (${names.map(() => "?").join(",")})`, args: names };
}

/**
 * Where the rewrite may run: the production deployment; or off Vercel
 * (local, CI, tests) only when OWNER_PRIVACY_SCRUB_LOCAL=1 says so, since a
 * local machine can be pointed at production databases too. Never a preview
 * or staging deployment: a workspace row restored there can name a
 * production database, and a rewrite would reach it.
 */
export function scrubAllowedHere(env: Record<string, string | undefined> = process.env): boolean {
  const onVercel = Boolean(env.VERCEL || env.VERCEL_ENV);
  return onVercel ? env.VERCEL_ENV === "production" : env.OWNER_PRIVACY_SCRUB_LOCAL === "1";
}
export const SCRUB_REFUSED = "This runs only on the production deployment (or locally with OWNER_PRIVACY_SCRUB_LOCAL=1): a preview or staging copy can hold workspace rows that point at production databases.";

/** Dry run (apply: false) or rewrite (apply: true) for the workspace in scope. */
export async function platformOwnerScrub(opts: {
  apply: boolean; identity?: PlatformOwnerIdentity;
  /** For tests: runs between the read and the write, as a teammate's save could. */
  beforeWrite?: () => Promise<void>;
}): Promise<ScrubReport> {
  const ws = currentTenant()?.workspace;
  if (!ws) throw new Error("No workspace in scope.");
  if (isHouseWorkspace(ws)) throw new Error("The house workspace keeps the platform owner's name.");
  if (!scrubAllowedHere()) throw new Error(SCRUB_REFUSED);
  await Promise.all([ready(), platformReady()]);
  const identity = opts.identity ?? (await platformOwnerIdentity());
  const tenant = db();

  // A name is the owner's only where nobody else here goes by it.
  const others = new Set<string>();
  for (const r of (await tenant.execute("SELECT id, email, name FROM users")).rows as Row[]) {
    if (!isOwnerIdentity(identity, { id: r.id, email: r.email })) others.add(String(r.name ?? "").trim());
  }
  const ownerNames = [...new Set((identity.names ?? []).map((n) => n.trim()).filter((n) => n && n !== SUPPORT_ACTOR))];
  const unique = ownerNames.filter((n) => !others.has(n));
  const shared = ownerNames.filter((n) => others.has(n));

  const lines: ScrubLine[] = [];
  const writes: InStatement[] = [];
  const platformWrites: InStatement[] = [];

  async function column(input: {
    store?: "workspace" | "platform"; table: string; column: string;
    match: Clause | null; ambiguous?: Clause | null; scope?: Clause; set?: Clause;
  }) {
    const exec = input.store === "platform" ? platformDb() : tenant;
    const scope = input.scope ? `${input.scope.sql} AND ` : "";
    const scopeArgs = input.scope?.args ?? [];
    const notYet = `"${input.column}" <> ?`;
    const count = async (c: Clause | null | undefined) => {
      if (!c) return 0;
      const rs = await exec.execute({ sql: `SELECT COUNT(*) AS n FROM ${input.table} WHERE ${scope}${c.sql} AND ${notYet}`, args: [...scopeArgs, ...c.args, SUPPORT_ACTOR] });
      return Number((rs.rows[0] as Row)?.n ?? 0);
    };
    try {
      const matched = await count(input.match);
      const ambiguous = await count(input.ambiguous);
      lines.push({ store: input.store ?? "workspace", table: input.table, column: input.column, matched, ambiguous });
      if (matched && input.match) {
        const set = input.set ?? { sql: `"${input.column}" = ?`, args: [SUPPORT_ACTOR] };
        (input.store === "platform" ? platformWrites : writes).push({
          sql: `UPDATE ${input.table} SET ${set.sql} WHERE ${scope}${input.match.sql} AND ${notYet}`,
          args: [...set.args, ...scopeArgs, ...input.match.args, SUPPORT_ACTOR],
        });
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  // The member row itself: by account id or address, unless already written as support.
  await column({
    table: "users", column: "email",
    match: (() => {
      const who = or([idIn("id", identity), addressIn("email", identity)]);
      return who ? { sql: `${who.sql} AND substr(LOWER(email), -?) <> ?`, args: [...who.args, SUPPORT_MIRROR_DOMAIN.length + 1, `@${SUPPORT_MIRROR_DOMAIN}`] } : null;
    })(),
    set: { sql: "name = ?, email = id || ?", args: [SUPPORT_ACTOR, `@${SUPPORT_MIRROR_DOMAIN}`] },
  });
  // Names written at the time of an action.
  for (const col of ["review_by", "picked_by", "approved_by"]) {
    await column({ table: "generations", column: col, match: or([addressIn(col, identity), namesIn(col, unique)]), ambiguous: namesIn(col, shared) });
  }
  await column({ table: "treatments", column: "updated_by", match: or([addressIn("updated_by", identity), namesIn("updated_by", unique)]), ambiguous: namesIn("updated_by", shared) });
  // A treatment's kept drafts carry who wrote each ("by" is a keyword, so quoted).
  await column({ table: "treatment_versions", column: "by", match: or([addressIn('"by"', identity), namesIn('"by"', unique)]), ambiguous: namesIn('"by"', shared) });
  // Addresses (or the account id) written as who locked or bound something.
  await column({ table: "elements", column: "locked_by", match: or([addressIn("locked_by", identity), idIn("locked_by", identity)]) });
  await column({ table: "bindings", column: "created_by", match: or([addressIn("created_by", identity), idIn("created_by", identity)]) });
  // Lock history keeps the account id beside the name.
  await column({ table: "element_lock_events", column: "by_name", match: or([idIn("by_user", identity), addressIn("by_name", identity)]) });
  // Review and share links: the platform's table, this workspace's rows only.
  await column({
    store: "platform", table: "p_shares", column: "created_by",
    scope: { sql: "workspace_id = ?", args: [ws.id] },
    match: or([addressIn("created_by", identity), namesIn("created_by", unique)]), ambiguous: namesIn("created_by", shared),
  });

  // Names mentioned in notes, stored as a JSON list.
  try {
    let matched = 0, ambiguous = 0;
    const wanted = [...unique, ...shared];
    if (wanted.length) {
      const rs = await tenant.execute({
        sql: `SELECT id, mentions FROM notes WHERE ${wanted.map(() => "instr(mentions, ?) > 0").join(" OR ")}`,
        args: wanted.map((n) => JSON.stringify(n)),
      });
      for (const r of rs.rows as Row[]) {
        let list: unknown;
        try { list = JSON.parse(String(r.mentions ?? "[]")); } catch { continue; }
        if (!Array.isArray(list)) continue;
        if (list.some((n) => shared.includes(String(n)))) ambiguous += 1;
        if (!list.some((n) => unique.includes(String(n)))) continue;
        matched += 1;
        const next = list.map((n) => (unique.includes(String(n)) ? SUPPORT_ACTOR : n));
        writes.push({ sql: "UPDATE notes SET mentions = ? WHERE id = ?", args: [JSON.stringify(next), String(r.id)] });
      }
    }
    lines.push({ store: "workspace", table: "notes", column: "mentions", matched, ambiguous });
  } catch (error) {
    if (!missing(error)) throw error;
  }

  /* Values inside stored JSON: the lock record a team-canvas card shows
     (lockedBy, also as "Atomik for <name>"), and who published a bible
     version (publishedBy). */
  const ATOMIK_FOR = "Atomik for ";
  const verdict = (value: unknown): "owner" | "ambiguous" | null => {
    if (typeof value !== "string" || !value) return null;
    const core = value.startsWith(ATOMIK_FOR) ? value.slice(ATOMIK_FOR.length) : value;
    if (core === SUPPORT_ACTOR) return null;
    if (isOwnerAddress(identity, core) || identity.accountIds.includes(core) || unique.includes(core.trim())) return "owner";
    return shared.includes(core.trim()) ? "ambiguous" : null;
  };
  const masked = (value: string) => (value.startsWith(ATOMIK_FOR) ? `${ATOMIK_FOR}${SUPPORT_ACTOR}` : SUPPORT_ACTOR);
  /* Each JSON rewrite is optimistic: it lands only where the row is still
     what was read (the canvas by its revision, a bible version by its body).
     One that changed in between is reported, to run again. */
  const checked: { index: number; line: ScrubLine }[] = [];
  let canvasOps = false;
  async function jsonColumn(input: {
    table: string; column: string; key: string; idCol: string; revision?: boolean;
    rewrite: (body: Record<string, unknown>) => { owner: number; ambiguous: number; changes?: NodeChange[] };
    /** Statements to run after a landed rewrite (they check it landed themselves). */
    then?: (row: { k: string | number; revision: number; written: string }, changes: NodeChange[]) => InStatement[];
  }) {
    try {
      const line: ScrubLine = { store: "workspace", table: input.table, column: `${input.column}.${input.key}`, matched: 0, ambiguous: 0 };
      const rs = await tenant.execute({
        sql: `SELECT ${input.idCol} AS k, ${input.column} AS body${input.revision ? ", revision" : ""} FROM ${input.table} WHERE instr(${input.column}, ?) > 0`,
        args: [`"${input.key}"`],
      });
      for (const r of rs.rows as Row[]) {
        const original = String(r.body ?? "null");
        let body: unknown;
        try { body = JSON.parse(original); } catch { continue; }
        if (!body || typeof body !== "object") continue;
        const found = input.rewrite(body as Record<string, unknown>);
        if (found.ambiguous) line.ambiguous += 1;
        if (!found.owner) continue;
        line.matched += 1;
        const k = r.k as string | number;
        const revision = Number(r.revision ?? 0);
        checked.push({ index: writes.length, line });
        writes.push(input.revision
          ? { sql: `UPDATE ${input.table} SET ${input.column} = ?, revision = revision + 1 WHERE ${input.idCol} = ? AND revision = ?`, args: [JSON.stringify(body), k, revision] }
          : { sql: `UPDATE ${input.table} SET ${input.column} = ? WHERE ${input.idCol} = ? AND ${input.column} = ?`, args: [JSON.stringify(body), k, original] });
        writes.push(...(input.then?.({ k, revision, written: JSON.stringify(body) }, found.changes ?? []) ?? []));
      }
      lines.push(line);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  await jsonColumn({
    // A new revision, so open windows read the card again.
    table: "workbench_team_canvas", column: "body", key: "lockedBy", idCol: "production_id", revision: true,
    rewrite: (body) => {
      let owner = 0, ambiguous = 0;
      const changes: NodeChange[] = [];
      for (const [id, node] of Object.entries((body.nodes ?? {}) as Record<string, { master?: Record<string, unknown> & { lockedBy?: unknown } }>)) {
        const v = verdict(node?.master?.lockedBy);
        if (v === "ambiguous") ambiguous += 1;
        if (v !== "owner") continue;
        owner += 1;
        const before = { master: { ...node.master } };
        node.master!.lockedBy = masked(String(node.master!.lockedBy));
        changes.push({ id, made: false, fields: ["master"], before, after: { ...node } as Record<string, unknown> });
      }
      return { owner, ambiguous, changes };
    },
    /* The live room takes the rewritten cards like any server change (lib/workbench/canvas-push.ts): an outbox row,
       written only if the rewrite landed, pushed on the next read of the canvas. Where the room's card has moved on,
       writeRoom leaves it, and the room's next load from the server brings the new revision. */
    then: ({ k, revision, written }, changes) => {
      canvasOps = true;
      const insert = insertCanvasOp({
        productionId: String(k), opId: `owner-privacy:${revision + 1}`, what: "ops", author: "server", ops: [],
        outcomes: [], changes, assets: [], focus: null, revision: revision + 1,
        push: collabConfigured() ? "pending" : "none",
      }) as { sql: string; args: (string | number | null)[] };
      const args = [...insert.args];
      args[10] = 0; // not a change the team is told about: nobody did anything to the board
      return [{
        sql: insert.sql.replace(/VALUES\s*\(([\s\S]*)\)\s*$/, "SELECT $1 WHERE EXISTS (SELECT 1 FROM workbench_team_canvas WHERE production_id = ? AND revision = ? AND body = ?)"),
        args: [...args, String(k), revision + 1, written],
      }];
    },
  });
  // workbench_bibles is keyed by (project_id, version): the rowid names one row.
  await jsonColumn({
    table: "workbench_bibles", column: "body", key: "publishedBy", idCol: "rowid",
    rewrite: (body) => {
      const v = verdict(body.publishedBy);
      if (v === "owner") body.publishedBy = masked(String(body.publishedBy));
      return { owner: v === "owner" ? 1 : 0, ambiguous: v === "ambiguous" ? 1 : 0 };
    },
  });

  let changed = 0;
  if (opts.apply) {
    if (canvasOps) await canvasOpsReady();
    await opts.beforeWrite?.();
    if (writes.length) {
      const results = await tenant.batch(writes, "write");
      for (const c of checked) {
        if (Number(results[c.index]?.rowsAffected ?? 0) > 0) continue;
        c.line.changed = (c.line.changed ?? 0) + 1;
        changed += 1;
      }
    }
    if (platformWrites.length) await platformDb().batch(platformWrites, "write");
  }
  return {
    workspaceId: ws.id,
    applied: opts.apply,
    lines,
    total: lines.reduce((n, l) => n + l.matched, 0),
    ambiguous: lines.reduce((n, l) => n + l.ambiguous, 0),
    ...(changed ? { changed, note: "Some records changed while this ran and were left as they are: run it again." } : {}),
  };
}
