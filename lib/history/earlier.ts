import { db, ready } from "../db";
import { DRAFT_PROJECT_PREFIX } from "../draftProject";
import { platformDb, platformReady } from "../platform";
import { requireTenant } from "../tenant";

/**
 * Work made before History existed, read back from the meter records (owner, 17 Oct, answer 15: "History includes
 * earlier work: backfill from the meter records; rows missing a field show 'before History'"). PR A9.
 *
 * A read, not a copy: nothing is written anywhere. Each meter record of this workspace (`meter_events`, the platform's
 * own ledger, the money truth) that no v30 job points at is one row of earlier work, with what the record holds:
 * when, who, which project, what it made, how it ended and what the receipt says. What it does not hold is never
 * filled in: the person's instruction, the step, who decided (Agent or Director), the quote.
 *
 * NO ENGINE, EVER. Nothing before History recorded who decided how a piece of work was made (an Atomik run renders
 * under its person's own name), so no earlier row can be shown as a Director row, and an engine is never shown or
 * guessed for one. The read below does not select the record's engine, model, provider or vendor cost columns at all
 * (the History spec guards that), so none of them can reach a row.
 *
 * Money: the amount is the workspace's receipt for the record (`credit_receipts`, the meter's replica, synced by the
 * caller), in credits, and only where credits apply. Nothing about a vendor's refund is read or said.
 */

export const BEFORE_HISTORY = "before History";

/** One record of earlier work. */
export type EarlierRecord = {
  /** The meter record's id (for a render, its take's id). */
  meterId: string;
  /** The project it was made in (`projects.id`), from the record, else from its take; null when neither says. */
  productionId: string | null;
  /** "generation" for a still, a clip or audio; null when the record cannot say which product it was. */
  product: "generation" | null;
  status: "running" | "done" | "failed" | null;
  /** Who asked: the record's own, else its take's; "" when neither says. */
  createdBy: string;
  at: number;
  /** The receipt, in credits; null where credits do not apply. */
  credits: number | null;
  /** The take it billed for, when that take is this workspace's and still there. */
  takeId: string | null;
};

export type EarlierMark = { at: number; id: string };

export type EarlierFilter = {
  from?: number;
  to?: number;
  productionId?: string;
  createdBy?: string;
  /** The viewer's private boards: earlier work on any other private board is left out. Omitted: none is. */
  visibleBoards?: readonly string[];
  /** Only records after this one, in the order returned (newest first, then id ascending). */
  after?: EarlierMark;
  limit: number;
};

const ID = /^[A-Za-z0-9_-]{1,300}$/;
const BATCH = 500;
const GENERATION_KINDS = new Set(["video", "image", "audio"]);
const STATUS: Readonly<Record<string, EarlierRecord["status"]>> = { running: "running", succeeded: "done", failed: "failed" };
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * One page of earlier work for the workspace in scope, newest first, and whether there is more. `claimed` names the
 * records that already belong to a v30 job: those are History rows of their own and are never shown twice.
 */
