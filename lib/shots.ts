import { withMediaSources } from "./mediaMutation";
/**
 * Shots — the production unit.
 *
 * A project is a list of shots; a shot is asked for once and rendered many
 * times. Every render carries `shot_id` + `version`, which is what turns
 * "revisions per shot" into a number you can actually manage by, gives the
 * canvas something to group by, and gives a download a name a producer can
 * read.
 */
import { db, ready, now, id } from "@/lib/db";

export type Shot = {
  id: string;
  projectId: string | null;
  scene: string;
  code: string;
  title: string;
  description: string;
  status: "open" | "review" | "approved" | "parked";
  position: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** The breakdown's half: planned seconds, per-shot setup, cast tags,
   *  render or type-only, and the sync flag the shot list reads. */
  planned: number | null;
  /** The shot's own Setup rows. `null` on a row is an explicit clear. */
  setup: Record<string, string | null>;
  cast: string[];
  kind: "render" | "type";
  /** The engine the shot builder recommended for it (brief 1.8), when one was. */
  engine: string | null;
  dirty: boolean;
  syncedAt: number | null;
};

const json = <T,>(raw: unknown, fallback: T): T => {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export function rowToShot(r: any): Shot {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    scene: r.scene ?? "",
    code: r.code ?? "",
    title: r.title ?? "",
    description: r.description ?? "",
    status: (r.status ?? "open") as Shot["status"],
    position: Number(r.position ?? 0),
    createdBy: r.created_by ?? "",
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    planned: r.planned == null ? null : Number(r.planned),
    engine: r.engine == null ? null : String(r.engine),
    setup: json<Record<string, string>>(r.setup, {}),
    cast: json<string[]>(r.cast, []),
    kind: r.kind === "type" ? "type" : "render",
    dirty: Number(r.dirty ?? 0) === 1,
    syncedAt: r.synced_at == null ? null : Number(r.synced_at),
  };
}

export const STATUSES: Shot["status"][] = ["open", "review", "approved", "parked"];

/**
 * Shot codes are how a filename stays readable, so they get the same
 * treatment as cast names: no spaces, no separators that would confuse the
 * naming template.
 */
export function codeProblem(code: string): string | null {
  if (!code.trim()) return null;               // optional — we'll generate one
  if (code.length > 24) return "Shot code is too long (24 characters max).";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(code))
    return "Shot code can use letters, numbers, dot, dash and underscore only.";
  return null;
}

/** SH010, SH020, … — leaving room to slot a pickup in between. */
export function nextCode(existing: string[]): string {
  let max = 0;
  for (const c of existing) {
    const m = /^SH(\d+)$/i.exec(c.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  const n = max ? max + 10 : 10;
  return `SH${String(n).padStart(3, "0")}`;
}

export async function listShots(projectId: string | null): Promise<Shot[]> {
  await ready();
  const rs = projectId
    ? await db().execute({
        sql: `SELECT * FROM shots WHERE project_id = ? ORDER BY position, created_at`,
        args: [projectId],
      })
    : await db().execute(`SELECT * FROM shots ORDER BY position, created_at`);
  return rs.rows.map(rowToShot);
}

export async function getShot(shotId: string): Promise<Shot | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM shots WHERE id = ?`, args: [shotId] });
  return rs.rows.length ? rowToShot(rs.rows[0]) : null;
}

export async function createShot(input: {
  projectId: string | null;
  scene?: string;
  code?: string;
  title?: string;
  description?: string;
  planned?: number | null;
  setup?: Record<string, string | null>;
  cast?: string[];
  kind?: "render" | "type";
  engine?: string | null;
  createdBy: string;
}): Promise<Shot> {
  await ready();
  const siblings = await listShots(input.projectId);
  const code = (input.code ?? "").trim() || nextCode(siblings.map((s) => s.code));
  const sid = id("shot");
  const ts = now();
  const position = siblings.length ? Math.max(...siblings.map((s) => s.position)) + 1 : 0;
  await withMediaSources(input.setup, (tx) => tx.execute({
    sql: `INSERT INTO shots (id, project_id, scene, code, title, description, status, position,
                             created_by, created_at, updated_at, planned, setup, cast, kind, dirty, engine)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    args: [sid, input.projectId, (input.scene ?? "").trim().slice(0, 40), code,
           (input.title ?? "").trim().slice(0, 160), (input.description ?? "").slice(0, 2000),
           "open", position, input.createdBy, ts, ts,
           input.planned == null ? null : Math.max(1, Math.min(60, Math.round(input.planned))),
           JSON.stringify(input.setup ?? {}), JSON.stringify((input.cast ?? []).slice(0, 20)),
           input.kind === "type" ? "type" : "render", input.engine ?? null],
  }));
  return (await getShot(sid))!;
}

/**
 * The next take number for a shot. Counts every render ever filed against it,
 * deleted ones included — v4 must never be reused just because v3 was binned,
 * or two files in a producer's downloads folder collide.
 */
export async function nextVersion(shotId: string): Promise<number> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT COALESCE(MAX(version), 0) AS v FROM generations WHERE shot_id = ?`,
    args: [shotId],
  });
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  return Number((rs.rows[0] as any)?.v ?? 0) + 1;
}

/** The approved take of a shot, when it has one — the shot is locked while it does (brief 2.1). */
export async function approvedTakeOf(shotId: string): Promise<{ id: string; version: number; by: string | null } | null> {
  await ready();
  const rs = await db().execute({
    sql: `SELECT id, version, approved_by, review_by FROM generations
          WHERE shot_id = ? AND review_state = 'approved' AND deleted = 0
          ORDER BY COALESCE(approved_at, updated_at) DESC LIMIT 1`,
    args: [shotId],
  });
  if (!rs.rows.length) return null;
  const r = rs.rows[0] as unknown as Record<string, unknown>;
  return { id: String(r.id), version: Number(r.version ?? 1), by: (r.approved_by ?? r.review_by ?? null) as string | null };
}
