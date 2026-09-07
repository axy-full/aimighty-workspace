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
/** A scene; `by` says who wrote its current words — "you", or the model id — and `at` when (brief 1.8). */
export type Scene = { n: number; title: string; secs: number; prose: string; by?: string; at?: number };
export type TreatmentVersion = { version: number; by: string; at: number };
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
    ...(typeof s.by === "string" && s.by ? { by: s.by.slice(0, 80) } : {}),
    ...(Number.isFinite(Number(s.at)) && Number(s.at) > 0 ? { at: Number(s.at) } : {}),
  }));
  // Saving a new draft number keeps the previous draft as it was — a versioned document, not a transcript.
  if (existing && input.bump) {
    await db().execute({
      sql: `INSERT INTO treatment_versions (id, project_id, version, title, logline, setup, scenes, notes, by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [newId("tv"), input.projectId, existing.draft, existing.title, existing.logline, JSON.stringify(existing.setup), JSON.stringify(existing.scenes), JSON.stringify(existing.notes), existing.updatedBy, ts],
    });
  }
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

/** The drafts kept for a production, newest first. */
export async function listTreatmentVersions(projectId: string): Promise<TreatmentVersion[]> {
  await ready();
  const rs = await db().execute({ sql: `SELECT version, by, created_at FROM treatment_versions WHERE project_id = ? ORDER BY version DESC`, args: [projectId] });
  return (rs.rows as unknown as Record<string, unknown>[]).map((r) => ({ version: Number(r.version), by: String(r.by ?? ""), at: Number(r.created_at ?? 0) }));
}

/** One earlier draft, as the document it was. */
export async function getTreatmentVersion(projectId: string, version: number): Promise<(Omit<Treatment, "id" | "ideaId" | "createdAt"> & { at: number }) | null> {
  await ready();
  const rs = await db().execute({ sql: `SELECT * FROM treatment_versions WHERE project_id = ? AND version = ? ORDER BY created_at DESC LIMIT 1`, args: [projectId, version] });
  if (!rs.rows.length) return null;
  const r = rs.rows[0] as Record<string, unknown>;
  return {
    projectId, draft: Number(r.version), title: String(r.title ?? ""), logline: String(r.logline ?? ""), setup: json<Record<string, string>>(r.setup, {}),
    scenes: json<Scene[]>(r.scenes, []), notes: json<Note[]>(r.notes, []), updatedBy: String(r.by ?? ""), updatedAt: Number(r.created_at ?? 0), at: Number(r.created_at ?? 0),
  };
}

/** A model's reply as one scene, or nothing: JSON with or without a fence, prose around it tolerated, lengths clamped. */
export function sceneFromReply(text: string): { title: string; secs: number; prose: string } | null {
  const body = String(text ?? "").replace(/```(?:json)?/gi, "").trim();
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(body.slice(start, end + 1)) as { title?: unknown; secs?: unknown; prose?: unknown };
    const prose = typeof j.prose === "string" ? j.prose.trim().slice(0, 8000) : "";
    if (!prose) return null;
    const title = typeof j.title === "string" ? j.title.trim().slice(0, 120) : "";
    const secs = Math.max(0, Math.min(600, Math.round(Number(j.secs) || 0)));
    return { title, secs, prose };
  } catch { return null; }
}
