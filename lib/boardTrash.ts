import { randomUUID } from "node:crypto";
import type { InStatement, Transaction } from "@libsql/client";
import { db, ready } from "./db";
import { archiveDeleteStatements, archiveTransaction } from "./archive";
import { markGenerationDeletion, markGenerationRestored, mediaDeletionReady, recordTakeInTrash } from "./mediaDeletion";
import { isAgentId } from "./security/people-only";
import { mediaBindingProblem } from "./mediaBindings";
import { mayReachProject } from "./draftProject";
import { NOT_YOURS, mayChangeWork, type Actor } from "./workAccess";
import { workbenchReady, workbenchTransaction } from "./workbench/records";

/**
 * A board's Trash (owner, 13 Oct 2026): everything removed from a board goes here, paid or not, and can be restored at any time. Nothing is erased,
 * and nothing here touches billing: a removed take keeps its cost, its ledger line and its bytes; restoring puts it back as it was.
 *
 * Two sorts of item (browser items are the remover's alone: each person's draft is private, so a person lists and restores only what they removed, an admin
 * and a teammate of a shared board included; a take or a shot is the board's, and whoever may change that work may put it back):
 *  - SERVER items the server removes itself, as one write: a take (hidden, `deleted=1`, never erased: the clean-up that frees a deleted take's bytes skips
 *    one in the Trash) and a shot (its row and wires archived as ever, its takes unfiled, and what is needed to put it all back kept here).
 *  - CLIENT items the board holds in the person's draft (a card, a note, a piece of text, a storyboard frame, a look, a beat, a cast entry...): the browser
 *    removes it from the draft and records what it removed here, whole; restoring claims the record (once) and hands it back for the browser to put back.
 *
 * A board is a project (the production's `projects` row). Everything here is scoped to this workspace's database and to a board the person may WRITE
 * (lib/draftProject.ts mayReachProject): a private board's Trash is its owner's, as the board is; to anyone else the board is as absent as an unknown id.
 * The Trash is a list for the people who can edit the board, not for people who only look at it.
 */
export const SERVER_KINDS = ["take", "shot"] as const;
export const CLIENT_KINDS = ["card", "note", "text", "frame", "look", "beat", "cast", "reference", "group"] as const;
export type TrashKind = (typeof SERVER_KINDS)[number] | (typeof CLIENT_KINDS)[number];
export const isTrashKind = (value: unknown): value is TrashKind => [...SERVER_KINDS, ...CLIENT_KINDS].includes(value as TrashKind);
const isServerKind = (kind: TrashKind): kind is (typeof SERVER_KINDS)[number] => (SERVER_KINDS as readonly string[]).includes(kind);

export const PAYLOAD_MAX_BYTES = 200_000;
/** Open browser records one person may hold on one board (a person's own removals; past it, put something back first). */
export const CLIENT_CAP = 500;
/** A refusal inside a write that must roll back whatever it had done (a claim included). */
class Refusal extends Error {}
export const TRASH_LIST_LIMIT = 500;
const ID = /^[A-Za-z0-9_:.-]{1,160}$/;

export type TrashEntry = {
  id: string; kind: TrashKind; itemId: string; label: string;
  removedBy: { id: string; name: string | null } | null; removedAt: number;
  restorable: boolean; why: string | null;
};
export type TrashFailure = { ok: false; status: number; error: string };
const fail = (status: number, error: string): TrashFailure => ({ ok: false, status, error });
const UNKNOWN_BOARD = "No such board.";

/**
 * The board the person may write, or why not. An unknown board and one they may not reach answer the same; the sample is nobody's to write
 * (lib/demo/readonly.server.ts). `person` is the signed-in user (a token acts as its person).
 */
async function board(person: Actor & { id: string }, projectId: string, write: boolean): Promise<{ ok: true } | TrashFailure> {
  await ready();
  const known = (await db().execute({ sql: "SELECT 1 FROM projects WHERE id=? LIMIT 1", args: [projectId] })).rows.length > 0;
  if (!known) return fail(404, UNKNOWN_BOARD);
  /* The sample is everyone's to look at and nobody's to write: its refusal comes first (the board's reach, below, would only call it absent). */
  if (write) {
    const { sampleWriteRefusal } = await import("./demo/readonly.server");
    const refused = await sampleWriteRefusal(projectId, person);
    if (refused) return fail(refused.status, ((await refused.json().catch(() => ({}))) as { error?: string }).error ?? "This board is view-only.");
  }
  if (!(await mayReachProject(person, projectId, "write"))) return fail(404, UNKNOWN_BOARD);
  return { ok: true };
}