export async function earlierPage(
  filter: EarlierFilter,
  opts: { credits: boolean; claimed: (meterIds: string[]) => Promise<Set<string>> },
): Promise<{ rows: EarlierRecord[]; more: boolean }> {
  const ws = requireTenant();
  const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit)));
  if (filter.productionId !== undefined && !ID.test(filter.productionId)) return { rows: [], more: false };
  if (filter.createdBy !== undefined && (typeof filter.createdBy !== "string" || !filter.createdBy || filter.createdBy.length > 200)) return { rows: [], more: false };
  if ((filter.from !== undefined && !isTime(filter.from)) || (filter.to !== undefined && !isTime(filter.to))) return { rows: [], more: false };
  await ready();
  await platformReady();
  const visible = filter.visibleBoards ? new Set(filter.visibleBoards) : null;
  const seen = (production: string | null) => !visible || production === null || !production.startsWith(DRAFT_PROJECT_PREFIX) || visible.has(production);

  const kept: EarlierRecord[] = [];
  let after = filter.after ?? null;
  for (;;) {
    const where = ["workspace_id=?"];
    const args: (string | number)[] = [ws.id];
    if (filter.from !== undefined) { where.push("created_at>=?"); args.push(filter.from); }
    if (filter.to !== undefined) { where.push("created_at<?"); args.push(filter.to); }
    /* A record that names no project or no person may take its take's: those are read and decided below. */
    if (filter.productionId !== undefined) { where.push("(project_id=? OR project_id IS NULL)"); args.push(filter.productionId); }
    if (filter.createdBy !== undefined) { where.push("(created_by=? OR created_by IS NULL)"); args.push(filter.createdBy); }
    if (visible) {
      where.push("(project_id IS NULL OR project_id NOT GLOB ? OR project_id IN (SELECT value FROM json_each(?)))");
      args.push(`${DRAFT_PROJECT_PREFIX}*`, JSON.stringify([...visible]));
    }
    if (after) {
      if (!isTime(after.at) || typeof after.id !== "string" || !after.id || after.id.length > 300) return { rows: [], more: false };
      where.push("(created_at<? OR (created_at=? AND id>?))");
      args.push(after.at, after.at, after.id);
    }
    /* Only these columns: never the engine, the model, the provider's outcome or any cost. */
    const page = (await platformDb().execute({
      sql: `SELECT id, project_id, kind, status, created_by, created_at FROM meter_events WHERE ${where.join(" AND ")}
            ORDER BY created_at DESC, id ASC LIMIT ?`,
      args: [...args, BATCH],
    })).rows.map((r) => ({
      id: String(r.id), project: r.project_id == null ? null : String(r.project_id), kind: String(r.kind), status: String(r.status),
      by: r.created_by == null ? "" : String(r.created_by), at: Number(r.created_at),
    }));
    if (!page.length) return { rows: kept, more: false };
    const last = page[page.length - 1];
    after = { at: last.at, id: last.id };

    const ids = page.map((r) => r.id);
    const claimed = await opts.claimed(ids);
    const open = page.filter((r) => !claimed.has(r.id));
    const takes = await takesOf(open.map((r) => r.id));
    const receipts = opts.credits ? await receiptsOf(open.map((r) => r.id)) : new Map<string, number>();
    for (const r of open) {
      const take = takes.get(r.id);
      const productionId = r.project ?? take?.project ?? null;
      const createdBy = r.by || take?.by || "";
      if (filter.productionId !== undefined && productionId !== filter.productionId) continue;
      if (filter.createdBy !== undefined && createdBy !== filter.createdBy) continue;
      if (!seen(productionId)) continue;
      kept.push({
        meterId: r.id,
        productionId,
        product: GENERATION_KINDS.has(r.kind) ? "generation" : null,
        status: STATUS[r.status] ?? null,
        createdBy,
        at: r.at,
        credits: opts.credits ? receipts.get(r.id) ?? 0 : null,
        takeId: take && !take.deleted ? r.id : null,
      });
      if (kept.length > limit) return { rows: kept.slice(0, limit), more: true };
    }
    if (page.length < BATCH) return { rows: kept, more: false };
  }
}

/** The takes these records billed for, in this workspace's own database: their project, author and whether they are hidden. */
async function takesOf(ids: string[]): Promise<Map<string, { project: string | null; by: string; deleted: boolean }>> {
  const out = new Map<string, { project: string | null; by: string; deleted: boolean }>();
  if (!ids.length) return out;
  const rs = await db().execute({
    sql: "SELECT id, project_id, created_by, deleted FROM generations WHERE id IN (SELECT value FROM json_each(?))",
    args: [JSON.stringify(ids)],
  });
  for (const r of rs.rows)
    out.set(String(r.id), { project: r.project_id == null ? null : String(r.project_id), by: r.created_by == null ? "" : String(r.created_by), deleted: Number(r.deleted ?? 0) !== 0 });
  return out;
}

/** The workspace's receipts for these records (the meter's replica): what was charged, in credits. */
async function receiptsOf(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rs = await db().execute({ sql: "SELECT event_id, credits FROM credit_receipts WHERE event_id IN (SELECT value FROM json_each(?))", args: [JSON.stringify(ids)] });
  for (const r of rs.rows) out.set(String(r.event_id), Number(r.credits));
  return out;
}

/** Every private-board id earlier work may name, from the meter records of the workspace in scope (for the viewer's board list). */
export async function earlierBoards(): Promise<string[]> {
  const ws = requireTenant();
  await platformReady();
  const rs = await platformDb().execute({
    sql: "SELECT DISTINCT project_id FROM meter_events WHERE workspace_id=? AND project_id GLOB ?",
    args: [ws.id, `${DRAFT_PROJECT_PREFIX}*`],
  });
  return rs.rows.map((r) => String(r.project_id));
}
