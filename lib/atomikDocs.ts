import { db, ready, now, id as newId } from "@/lib/db";

/**
 * Atomik's documents: ideas and treatments. Shots are the shots table.
 */
export type IdeaState = "open" | "pinned" | "production" | "parked";
export type Idea = {
  id: string; num: number; projectId: string | null;
  logline: string; tone: string[]; refs: string[];
  state: IdeaState; pins: string[]; parkedBy: string | null;
  /** The reasoning model chosen on the card — a gateway id, or null for auto. */
  model: string | null;
  createdBy: string; createdAt: number; updatedAt: number;
};
export type Scene = { n: number; title: string; secs: number; prose: string };
export type Note = { id: string; by: string; scene: number; text: string; at: number };
export type Treatment = {
  id: string; projectId: string; ideaId: string | null; draft: number;
  title: string; logline: string; setup: Record<string, string>;
  scenes: Scene[]; notes: Note[];
  updatedBy: string; createdAt: number; updatedAt: number;
};

const json = <T,>(raw: unknown, fallback: T): T => {
  if (typeof raw !== "string" || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rowToIdea(r: any): Idea {
  const state = ["open", "pinned", "production", "parked"].includes(r.state) ? r.state : "open";
  return {
    id: r.id, num: Number(r.num ?? 0), projectId: r.project_id ?? null,
    logline: r.logline ?? "", tone: json<string[]>(r.tone, []), refs: json<string[]>(r.refs, []),
    state, pins: json<string[]>(r.pins, []), parkedBy: r.parked_by ?? null,
    model: typeof r.model === "string" && r.model ? r.model : null,
    createdBy: r.created_by ?? "", createdAt: Number(r.created_at ?? 0), updatedAt: Number(r.updated_at ?? 0),
  };
}
export function rowToTreatment(r: any): Treatment {
  return {
    id: r.id, projectId: r.project_id, ideaId: r.idea_id ?? null, draft: Number(r.draft ?? 1),
    title: r.title ?? "", logline: r.logline ?? "", setup: json<Record<string, string>>(r.setup, {}),
    scenes: json<Scene[]>(r.scenes, []), notes: json<Note[]>(r.notes, []),
    updatedBy: r.updated_by ?? "", createdAt: Number(r.created_at ?? 0), updatedAt: Number(r.updated_at ?? 0),
  };
}

export async function listIdeas(): Promise<Idea[]> {
  await ready();
  const rs = await db().execute(`SELECT * FROM ideas ORDER BY num DESC`);
  return rs.rows.map(rowToIdea);
}
export async function getIdea(id: string): Promise<Idea | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM ideas WHERE id = ?`, args: [id] });
  return rs.rows[0] ? rowToIdea(rs.rows[0]) : null;
}
export async function createIdea(input: { logline: string; tone: string[]; refs: string[]; model?: string | null; createdBy: string }): Promise<Idea> {
  await ready();
  const max = await db().execute(`SELECT COALESCE(MAX(num), 0) AS n FROM ideas`);
  const num = Number((max.rows[0] as any)?.n ?? 0) + 1;
  const iid = newId("idea");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO ideas (id, num, project_id, logline, tone, refs, state, pins, parked_by, created_by, created_at, updated_at, model)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [iid, num, null, input.logline.slice(0, 600), JSON.stringify(input.tone.slice(0, 8)), JSON.stringify(input.refs.slice(0, 3)),
           "open", "[]", null, input.createdBy, ts, ts, input.model?.slice(0, 120) || null],
  });
  return (await getIdea(iid))!;
}

export async function getTreatment(projectId: string): Promise<Treatment | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM treatments WHERE project_id = ?`, args: [projectId] });
  return rs.rows[0] ? rowToTreatment(rs.rows[0]) : null;
}
/** Create or replace the production's treatment. `bump` starts a new draft. */
export async function upsertTreatment(input: {
  projectId: string; ideaId?: string | null; title: string; logline: string;
  setup: Record<string, string>; scenes: Scene[]; notes: Note[]; updatedBy: string; bump?: boolean;
}): Promise<Treatment> {
  await ready();
  const existing = await getTreatment(input.projectId);
  const ts = now();
  const scenes = input.scenes.slice(0, 40).map((s, i) => ({
    n: i + 1, title: String(s.title ?? "").slice(0, 120),
    secs: Math.max(0, Math.min(600, Math.round(Number(s.secs) || 0))), prose: String(s.prose ?? "").slice(0, 8000),
  }));
  const notes = input.notes.slice(0, 200);
  if (!existing) {
    const tid = newId("trt");
    await db().execute({
      sql: `INSERT INTO treatments (id, project_id, idea_id, draft, title, logline, setup, scenes, notes, updated_by, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [tid, input.projectId, input.ideaId ?? null, 1, input.title.slice(0, 160), input.logline.slice(0, 600),
             JSON.stringify(input.setup), JSON.stringify(scenes), JSON.stringify(notes), input.updatedBy, ts, ts],
    });
  } else {
    await db().execute({
      sql: `UPDATE treatments SET idea_id = COALESCE(?, idea_id), draft = draft + ?, title = ?, logline = ?, setup = ?, scenes = ?, notes = ?, updated_by = ?, updated_at = ?
            WHERE project_id = ?`,
      args: [input.ideaId ?? null, input.bump ? 1 : 0, input.title.slice(0, 160), input.logline.slice(0, 600),
             JSON.stringify(input.setup), JSON.stringify(scenes), JSON.stringify(notes), input.updatedBy, ts, input.projectId],
    });
  }
  return (await getTreatment(input.projectId))!;
}