const clean = (text: unknown, max: number) => String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const entryOf = (row: Record<string, unknown>, names: Map<string, string>, restorable = true, why: string | null = null): TrashEntry => ({
  id: String(row.id), kind: String(row.kind) as TrashKind, itemId: String(row.item_id), label: String(row.label ?? ""),
  removedBy: row.removed_by ? { id: String(row.removed_by), name: names.get(String(row.removed_by)) ?? null } : null,
  removedAt: Number(row.removed_at), restorable, why,
});
async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const people = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, string>();
  if (!people.length) return out;
  for (const row of (await db().execute({ sql: `SELECT id, name FROM users WHERE id IN (${people.map(() => "?").join(",")})`, args: people })).rows) if (row.name) out.set(String(row.id), String(row.name));
  return out;
}

/** What a take in the Trash can still be put back from: its original must still be stored. */
function takeRestorable(row: Record<string, unknown>, pendingLease: boolean): { ok: boolean; why: string | null } {
  if (pendingLease || (row.stored_url == null && !Number(row.bytes ?? 0))) return { ok: false, why: "This render's original has already been removed; it cannot be restored." };
  return { ok: true, why: null };
}

/** The board's Trash, newest first: what is in it and who removed it. A render hidden before the Trash existed is listed too (no one is recorded for it). */
export async function listTrash(person: Actor & { id: string }, projectId: string): Promise<{ ok: true; items: TrashEntry[] } | TrashFailure> {
  await ready(); await mediaDeletionReady();
  const allowed = await board(person, projectId, false);
  if (!allowed.ok) return allowed;
  const recorded = (await db().execute({ sql: "SELECT id, kind, item_id, label, removed_by, removed_at FROM board_trash WHERE project_id=? AND restored_at IS NULL AND (holder='' OR holder=?) ORDER BY removed_at DESC, id DESC LIMIT ?", args: [projectId, person.id, TRASH_LIST_LIMIT] })).rows as Record<string, unknown>[];
  const takes = new Map<string, { ok: boolean; why: string | null }>();
  const takeIds = recorded.filter((row) => row.kind === "take").map((row) => String(row.item_id));
  const legacy = (await db().execute({ sql: `SELECT g.id, g.title, g.prompt, g.updated_at, g.stored_url, g.bytes, d.lease FROM generations g LEFT JOIN generation_deletions d ON d.id=g.id
      WHERE g.project_id=? AND g.deleted=1 AND g.id NOT IN (SELECT item_id FROM board_trash WHERE kind='take' AND project_id=? AND restored_at IS NULL) ORDER BY g.updated_at DESC LIMIT ?`, args: [projectId, projectId, TRASH_LIST_LIMIT] })).rows as Record<string, unknown>[];
  if (takeIds.length) for (const row of (await db().execute({ sql: `SELECT g.id, g.stored_url, g.bytes, d.lease FROM generations g LEFT JOIN generation_deletions d ON d.id=g.id WHERE g.id IN (${takeIds.map(() => "?").join(",")})`, args: takeIds })).rows as Record<string, unknown>[]) takes.set(String(row.id), takeRestorable(row, row.lease != null));
  const names = await namesOf(recorded.map((row) => String(row.removed_by)));
  const items = [
    ...recorded.map((row) => { const t = row.kind === "take" ? takes.get(String(row.item_id)) : undefined; return entryOf(row, names, t?.ok ?? true, t?.why ?? null); }),
    ...legacy.map((row) => { const t = takeRestorable(row, row.lease != null); return { id: `take:${row.id}`, kind: "take" as const, itemId: String(row.id), label: clean(row.title || row.prompt, 80), removedBy: null, removedAt: Number(row.updated_at), restorable: t.ok, why: t.why }; }),
  ].sort((a, b) => b.removedAt - a.removedAt).slice(0, TRASH_LIST_LIMIT);
  return { ok: true, items };
}

export type RemoveInput = { kind?: unknown; itemId?: unknown; label?: unknown; payload?: unknown };

