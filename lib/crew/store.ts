import { db, ready, id as newId, now } from "../db";
import { requireTenant } from "../tenant";
import {
  CREW_PRESETS, CUSTOM_MEMBER, DEFAULT_CHAIR, DEFAULT_CONTEXT, DEFAULT_SEATED, MEMBERS_MAX,
  type CrewContext, type CrewEffort, type CrewPhase,
} from "./room";
import { archiveAndDelete } from "../archive";

/**
 * Crew's four tables, in the workspace's own database (CREW_ADDENDUM.md ›
 * Data model). Created on first use, like every other workspace table.
 * `project_id` is the workbench draft's id; members belong to a project and
 * to the person who owns that draft, as drafts do.
 */
export type CrewMember = {
  id: string; projectId: string; presetId: string | null; name: string; department: string; stance: string;
  effort: CrewEffort; color: string; active: boolean; isChair: boolean; order: number;
};
export type CrewSession = {
  id: string; projectId: string; goal: string; context: CrewContext; model: string; roundsRun: number;
  /** Settled credits; null on a workspace that bills none. */
  spendCr: number | null; spendUsd: number; createdBy: string; createdAt: number;
};
export type CrewMessage = {
  id: string; sessionId: string; round: number; phase: CrewPhase | "note"; memberId: string | null; toMemberId: string | null;
  text: string; tokensIn: number; tokensOut: number; createdAt: number;
};
export type CrewSolutionStatus = "open" | "sent_to_brief" | "boarded" | "generated";
export type CrewSolution = { id: string; sessionId: string; round: number; text: string; source: "converge" | "pin"; status: CrewSolutionStatus; createdAt: number };

