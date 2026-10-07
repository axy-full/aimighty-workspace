import { db, ready, now } from "../db";
import { archiveReady, archiveStatement } from "../archive";
import { invalidateSettings } from "../settings";
import { readDraft, workbenchReady, workbenchTransaction } from "../workbench/records";
import { isPersonApprover } from "../workbench/plan-approval";
import type { TenantUser } from "../tenant";
import {
  endSampleLift, insertSampleLift, liftRun, liveSampleLift, runStillGoing, sampleLiftReady, sampleLifts,
  type LiftEnd, type LiftRow,
} from "./lift.server";
import { isSampleDraftId, parseSampleMark, SAMPLE_SETTING_KEY, type SampleLiftStatus, type SampleMark } from "./sample";

/*
 * The build action: marks one of THIS workspace's own finished productions as the explore-only sample. It reads the
 * workspace's rows only and writes one `settings` row, `sampleProduction`: no take, no ledger row, no meter event,
 * no balance. It is undoable: the previous row is copied to the workspace archive first (never erased), and an undo
 * writes the same row back marked hidden. Callable only for a person who owns the workspace or administers it; the
 * route adds the session check (a token is refused there), and this refuses again so no other caller can skip it.
 */
export class SampleError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "SampleError"; }
}

/** Who may build the sample: a person who owns the workspace or is an admin of it. Atomik's `agent:` identities never. */
export function canBuildSample(user: Pick<TenantUser, "id" | "role" | "owner" | "disabled"> | null | undefined): boolean {
  if (!user || user.disabled) return false;
  if (user.id.startsWith("agent:")) return false;
  return user.owner === true || user.role === "admin";
}

/** The raw stored mark, hidden or not (the archive and the undo read it). */
async function storedMark(): Promise<unknown | null> {
  await ready();
  const row = (await db().execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [SAMPLE_SETTING_KEY] })).rows[0];
  if (!row) return null;
  try { return JSON.parse(String(row.value)); } catch { return null; }
}

/** The workspace's sample, or null when none is marked or the mark was undone. Read fresh: the build is rare and a stale answer would show the wrong card. */
export async function readSampleMark(): Promise<SampleMark | null> {
  return parseSampleMark(await storedMark());
}

export type MarkInput = { draftId?: unknown; projectId?: unknown };

const id100 = (value: unknown): string | null => (typeof value === "string" && value.trim() && value.length <= 100 ? value.trim() : null);

