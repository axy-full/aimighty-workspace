import { db, ready, now } from "../db";
import { archiveReady, archiveStatement } from "../archive";
import { invalidateSettings } from "../settings";
import { readDraft, workbenchReady } from "../workbench/records";
import type { TenantUser } from "../tenant";
import { isSampleDraftId, parseSampleMark, SAMPLE_SETTING_KEY, type SampleMark } from "./sample";

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
  return true;
}