/** Removes one thing from the board into its Trash. Server items are removed here; client items are recorded (the browser has already taken them out of its draft). */
export async function removeToTrash(person: Actor & { id: string }, projectId: string, input: RemoveInput): Promise<{ ok: true; entry: TrashEntry } | TrashFailure> {
  await ready(); await mediaDeletionReady(); await workbenchReady();
  const allowed = await board(person, projectId, true);
  if (!allowed.ok) return allowed;
  if (!isTrashKind(input.kind)) return fail(400, "Choose what is being removed.");
  const itemId = String(input.itemId ?? "");
  if (!ID.test(itemId)) return fail(400, "Name the item that was removed.");
  const kind = input.kind;
  const label = clean(input.label, 160);
  const at = Date.now();

  if (kind === "take") {
    /* Who may is asked before the write opens (a question asked inside it would wait on its own write lock). */
    const row = (await db().execute({ sql: "SELECT project_id, created_by, title, prompt FROM generations WHERE id=?", args: [itemId] })).rows[0];
    /* A take that is not on this board is an unknown take. */
    if (!row || String(row.project_id ?? "") !== projectId) return fail(404, "No such take on this board.");
    if (!(await mayChangeWork(person, { createdBy: row.created_by == null ? null : String(row.created_by), projectId }))) return fail(403, NOT_YOURS.take);
    const result = await workbenchTransaction(async (tx) => {
      const now = (await tx.execute({ sql: "SELECT status, deleted FROM generations WHERE id=?", args: [itemId] })).rows[0];
      if (!now) return fail(404, "No such take on this board.");
      if (["queued", "running"].includes(String(now.status))) return fail(409, "This take is still rendering. Wait for it to finish before removing it.");
      if (String(now.status) === "held") return fail(409, "This take is waiting for approval. Discard it from the approvals queue instead.");
      const binding = await mediaBindingProblem(tx, "generation", itemId);
      if (binding) return fail(409, binding);
      if (!Number(now.deleted)) await markGenerationDeletion(tx, itemId, at, person.id);
      await recordTakeInTrash(tx, itemId, person.id, at);
      const open = (await tx.execute({ sql: "SELECT id, kind, item_id, label, removed_by, removed_at FROM board_trash WHERE project_id=? AND kind='take' AND item_id=? AND restored_at IS NULL", args: [projectId, itemId] })).rows[0] as Record<string, unknown> | undefined;
      return open ? entryOf(open, new Map()) : fail(409, "This take could not be added to the Trash.");
    });
    if ("ok" in result && !result.ok) return result;
    return { ok: true, entry: await withName(result as TrashEntry) };
  }

  if (kind === "shot") {
    const shot = (await db().execute({ sql: "SELECT * FROM shots WHERE id=?", args: [itemId] })).rows[0] as Record<string, unknown> | undefined;
    if (!shot || String(shot.project_id ?? "") !== projectId) return fail(404, "No such shot on this board.");
    if (!(await mayChangeWork(person, { createdBy: shot.created_by == null ? null : String(shot.created_by), projectId }))) return fail(403, NOT_YOURS.shot);
    const entry = await archiveTransaction(async (tx) => {
      const takeIds = (await tx.execute({ sql: "SELECT id FROM generations WHERE shot_id=?", args: [itemId] })).rows.map((r) => String(r.id));
      const wires = (await tx.execute({ sql: "SELECT * FROM bindings WHERE shot_id=?", args: [itemId] })).rows.map((r) => ({ ...r }));
      const payload = JSON.stringify({ shot: { ...shot }, takeIds, bindings: wires });
      const recorded = await recordStatement(tx, projectId, "shot", itemId, label || clean(shot.title || shot.code, 80), payload, person.id, at);
      if ("error" in recorded) return recorded;
      await tx.batch([
        { sql: "UPDATE generations SET shot_id = NULL WHERE shot_id = ?", args: [itemId] },
        ...(await archiveDeleteStatements(tx, [{ table: "bindings", where: "shot_id = ?", args: [itemId] }, { table: "shots", where: "id = ?", args: [itemId] }])),
      ]);
      return recorded.entry;
    });
    if ("error" in entry) return fail(409, entry.error);
    return { ok: true, entry: await withName(entry) };
  }

  /* A client item: whole, as the browser took it out. */
  if (input.payload === undefined || input.payload === null || typeof input.payload !== "object") return fail(400, "Send what was removed, whole, so it can be put back.");
  const payload = JSON.stringify(input.payload);
  if (Buffer.byteLength(payload) > PAYLOAD_MAX_BYTES) return fail(413, "That is too large to keep in the Trash in one piece.");
  const entry = await workbenchTransaction(async (tx) => record(tx, projectId, kind, itemId, label || kind, payload, person.id, at));
  if ("ok" in entry) return entry;
  return { ok: true, entry: await withName(entry) };
}