const configured = new Map<string, Promise<void>>();
export async function crewReady() {
  const id = requireTenant().id;
  if (!configured.has(id))
    configured.set(id, (async () => {
      await ready();
      await db().execute(`CREATE TABLE IF NOT EXISTS crew_members(id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT NOT NULL, preset_id TEXT,
        name TEXT NOT NULL, department TEXT NOT NULL, stance TEXT NOT NULL, effort TEXT NOT NULL, color TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, is_chair INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
      await db().execute(`CREATE INDEX IF NOT EXISTS crew_members_project ON crew_members(owner, project_id, sort)`);
      await db().execute(`CREATE TABLE IF NOT EXISTS crew_sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT NOT NULL, goal TEXT NOT NULL,
        context TEXT NOT NULL, model TEXT NOT NULL, rounds_run INTEGER NOT NULL DEFAULT 0, spend_cr REAL, spend_usd REAL NOT NULL DEFAULT 0,
        running_since INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
      await db().execute(`CREATE INDEX IF NOT EXISTS crew_sessions_project ON crew_sessions(owner, project_id, created_at)`);
      await db().execute(`CREATE TABLE IF NOT EXISTS crew_messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, round INTEGER NOT NULL, phase TEXT NOT NULL,
        member_id TEXT, to_member_id TEXT, name TEXT NOT NULL, department TEXT NOT NULL, color TEXT NOT NULL, text TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
      await db().execute(`CREATE INDEX IF NOT EXISTS crew_messages_session ON crew_messages(session_id, created_at)`);
      await db().execute(`CREATE TABLE IF NOT EXISTS crew_solutions(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, round INTEGER NOT NULL, text TEXT NOT NULL,
        source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL)`);
      await db().execute(`CREATE INDEX IF NOT EXISTS crew_solutions_session ON crew_solutions(session_id, created_at)`);
    })().catch((error) => { configured.delete(id); throw error; }));
  await configured.get(id);
}

type Row = Record<string, unknown>;
const member = (r: Row): CrewMember => ({
  id: String(r.id), projectId: String(r.project_id), presetId: r.preset_id == null ? null : String(r.preset_id), name: String(r.name),
  department: String(r.department), stance: String(r.stance), effort: String(r.effort) as CrewEffort, color: String(r.color),
  active: Boolean(Number(r.active)), isChair: Boolean(Number(r.is_chair)), order: Number(r.sort),
});
const session = (r: Row): CrewSession => ({
  id: String(r.id), projectId: String(r.project_id), goal: String(r.goal), context: { ...DEFAULT_CONTEXT, ...(JSON.parse(String(r.context || "{}")) as Partial<CrewContext>) },
  model: String(r.model), roundsRun: Number(r.rounds_run), spendCr: r.spend_cr == null ? null : Number(r.spend_cr), spendUsd: Number(r.spend_usd ?? 0),
  createdBy: String(r.created_by), createdAt: Number(r.created_at),
});
/** A message carries the speaker as they were when they spoke: a renamed or removed member does not rewrite the minutes. */
export type StoredMessage = CrewMessage & { name: string; department: string; color: string };
const message = (r: Row): StoredMessage => ({
  id: String(r.id), sessionId: String(r.session_id), round: Number(r.round), phase: String(r.phase) as CrewMessage["phase"],
  memberId: r.member_id == null ? null : String(r.member_id), toMemberId: r.to_member_id == null ? null : String(r.to_member_id),
  name: String(r.name), department: String(r.department), color: String(r.color), text: String(r.text),
  tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), createdAt: Number(r.created_at),
});
const solution = (r: Row): CrewSolution => ({
  id: String(r.id), sessionId: String(r.session_id), round: Number(r.round), text: String(r.text),
  source: String(r.source) as CrewSolution["source"], status: String(r.status) as CrewSolutionStatus, createdAt: Number(r.created_at),
});

/* ── Members ──────────────────────────────────────────────────────────── */

/** The project's roster; the first read seats the default five with the Producer in the chair. */
export async function listMembers(owner: string, projectId: string): Promise<CrewMember[]> {
  await crewReady();
  const read = async () => (await db().execute({ sql: "SELECT * FROM crew_members WHERE owner=? AND project_id=? ORDER BY sort, created_at", args: [owner, projectId] })).rows.map((r) => member(r as Row));
  const found = await read();
  if (found.length) return found;
  const seeded = await db().execute({ sql: "SELECT 1 FROM crew_sessions WHERE owner=? AND project_id=? LIMIT 1", args: [owner, projectId] });
  if (seeded.rows.length) return found; /* They emptied the room themselves. */
  const ts = now();
  for (const [i, presetId] of DEFAULT_SEATED.entries()) {
    const p = CREW_PRESETS.find((x) => x.id === presetId)!;
    await db().execute({
      sql: "INSERT INTO crew_members(id,owner,project_id,preset_id,name,department,stance,effort,color,active,is_chair,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)",
      args: [newId("crewm"), owner, projectId, p.id, p.name, p.department, p.stance, "medium", p.color, p.id === DEFAULT_CHAIR ? 1 : 0, i, ts],
    });
  }
  return read();
}

export async function addMember(owner: string, projectId: string, presetId: string | "custom"): Promise<CrewMember> {
  const current = await listMembers(owner, projectId);
  if (current.length >= MEMBERS_MAX) throw new CrewError(`A room seats up to ${MEMBERS_MAX} members.`, 409);
  const preset = presetId === "custom" ? null : CREW_PRESETS.find((p) => p.id === presetId);
  if (presetId !== "custom" && !preset) throw new CrewError("Choose a role card.", 400);
  if (preset && current.some((m) => m.presetId === preset.id)) throw new CrewError(`${preset.name} is already in the room.`, 409);
  const base = preset ?? CUSTOM_MEMBER;
  const id = newId("crewm");
  await db().execute({
    sql: "INSERT INTO crew_members(id,owner,project_id,preset_id,name,department,stance,effort,color,active,is_chair,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)",
    args: [id, owner, projectId, preset?.id ?? null, base.name, base.department, base.stance, "medium", base.color, current.some((m) => m.isChair) ? 0 : 1, (current.at(-1)?.order ?? -1) + 1, now()],
  });
  return (await listMembers(owner, projectId)).find((m) => m.id === id)!;
}

export type MemberPatch = Partial<Pick<CrewMember, "name" | "department" | "stance" | "effort" | "active" | "isChair">>;
export async function updateMember(owner: string, id: string, patch: MemberPatch): Promise<CrewMember> {
  await crewReady();
  const found = (await db().execute({ sql: "SELECT * FROM crew_members WHERE id=? AND owner=?", args: [id, owner] })).rows[0];
  if (!found) throw new CrewError("That member is not in this room.", 404);
  const current = member(found as Row);
  const next = { ...current, ...patch };
  if (patch.isChair) await db().execute({ sql: "UPDATE crew_members SET is_chair=0 WHERE owner=? AND project_id=?", args: [owner, current.projectId] });
  await db().execute({
    sql: "UPDATE crew_members SET name=?,department=?,stance=?,effort=?,active=?,is_chair=? WHERE id=? AND owner=?",
    args: [next.name, next.department, next.stance, next.effort, next.active ? 1 : 0, next.isChair ? 1 : 0, id, owner],
  });
  return next;
}
export async function removeMember(owner: string, id: string): Promise<void> {
  await crewReady();
  await archiveAndDelete(db(), "crew_members", "id=? AND owner=?", [id, owner]);
}

/* ── Sessions ─────────────────────────────────────────────────────────── */

export class CrewError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = "CrewError"; }
}

export async function createSession(owner: string, input: { projectId: string; goal: string; context: CrewContext; model: string }): Promise<CrewSession> {
  await crewReady();
  const id = newId("crews");
  await db().execute({
    sql: "INSERT INTO crew_sessions(id,owner,project_id,goal,context,model,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
    args: [id, owner, input.projectId, input.goal, JSON.stringify(input.context), input.model, owner, now()],
  });
  return (await readSession(owner, id))!;
}
export async function readSession(owner: string, id: string): Promise<CrewSession | null> {
  await crewReady();
  const row = (await db().execute({ sql: "SELECT * FROM crew_sessions WHERE id=? AND owner=?", args: [id, owner] })).rows[0];
  return row ? session(row as Row) : null;
}
export async function updateSessionBrief(owner: string, id: string, patch: { goal?: string; context?: CrewContext }): Promise<void> {
  await crewReady();
  if (patch.goal !== undefined) await db().execute({ sql: "UPDATE crew_sessions SET goal=? WHERE id=? AND owner=?", args: [patch.goal, id, owner] });
  if (patch.context !== undefined) await db().execute({ sql: "UPDATE crew_sessions SET context=? WHERE id=? AND owner=?", args: [JSON.stringify(patch.context), id, owner] });
}
export type SessionSummary = CrewSession & { solutions: number };
export async function listSessions(owner: string, projectId: string): Promise<SessionSummary[]> {
  await crewReady();
  const rows = await db().execute({
    sql: `SELECT s.*, (SELECT COUNT(*) FROM crew_solutions x WHERE x.session_id=s.id) AS solutions
          FROM crew_sessions s WHERE s.owner=? AND s.project_id=? ORDER BY s.created_at DESC LIMIT 100`,
    args: [owner, projectId],
  });
  return rows.rows.map((r) => ({ ...session(r as Row), solutions: Number((r as Row).solutions) }));
}

/** One round at a time per session. A claim older than ten minutes is a crashed run, not a running one. */
const STALE_MS = 10 * 60_000;
export async function claimRound(owner: string, id: string): Promise<boolean> {
  const ts = now();
  const claimed = await db().execute({
    sql: "UPDATE crew_sessions SET running_since=? WHERE id=? AND owner=? AND (running_since IS NULL OR running_since < ?)",
    args: [ts, id, owner, ts - STALE_MS],
  });
  return claimed.rowsAffected > 0;
}
export async function releaseRound(owner: string, id: string, settled?: { spendUsd: number; spendCr: number | null }): Promise<void> {
  if (settled)
    await db().execute({
      sql: "UPDATE crew_sessions SET running_since=NULL, rounds_run=rounds_run+1, spend_usd=spend_usd+?, spend_cr=CASE WHEN ? IS NULL THEN spend_cr ELSE COALESCE(spend_cr,0)+? END WHERE id=? AND owner=?",
      args: [settled.spendUsd, settled.spendCr, settled.spendCr, id, owner],
    });
  else await db().execute({ sql: "UPDATE crew_sessions SET running_since=NULL WHERE id=? AND owner=?", args: [id, owner] });
}

/* ── Messages and solutions ───────────────────────────────────────────── */

export async function addMessage(input: Omit<StoredMessage, "id" | "createdAt">): Promise<StoredMessage> {
  const id = newId("crewmsg");
  const createdAt = now();
  await db().execute({
    sql: "INSERT INTO crew_messages(id,session_id,round,phase,member_id,to_member_id,name,department,color,text,tokens_in,tokens_out,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    args: [id, input.sessionId, input.round, input.phase, input.memberId, input.toMemberId, input.name, input.department, input.color, input.text, input.tokensIn, input.tokensOut, createdAt],
  });
  return { ...input, id, createdAt };
}
export async function listMessages(sessionId: string): Promise<StoredMessage[]> {
  await crewReady();
  return (await db().execute({ sql: "SELECT * FROM crew_messages WHERE session_id=? ORDER BY created_at, rowid", args: [sessionId] })).rows.map((r) => message(r as Row));
}
export async function readMessage(owner: string, id: string): Promise<StoredMessage | null> {
  await crewReady();
  const row = (await db().execute({ sql: "SELECT m.* FROM crew_messages m JOIN crew_sessions s ON s.id=m.session_id WHERE m.id=? AND s.owner=?", args: [id, owner] })).rows[0];
  return row ? message(row as Row) : null;
}
export async function addSolution(input: { sessionId: string; round: number; text: string; source: "converge" | "pin" }): Promise<CrewSolution> {
  const id = newId("crewsol");
  const createdAt = now();
  await db().execute({ sql: "INSERT INTO crew_solutions(id,session_id,round,text,source,status,created_at) VALUES(?,?,?,?,?,'open',?)", args: [id, input.sessionId, input.round, input.text, input.source, createdAt] });
  return { id, ...input, status: "open", createdAt };
}
export async function listSolutions(sessionId: string): Promise<CrewSolution[]> {
  await crewReady();
  return (await db().execute({ sql: "SELECT * FROM crew_solutions WHERE session_id=? ORDER BY created_at, rowid", args: [sessionId] })).rows.map((r) => solution(r as Row));
}
export async function readSolution(owner: string, id: string): Promise<(CrewSolution & { projectId: string }) | null> {
  await crewReady();
  const row = (await db().execute({ sql: "SELECT x.*, s.project_id FROM crew_solutions x JOIN crew_sessions s ON s.id=x.session_id WHERE x.id=? AND s.owner=?", args: [id, owner] })).rows[0];
  return row ? { ...solution(row as Row), projectId: String((row as Row).project_id) } : null;
}
export async function setSolutionStatus(id: string, status: CrewSolutionStatus): Promise<void> {
  await db().execute({ sql: "UPDATE crew_solutions SET status=? WHERE id=?", args: [status, id] });
}
export async function removeSolution(owner: string, id: string): Promise<void> {
  await crewReady();
  await archiveAndDelete(db(), "crew_solutions", "id=? AND session_id IN (SELECT id FROM crew_sessions WHERE owner=?)", [id, owner]);
}