async function writeMark(mark: Record<string, unknown>, by: string, reason: string, hadRow: boolean): Promise<void> {
  await archiveReady();
  const statements = [];
  /* The earlier row goes to the archive in the same write, so nothing a person marked is ever lost. */
  if (hadRow) statements.push(await archiveStatement(db(), "settings", "key = ?", [SAMPLE_SETTING_KEY], { reason, by }));
  statements.push({
    sql: `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    args: [SAMPLE_SETTING_KEY, JSON.stringify(mark), by, now()],
  });
  await db().batch(statements, "write");
  invalidateSettings();
}

/**
 * Mark the caller's own finished production as the sample. Name it by the draft (`draftId`) or by the production
 * (`projectId`, then the caller's newest draft of it). Marking the production that already is the sample changes
 * nothing; another production being the sample must be undone first.
 */
export async function markSampleProduction(input: MarkInput, user: TenantUser): Promise<SampleMark> {
  if (!canBuildSample(user)) throw new SampleError("Only the workspace's owner or an admin can mark the sample production.", 403);
  await workbenchReady();
  const draftId = id100(input.draftId);
  const projectId = id100(input.projectId);
  if (!draftId && !projectId) throw new SampleError("Choose the production to mark.", 400);
  let pickedDraft = draftId;
  if (!pickedDraft) {
    /* Only the caller's own drafts: nobody marks a teammate's private work. */
    const row = (await db().execute({
      sql: `SELECT project_id AS id FROM workbench_projects WHERE owner = ? AND (CASE WHEN json_valid(body) THEN json_extract(body,'$.productionProjectId') END) = ? ORDER BY updated_at DESC LIMIT 1`,
      args: [user.id, projectId],
    })).rows[0];
    pickedDraft = row ? String(row.id) : null;
  }
  if (!pickedDraft || isSampleDraftId(pickedDraft)) throw new SampleError("That production was not found among your own projects.", 404);
  const draft = await readDraft(user.id, pickedDraft);
  if (!draft) throw new SampleError("That production was not found among your own projects.", 404);
  const production = draft.project.productionProjectId;
  if (!production || (projectId && production !== projectId)) throw new SampleError("Save the production first: it has no project in this workspace yet.", 409);
  const found = (await db().execute({ sql: `SELECT id, name FROM projects WHERE id = ?`, args: [production] })).rows[0];
  if (!found) throw new SampleError("That production is not in this workspace.", 404);

  const stored = await storedMark();
  const current = parseSampleMark(stored);
  if (current && current.projectId === production) return current;
  if (current) throw new SampleError("Another production is already the sample. Undo that first.", 409);
  const mark: SampleMark = {
    version: 1, projectId: production, name: String(found.name ?? draft.project.name ?? "").slice(0, 160),
    draftOwner: user.id, draftId: pickedDraft, markedBy: user.id, markedAt: now(),
  };
  await writeMark(mark, user.id, "sample marked again", stored != null);
  return mark;
}

/** Undo the mark: the sample reads as none, every row stays. Returns false when there was nothing to undo. */
export async function hideSampleMark(user: TenantUser): Promise<boolean> {
  if (!canBuildSample(user)) throw new SampleError("Only the workspace's owner or an admin can undo the sample production.", 403);
  const stored = await storedMark();
  const current = parseSampleMark(stored);
  if (!current) return false;
  await writeMark({ ...current, hiddenAt: now(), hiddenBy: user.id }, user.id, "sample undone", true);
  /* No mark, nothing lifted: a lift still open ends with it, so marking again never finds one waiting. */
  const lift = await liveSampleLift();
  if (lift) await endSampleLift(db(), lift.id, "unmarked", now(), user.id);
  return true;
}

/* ── The one-run lift (owner, 7 Oct; lib/demo/lift.server.ts) ─────────── */

const LIFT_PEOPLE = "Only the workspace's owner or an admin can lift the sample mark.";

/**
 * Lift the mark for one run: the caller's next ask of Atomik on a board (`runId` left out), or a run of their own that
 * is still going (`runId`, say one whose earlier lift ran out mid-way). People only: an owner or an admin, signed in;
 * never Atomik, an outside agent, an MCP caller, a token or a guest. One lift at a time. It ends by itself.
 */
export async function liftSampleMark(user: TenantUser, input: { runId?: unknown } = {}): Promise<LiftRow> {
  if (!canBuildSample(user) || !isPersonApprover(user.id)) throw new SampleError(LIFT_PEOPLE, 403);
  if (!(await readSampleMark())) throw new SampleError("This workspace has no sample mark to lift.", 409);
  const runId = input.runId == null || input.runId === "" ? null : id100(input.runId);
  if (input.runId != null && input.runId !== "" && !runId) throw new SampleError("Choose the run to lift the mark for.", 400);
  await sampleLiftReady();
  return workbenchTransaction(async (tx) => {
    if (await liveSampleLift(tx)) throw new SampleError("The mark is already lifted for one run.", 409);
    let run: { id: string; productionId: string } | null = null;
    if (runId) {
      const found = await liftRun(tx, runId);
      if (!found || found.owner !== user.id || !runStillGoing(found)) throw new SampleError("Lift it for one of your own runs that is still going, or for your next one.", 409);
      /* One APPROVED run: never a run in Auto, whose drafts would go without a person's tap. */
      if (found.mode !== "ask") throw new SampleError("That run spends without asking (Auto). Lift it for your next run instead.", 409);
      run = { id: runId, productionId: found.productionId };
    }
    return insertSampleLift(tx, { by: user.id, at: now(), run });
  });
}

/** Put the mark back now. False when nothing was lifted. The same people as the lift. */
export async function putSampleMarkBack(user: TenantUser): Promise<boolean> {
  if (!canBuildSample(user) || !isPersonApprover(user.id)) throw new SampleError("Only the workspace's owner or an admin can put the sample mark back.", 403);
  return workbenchTransaction(async (tx) => {
    const lift = await liveSampleLift(tx);
    return lift ? endSampleLift(tx, lift.id, "put_back", now(), user.id) : false;
  });
}

/** What the board reads: whether the mark is lifted now, and for whom (no names, no record). */
export async function sampleLiftStatus(viewer: string): Promise<SampleLiftStatus> {
  const lift = (await readSampleMark()) ? await liveSampleLift() : null;
  return lift
    ? { lifted: true, mine: lift.liftedBy === viewer, productionId: lift.productionId, runId: lift.runId, expiresAt: lift.expiresAt }
    : { lifted: false, mine: false, productionId: null, runId: null, expiresAt: null };
}

/** One lift as an admin reads it in Settings: who, when, for which run, and when and why the mark came back. */
export type LiftRecord = {
  id: string; by: string; at: number; until: number;
  run: { id: string; goal: string | null } | null;
  backAt: number | null; why: LiftEnd | null; backBy: string | null;
};

/** The workspace's lifts, newest first, with people's names (owners and admins only: the route checks, and so does this). */
export async function sampleLiftRecord(user: TenantUser, limit = 10): Promise<LiftRecord[]> {
  if (!canBuildSample(user)) throw new SampleError(LIFT_PEOPLE, 403);
  const rows = await sampleLifts(limit);
  if (!rows.length) return [];
  const people = [...new Set(rows.flatMap((r) => [r.liftedBy, r.endedBy]).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  const named = await db().execute({ sql: `SELECT id, name FROM users WHERE id IN (${people.map(() => "?").join(",")})`, args: people }).catch(() => null);
  for (const r of named?.rows ?? []) if (r.name) names.set(String(r.id), String(r.name));
  const runs = [...new Set(rows.map((r) => r.runId).filter((v): v is string => !!v))];
  const goals = new Map<string, string>();
  if (runs.length) {
    const found = await db().execute({ sql: `SELECT id, goal FROM rig_agent_runs WHERE id IN (${runs.map(() => "?").join(",")})`, args: runs }).catch(() => null);
    for (const r of found?.rows ?? []) goals.set(String(r.id), String(r.goal ?? ""));
  }
  const nameOf = (id: string) => (id === user.id ? "You" : names.get(id) ?? "A former member");
  return rows.map((r) => ({
    id: r.id, by: nameOf(r.liftedBy), at: r.liftedAt, until: r.expiresAt,
    run: r.runId ? { id: r.runId, goal: goals.get(r.runId) || null } : null,
    backAt: r.endedAt, why: r.endedReason, backBy: r.endedBy ? nameOf(r.endedBy) : null,
  }));
}