/**
 * One record in the Trash. A shot is the board's (one record, whoever removed it); a browser item is the remover's own: the same person removing the same item
 * twice is one record, and another person's record of the same id is a different one (nobody can pre-empt another's), capped per person per board.
 */
async function recordStatement(tx: Transaction, projectId: string, kind: TrashKind, itemId: string, label: string, payload: string | null, by: string, at: number): Promise<{ entry: TrashEntry } | { error: string }> {
  const holder = isServerKind(kind) ? "" : by;
  const existing = (await tx.execute({ sql: "SELECT id, kind, item_id, label, removed_by, removed_at FROM board_trash WHERE project_id=? AND kind=? AND item_id=? AND holder=? AND restored_at IS NULL", args: [projectId, kind, itemId, holder] })).rows[0] as Record<string, unknown> | undefined;
  if (existing) {
    if (kind === "shot") return { error: "This shot is already in the Trash." };
    return { entry: entryOf(existing, new Map()) };
  }
  if (holder) {
    const held = Number((await tx.execute({ sql: "SELECT COUNT(*) AS n FROM board_trash WHERE project_id=? AND holder=? AND restored_at IS NULL", args: [projectId, holder] })).rows[0]?.n ?? 0);
    if (held >= CLIENT_CAP) return { error: `Your Trash for this board already holds ${CLIENT_CAP} items, the most it keeps at once. Put something back first.` };
  }
  const id = randomUUID();
  await tx.execute({ sql: "INSERT INTO board_trash(id,project_id,kind,item_id,label,payload,removed_by,removed_at,holder) VALUES(?,?,?,?,?,?,?,?,?)", args: [id, projectId, kind, itemId, label, payload, by, at, holder] });
  return { entry: entryOf({ id, kind, item_id: itemId, label, removed_by: by, removed_at: at }, new Map()) };
}
async function record(tx: Transaction, projectId: string, kind: TrashKind, itemId: string, label: string, payload: string | null, by: string, at: number): Promise<TrashEntry | TrashFailure> {
  const out = await recordStatement(tx, projectId, kind, itemId, label, payload, by, at);
  return "error" in out ? fail(409, out.error) : out.entry;
}
async function withName(entry: TrashEntry): Promise<TrashEntry> {
  if (!entry.removedBy) return entry;
  const names = await namesOf([entry.removedBy.id]);
  return { ...entry, removedBy: { id: entry.removedBy.id, name: names.get(entry.removedBy.id) ?? null } };
}

export type Restored = { ok: true; entry: TrashEntry; payload: unknown | null };

/** Puts one thing back. Restoring never touches billing: a take comes back as it was, a shot with its wires and the takes that were filed under it. */
export async function restoreFromTrash(person: Actor & { id: string }, projectId: string, entryId: string): Promise<Restored | TrashFailure> {
  await ready(); await mediaDeletionReady(); await workbenchReady();
  const allowed = await board(person, projectId, true);
  if (!allowed.ok) return allowed;
  if (!ID.test(entryId)) return fail(404, "Nothing like that is in the Trash.");
  const at = Date.now();

  /* A render hidden before the Trash existed is `take:<id>`. */
  const legacyTake = entryId.startsWith("take:") ? entryId.slice(5) : null;
  const row = legacyTake
    ? ({ id: entryId, kind: "take", item_id: legacyTake, label: "", payload: null, removed_by: "", removed_at: 0 } as Record<string, unknown>)
    : ((await db().execute({ sql: "SELECT * FROM board_trash WHERE id=? AND project_id=? AND restored_at IS NULL AND (holder='' OR holder=?)", args: [entryId, projectId, person.id] })).rows[0] as Record<string, unknown> | undefined);
  if (!row) return fail(404, "Nothing like that is in the Trash.");
  /* An agent run puts back only what it removed itself: someone else's removal is theirs to put back (and an unrecorded one has no remover). */
  if (isAgentId(person.id) && String(row.removed_by ?? "") !== person.id) return fail(404, "Nothing like that is in the Trash.");
  const kind = String(row.kind) as TrashKind;
  const itemId = String(row.item_id);

  if (kind === "take") {
    const take = (await db().execute({ sql: "SELECT project_id, created_by FROM generations WHERE id=?", args: [itemId] })).rows[0] as Record<string, unknown> | undefined;
    if (!take || String(take.project_id ?? "") !== projectId) return fail(404, "Nothing like that is in the Trash.");
    if (!(await mayChangeWork(person, { createdBy: take.created_by == null ? null : String(take.created_by), projectId }))) return fail(403, NOT_YOURS.take);
    const problem = await workbenchTransaction(async (tx): Promise<TrashFailure | null> => {
      const now = (await tx.execute({ sql: "SELECT deleted, stored_url, bytes FROM generations WHERE id=?", args: [itemId] })).rows[0] as Record<string, unknown> | undefined;
      if (!now) return fail(404, "Nothing like that is in the Trash.");
      if (Number(now.deleted)) {
        const pending = (await tx.execute({ sql: "SELECT lease FROM generation_deletions WHERE id=?", args: [itemId] })).rows[0];
        const state = takeRestorable(now, !!pending && pending.lease != null);
        if (!state.ok) return fail(409, state.why!);
        await tx.execute({ sql: "DELETE FROM generation_deletions WHERE id=?", args: [itemId] });
        await tx.execute({ sql: "UPDATE generations SET deleted=0, updated_at=? WHERE id=?", args: [at, itemId] });
      }
      /* Its open record is closed whichever id put it back (`take:<id>` included). */
      await markGenerationRestored(tx, itemId, person.id, at);
      return null;
    });
    if (problem) return problem;
    return { ok: true, entry: entryOf({ ...row, label: String(row.label ?? "") }, new Map(), true), payload: null };
  }

  if (kind === "shot") {
    let payload: { shot: Record<string, unknown>; takeIds: string[]; bindings: Record<string, unknown>[] };
    try { payload = JSON.parse(String(row.payload)); } catch { return fail(409, "This shot cannot be put back: its record is unreadable."); }
    if (!(await mayChangeWork(person, { createdBy: payload.shot?.created_by == null ? null : String(payload.shot.created_by), projectId }))) return fail(403, NOT_YOURS.shot);
    /* Every refusal throws inside the write so the claim rolls back with everything else: a shot that could not be put back is still in the Trash. */
    const problem = await archiveTransaction(async (tx): Promise<string | null> => {
      const claimed = await tx.execute({ sql: "UPDATE board_trash SET restored_by=?, restored_at=? WHERE id=? AND restored_at IS NULL", args: [person.id, at, entryId] });
      if (!claimed.rowsAffected) throw new Refusal("Already restored.");
      if ((await tx.execute({ sql: "SELECT 1 FROM shots WHERE id=?", args: [itemId] })).rows.length) throw new Refusal("A shot with this id is already on the board.");
      const columns = (await tx.execute("PRAGMA table_info(shots)")).rows.map((r) => String(r.name));
      const keep = columns.filter((c) => c in payload.shot);
      await tx.execute({ sql: `INSERT INTO shots(${keep.join(",")}) VALUES(${keep.map(() => "?").join(",")})`, args: keep.map((c) => payload.shot[c] as never) });
      const bindingColumns = (await tx.execute("PRAGMA table_info(bindings)")).rows.map((r) => String(r.name));
      const statements: InStatement[] = payload.bindings.map((wire) => {
        const cols = bindingColumns.filter((c) => c in wire);
        return { sql: `INSERT OR IGNORE INTO bindings(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, args: cols.map((c) => wire[c] as never) };
      });
      /* The takes that were filed under it, if they are still unfiled and still on this board. */
      for (const id of payload.takeIds) statements.push({ sql: "UPDATE generations SET shot_id=? WHERE id=? AND shot_id IS NULL AND project_id=?", args: [itemId, id, projectId] });
      if (statements.length) await tx.batch(statements);
      return null;
    }).catch((error: unknown) => {
      if (error instanceof Refusal) return error.message;
      if (/UNIQUE|constraint/i.test(String(error))) return "A shot with this number is already on the board. Rename or remove it, then restore this one.";
      return Promise.reject(error);
    });
    if (problem) return fail(409, problem);
    return { ok: true, entry: entryOf(row, new Map()), payload: null };
  }

  /* A client item: claimed once, handed back whole. */
  const claimed = await db().execute({ sql: "UPDATE board_trash SET restored_by=?, restored_at=? WHERE id=? AND holder=? AND restored_at IS NULL", args: [person.id, at, entryId, person.id] });
  if (!claimed.rowsAffected) return fail(409, "Already restored.");
  let payload: unknown = null;
  try { payload = JSON.parse(String(row.payload)); } catch { payload = null; }
  return { ok: true, entry: entryOf(row, new Map()), payload };
}
