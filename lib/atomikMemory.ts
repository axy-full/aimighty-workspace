import type { Client, InStatement } from "@libsql/client";
import { db, ready, now, id as newId } from "./db";
import { requireTenant } from "./tenant";
import { archiveDeleteStatements, archiveStatement, archiveTransaction } from "./archive";
import {
  IMPORT_FROM, LIBRARY_ASSET, MEMORY_ID, MEMORY_LIMITS, MONEY_REFUSAL, PROJECT_ID,
  cleanMemoryText, forgetMatches, isMemoryKind, memoryLines, mentionsMoney, parseImport, parseMemoryCommand, rankForPlanner,
  type ImportFrom, type MemoryEntry, type MemoryKind, type MemorySource, type MemoryStatus, type MemoryView, type PlannerMemoryItem,
} from "./atomikMemoryText";

export type { MemoryEntry, MemoryView } from "./atomikMemoryText";

/**
 * Atomik memory: what a workspace asked its agent to keep in mind across
 * chats and projects — brand, audience, references (Library assets, by id),
 * approved identities and notes.
 *
 * Every entry belongs to one workspace, and to one project where it has one;
 * an entry with no project is the whole workspace's. The table lives in the
 * workspace's own database AND carries workspace_id, and every read and write
 * filters on it: two workspaces never see each other's memory, and one
 * project never reads another's.
 *
 * Nothing is kept silently. A person adds an entry ("Remember this" on a
 * message or an asset, or the Memory page), or accepts one Atomik proposed or
 * a paste from another assistant turned into; until then it waits as
 * `proposed` and no planner reads it. Forget archives through lib/archive.ts
 * (the whole row, copied to archived_rows in the same write) — nothing a
 * team makes is erased — and an edit archives the version it replaces.
 *
 * Memory costs nothing: no route here calls a model or a vendor.
 */

export class MemoryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "MemoryError"; }
}

const TABLE = "atomik_memory";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLE}(
     workspace_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT,
     kind TEXT NOT NULL, text TEXT NOT NULL,
     asset_id TEXT, asset_label TEXT, asset_kind TEXT,
     status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'person', origin TEXT,
     created_by TEXT NOT NULL, accepted_by TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, accepted_at INTEGER,
     PRIMARY KEY(workspace_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_atomik_memory_scope ON ${TABLE}(workspace_id, project_id, status, updated_at)`,
];

const initialized = new WeakMap<Client, Promise<void>>();
/** The table, created on first use in this workspace's database (additive: nothing else changes). */
export async function memoryReady(): Promise<void> {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(client, client.batch(SCHEMA, "write").then(() => undefined).catch((error) => {
      initialized.delete(client);
      throw error;
    }));
  await initialized.get(client);
}

type Row = Record<string, unknown>;
const text = (value: unknown) => (value == null ? null : String(value));
function toEntry(r: Row): MemoryEntry {
  return {
    id: String(r.id), kind: (isMemoryKind(r.kind) ? r.kind : "note") as MemoryKind, text: String(r.text ?? ""),
    projectId: text(r.project_id), assetId: text(r.asset_id), assetLabel: text(r.asset_label), assetKind: text(r.asset_kind),
    status: r.status === "proposed" ? "proposed" : "active",
    source: r.source === "atomik" || r.source === "import" ? r.source : "person",
    origin: text(r.origin), createdBy: String(r.created_by ?? ""), acceptedBy: text(r.accepted_by),
    createdAt: Number(r.created_at ?? 0), updatedAt: Number(r.updated_at ?? 0), acceptedAt: r.accepted_at == null ? null : Number(r.accepted_at),
  };
}

/** Workspace-wide entries, plus the project's own when one is open; never another project's. */
function scoped(projectId: string | null): { sql: string; args: string[] } {
  return projectId ? { sql: "(project_id IS NULL OR project_id = ?)", args: [projectId] } : { sql: "project_id IS NULL", args: [] };
}

function projectOf(value: unknown): string | null {
  if (value == null || value === "") return null;
  const id = String(value);
  if (!PROJECT_ID.test(id)) throw new MemoryError("Choose a saved project, or keep it for the whole workspace.");
  return id;
}

async function projectExists(projectId: string): Promise<boolean> {
  return (await db().execute({ sql: "SELECT 1 FROM projects WHERE id = ? LIMIT 1", args: [projectId] })).rows.length > 0;
}

const mimeKind = (mime: string) => (/^image\//.test(mime) ? "image" : /^video\//.test(mime) ? "video" : /^audio\//.test(mime) ? "audio" : "file");

/** A Library asset of this workspace's, by its Library id, with the name and kind it is shown by; null when it is not there. */
async function libraryAsset(assetId: string): Promise<{ label: string; kind: string | null } | null> {
  const m = LIBRARY_ASSET.exec(assetId);
  if (!m) return null;
  if (m[1] === "generation") {
    const r = (await db().execute({ sql: "SELECT * FROM generations WHERE id = ? LIMIT 1", args: [m[2]] })).rows[0] as Row | undefined;
    if (!r || Number(r.deleted ?? 0) === 1) return null;
    return { label: cleanMemoryText(String(r.title || r.prompt || "Untitled take"), 120), kind: r.kind ? String(r.kind) : null };
  }
  const r = (await db().execute({ sql: "SELECT * FROM uploads WHERE id = ? LIMIT 1", args: [m[2]] })).rows[0] as Row | undefined;
  if (!r) return null;
  return { label: cleanMemoryText(String(r.filename ?? "Upload"), 120), kind: r.kind ? String(r.kind) : mimeKind(String(r.mime ?? "")) };
}

/** Which of these Library assets are still in the Library. */
async function assetsPresent(ids: string[]): Promise<Set<string>> {
  const present = new Set<string>();
  const byOrigin = { generation: [] as string[], upload: [] as string[] };
  for (const id of new Set(ids)) {
    const m = LIBRARY_ASSET.exec(id);
    if (m) byOrigin[m[1] as "generation" | "upload"].push(m[2]);
  }
  for (const origin of ["generation", "upload"] as const) {
    const list = byOrigin[origin];
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      const marks = chunk.map(() => "?").join(",");
      const rs = await db().execute({
        sql: origin === "generation"
          ? `SELECT id FROM generations WHERE id IN (${marks}) AND COALESCE(deleted, 0) = 0`
          : `SELECT id FROM uploads WHERE id IN (${marks})`,
        args: chunk,
      });
      for (const r of rs.rows) present.add(`${origin}:${String(r.id)}`);
    }
  }
  return present;
}

type Checked = { kind: MemoryKind; text: string; projectId: string | null; assetId: string | null; assetLabel: string | null; assetKind: string | null };

/** An entry as it may be stored, or the reason it may not. */
async function checked(input: { kind: unknown; text: unknown; projectId: unknown; assetId: unknown }, known?: Pick<MemoryEntry, "assetId" | "assetLabel" | "assetKind">): Promise<Checked> {
  if (!isMemoryKind(input.kind)) throw new MemoryError("Choose what kind of memory this is: brand, audience, reference, approved identity or note.");
  const kind = input.kind;
  const words = cleanMemoryText(input.text);
  const projectId = projectOf(input.projectId);
  if (projectId && !(await projectExists(projectId))) throw new MemoryError("That project is not in this workspace. Keep it for the whole workspace instead.", 404);
  const assetId = input.assetId == null || input.assetId === "" ? null : String(input.assetId);
  if (kind === "reference" && !assetId) throw new MemoryError("A reference is an asset from the Library: open it there and choose Remember.");
  if (assetId && kind !== "reference" && kind !== "identity") throw new MemoryError("Only a reference or an approved identity points at an asset.");
  let asset: { label: string; kind: string | null } | null = null;
  if (assetId) {
    if (!LIBRARY_ASSET.test(assetId)) throw new MemoryError("A reference is a Library asset.");
    /* An edit keeps the asset the entry was saved with, even after the asset has left the Library. */
    asset = known && known.assetId === assetId ? { label: known.assetLabel ?? "Asset", kind: known.assetKind } : await libraryAsset(assetId);
    if (!asset) throw new MemoryError("That asset is not in this workspace's Library.", 404);
  }
  if (!asset && words.length < 2) throw new MemoryError("Say what Atomik should remember.");
  if (mentionsMoney(words) || (asset && mentionsMoney(asset.label))) throw new MemoryError(MONEY_REFUSAL, 422);
  return { kind, text: words, projectId, assetId, assetLabel: asset?.label ?? null, assetKind: asset?.kind ?? null };
}

const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9#@]+/g, " ").trim();

async function duplicateOf(workspaceId: string, entry: Checked): Promise<MemoryEntry | null> {
  const rs = await db().execute({
    sql: `SELECT * FROM ${TABLE} WHERE workspace_id = ? AND kind = ? AND project_id IS ? AND COALESCE(asset_id, '') = ?`,
    args: [workspaceId, entry.kind, entry.projectId, entry.assetId ?? ""],
  });
  const key = normal(entry.text);
  const found = rs.rows.map((r) => toEntry(r as Row)).filter((e) => normal(e.text) === key);
  return found.find((e) => e.status === "active") ?? found[0] ?? null;
}

async function count(workspaceId: string): Promise<number> {
  return Number((await db().execute({ sql: `SELECT COUNT(*) AS n FROM ${TABLE} WHERE workspace_id = ?`, args: [workspaceId] })).rows[0]?.n ?? 0);
}

const FULL = `Memory holds ${MEMORY_LIMITS.workspaceEntries} entries. Forget some you no longer need, then add this again.`;

function insert(workspaceId: string, id: string, e: Checked, meta: { status: MemoryStatus; source: MemorySource; origin: string | null; by: string; at: number }): InStatement {
  const accepted = meta.status === "active";
  return {
    sql: `INSERT INTO ${TABLE}(workspace_id, id, project_id, kind, text, asset_id, asset_label, asset_kind, status, source, origin,
            created_by, accepted_by, created_at, updated_at, accepted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [workspaceId, id, e.projectId, e.kind, e.text, e.assetId, e.assetLabel, e.assetKind, meta.status, meta.source, meta.origin,
      meta.by, accepted ? meta.by : null, meta.at, meta.at, accepted ? meta.at : null],
  };
}

async function entryById(workspaceId: string, id: string): Promise<MemoryEntry | null> {
  const r = (await db().execute({ sql: `SELECT * FROM ${TABLE} WHERE workspace_id = ? AND id = ?`, args: [workspaceId, id] })).rows[0] as Row | undefined;
  return r ? toEntry(r) : null;
}

/**
 * A person keeps something: saved active, by them. `source: "atomik"` is a
 * person accepting what Atomik proposed (an assumption from the Agent); the
 * person who pressed Remember is who accepted it. The same entry saved twice
 * is one entry; one that was waiting as a proposal is accepted instead.
 */
export async function addMemory(input: { kind: unknown; text?: unknown; projectId?: unknown; assetId?: unknown; source?: unknown; origin?: unknown }, by: string): Promise<MemoryEntry> {
  await memoryReady();
  const workspaceId = requireTenant().id;
  const entry = await checked({ kind: input.kind, text: input.text, projectId: input.projectId, assetId: input.assetId });
  const source: MemorySource = input.source === "atomik" ? "atomik" : "person";
  const origin = typeof input.origin === "string" && /^[\w:.-]{1,120}$/.test(input.origin) ? input.origin : null;
  const same = await duplicateOf(workspaceId, entry);
  if (same?.status === "active") return same;
  if (same) return updateMemory(same.id, { accept: true }, by);
  if ((await count(workspaceId)) >= MEMORY_LIMITS.workspaceEntries) throw new MemoryError(FULL, 409);
  const id = newId("mem");
  await db().execute(insert(workspaceId, id, entry, { status: "active", source, origin, by, at: now() }));
  return (await entryById(workspaceId, id))!;
}

/**
 * Entries waiting for a person: what Atomik proposed in a planning turn, or
 * what a paste from another assistant turned into. None is read by a planner
 * until someone accepts it. Anything invalid, about money, already kept or
 * past the workspace's limit is skipped and counted, never an error: a
 * proposal must not fail the turn that made it.
 */
export async function proposeMemory(items: readonly { kind: unknown; text: unknown }[], meta: { source: "atomik" | "import"; origin: string | null; projectId: string | null; by: string }): Promise<{ entries: MemoryEntry[]; skipped: { invalid: number; duplicates: number; beyondLimit: number } }> {
  await memoryReady();
  const workspaceId = requireTenant().id;
  const skipped = { invalid: 0, duplicates: 0, beyondLimit: 0 };
  const projectId = projectOf(meta.projectId);
  if (projectId && !(await projectExists(projectId))) throw new MemoryError("That project is not in this workspace. Keep it for the whole workspace instead.", 404);
  let room = MEMORY_LIMITS.workspaceEntries - (await count(workspaceId));
  /* What this scope already holds, read once: the same words are one entry, waiting or kept. */
  const held = await db().execute({ sql: `SELECT kind, text FROM ${TABLE} WHERE workspace_id = ? AND project_id IS ? AND asset_id IS NULL`, args: [workspaceId, projectId] });
  const seen = new Set(held.rows.map((r) => `${String(r.kind)}\u0000${normal(String(r.text ?? ""))}`));
  const statements: InStatement[] = [];
  const ids: string[] = [];
  const at = now();
  for (const item of items) {
    /* A proposal is words: a reference needs a person to pick the asset. */
    const words = cleanMemoryText(item.text);
    if (!isMemoryKind(item.kind) || item.kind === "reference" || words.length < 2 || mentionsMoney(words)) { skipped.invalid++; continue; }
    const entry: Checked = { kind: item.kind, text: words, projectId, assetId: null, assetLabel: null, assetKind: null };
    const key = `${entry.kind}\u0000${normal(entry.text)}`;
    if (seen.has(key)) { skipped.duplicates++; continue; }
    seen.add(key);
    if (room <= 0) { skipped.beyondLimit++; continue; }
    room--;
    const id = newId("mem");
    ids.push(id);
    statements.push(insert(workspaceId, id, entry, { status: "proposed", source: meta.source, origin: meta.origin, by: meta.by, at: at + ids.length }));
  }
  if (statements.length) await db().batch(statements, "write");
  const entries = (await Promise.all(ids.map((id) => entryById(workspaceId, id)))).filter((e): e is MemoryEntry => e !== null);
  return { entries, skipped };
}

/** A paste from another assistant, turned into entries waiting for review (lib/atomikMemoryText › parseImport). */
export async function importMemory(input: { text: unknown; projectId?: unknown; from?: unknown }, by: string) {
  const raw = typeof input.text === "string" ? input.text : "";
  if (!raw.trim()) throw new MemoryError("Paste what the other assistant remembers first.");
  if (raw.length > MEMORY_LIMITS.importChars) throw new MemoryError(`Paste at most ${MEMORY_LIMITS.importChars.toLocaleString("en-US")} characters at a time.`, 413);
  const from: ImportFrom = typeof input.from === "string" && Object.hasOwn(IMPORT_FROM, input.from) ? input.from as ImportFrom : "other";
  const parsed = parseImport(raw);
  const made = await proposeMemory(parsed.entries, { source: "import", origin: IMPORT_FROM[from], projectId: projectOf(input.projectId), by });
  return {
    entries: made.entries,
    skipped: { money: parsed.skipped.money, duplicates: parsed.skipped.duplicates + made.skipped.duplicates, beyondLimit: parsed.skipped.beyondLimit + made.skipped.beyondLimit, invalid: made.skipped.invalid },
  };
}

/**
 * Change an entry, or accept one that was waiting. A changed entry's previous
 * version is copied to the archive in the same write, so an edit never
 * erases what the team had saved; the update lands only on the version the
 * person was looking at (`updatedAt`), never over a newer one.
 */
export async function updateMemory(id: string, patch: { text?: unknown; kind?: unknown; projectId?: unknown; accept?: unknown; updatedAt?: unknown }, by: string): Promise<MemoryEntry> {
  if (!MEMORY_ID.test(id)) throw new MemoryError("That memory is gone.", 404);
  await memoryReady();
  const workspaceId = requireTenant().id;
  const current = await entryById(workspaceId, id);
  if (!current) throw new MemoryError("That memory is gone.", 404);
  if (patch.updatedAt !== undefined && Number(patch.updatedAt) !== current.updatedAt) throw new MemoryError("This memory changed since you opened it. Reload it and try again.", 409);
  const next = await checked({
    kind: patch.kind ?? current.kind,
    text: patch.text ?? current.text,
    projectId: patch.projectId !== undefined ? patch.projectId : current.projectId,
    assetId: current.assetId,
  }, current);
  if (next.kind === "reference" && !current.assetId) throw new MemoryError("A reference is an asset from the Library: open it there and choose Remember.");
  const changed = next.kind !== current.kind || next.text !== current.text || next.projectId !== current.projectId;
  const accept = patch.accept === true && current.status === "proposed";
  if (!changed && !accept) return current;
  const at = Math.max(now(), current.updatedAt + 1);
  const guard = { where: "workspace_id = ? AND id = ? AND updated_at = ?", args: [workspaceId, id, current.updatedAt] };
  const statements: InStatement[] = [];
  if (changed) statements.push(await archiveStatement(db(), TABLE, guard.where, guard.args, { reason: "edited", by }));
  statements.push({
    sql: `UPDATE ${TABLE} SET kind = ?, text = ?, project_id = ?, status = ?, accepted_by = ?, accepted_at = ?, updated_at = ? WHERE ${guard.where}`,
    args: [next.kind, next.text, next.projectId, accept ? "active" : current.status,
      accept ? by : current.acceptedBy, accept ? at : current.acceptedAt, at, ...guard.args],
  });
  const results = await db().batch(statements, "write");
  if (!Number(results[results.length - 1].rowsAffected ?? 0)) throw new MemoryError("This memory changed since you opened it. Reload it and try again.", 409);
  return (await entryById(workspaceId, id))!;
}

/**
 * Forget: each entry is archived (lib/archive.ts: the whole row copied to
 * archived_rows, then taken out of the table, in one write) — never erased.
 * `dismissed` is a proposal a person turned down. Returns how many left.
 */
export async function forgetMemory(ids: unknown, by: string, reason: "forgotten" | "dismissed" = "forgotten"): Promise<number> {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
  if (!list.length || list.length > 200 || list.some((id) => !MEMORY_ID.test(id))) throw new MemoryError("Choose what to forget.");
  await memoryReady();
  const workspaceId = requireTenant().id;
  return archiveTransaction(async (tx) => {
    const statements = await archiveDeleteStatements(tx, list.map((id) => ({ table: TABLE, where: "workspace_id = ? AND id = ?", args: [workspaceId, id], reason, by })));
    const results = await tx.batch(statements);
    return results.reduce((n, r, i) => n + (i % 2 === 1 ? Number(r.rowsAffected ?? 0) : 0), 0);
  });
}

type Named = MemoryEntry & { byName: string | null; acceptedByName: string | null };

async function scopedEntries(workspaceId: string, projectId: string | null, status?: MemoryStatus): Promise<Named[]> {
  const where = scoped(projectId);
  const rs = await db().execute({
    sql: `SELECT m.*, u1.name AS by_name, u2.name AS accepted_by_name FROM ${TABLE} m
          LEFT JOIN users u1 ON u1.id = m.created_by LEFT JOIN users u2 ON u2.id = m.accepted_by
          WHERE m.workspace_id = ? AND ${where.sql.replace(/project_id/g, "m.project_id")}${status ? " AND m.status = ?" : ""}
          ORDER BY m.updated_at DESC LIMIT ${MEMORY_LIMITS.workspaceEntries}`,
    args: [workspaceId, ...where.args, ...(status ? [status] : [])],
  });
  return rs.rows.map((r) => ({ ...toEntry(r as Row), byName: text((r as Row).by_name), acceptedByName: text((r as Row).accepted_by_name) }));
}

function toView(e: Named, viewer: string, present: Set<string>): MemoryView {
  const { createdBy, acceptedBy, byName, acceptedByName, ...rest } = e;
  return {
    ...rest, scope: e.projectId ? "project" : "workspace",
    byYou: createdBy === viewer, byName, acceptedByYou: acceptedBy === viewer, acceptedByName,
    available: !e.assetId || present.has(e.assetId),
  };
}

/** Everything the Memory page shows for a project: the workspace's entries and that project's, waiting ones included. */
export async function listMemory(projectId: string | null, viewer: string): Promise<MemoryView[]> {
  await memoryReady();
  const workspaceId = requireTenant().id;
  const entries = await scopedEntries(workspaceId, projectOf(projectId));
  const present = await assetsPresent(entries.flatMap((e) => (e.assetId ? [e.assetId] : [])));
  return entries.map((e) => toView(e, viewer, present));
}

/** One entry as its view, for a route's reply. */
export async function memoryView(entry: MemoryEntry, viewer: string): Promise<MemoryView> {
  const present = await assetsPresent(entry.assetId ? [entry.assetId] : []);
  return toView({ ...entry, byName: null, acceptedByName: null }, viewer, present);
}

/**
 * "Forget …" in Atomik: the kept entries it is about, best first, the plain
 * ones marked selected. Read-only — a person confirms, then forgetMemory runs.
 */
export async function findForForget(said: unknown, projectId: unknown, viewer: string): Promise<{ subject: string; matches: (MemoryView & { selected: boolean })[] }> {
  const words = typeof said === "string" ? said : "";
  const command = parseMemoryCommand(words);
  const subject = command?.verb === "forget" ? command.subject : cleanMemoryText(words);
  if (!subject) throw new MemoryError("Say what Atomik should forget.");
  await memoryReady();
  const workspaceId = requireTenant().id;
  const entries = await scopedEntries(workspaceId, projectOf(projectId), "active");
  const matches = forgetMatches(subject, entries);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const present = await assetsPresent(entries.flatMap((e) => (e.assetId ? [e.assetId] : [])));
  return { subject, matches: matches.map((m) => ({ ...toView(byId.get(m.id)!, viewer, present), selected: m.selected })) };
}

/**
 * What a planner is given: this workspace's and this project's kept entries,
 * ranked and cut small (lib/atomikMemoryText › rankForPlanner). Waiting
 * proposals, other projects' entries, references whose asset has left the
 * Library and anything about money are never among them.
 */
export async function plannerMemory(at: { projectId: string | null | undefined; query: string }): Promise<PlannerMemoryItem[]> {
  await memoryReady();
  const workspaceId = requireTenant().id;
  const projectId = at.projectId && PROJECT_ID.test(at.projectId) ? at.projectId : null;
  const entries = await scopedEntries(workspaceId, projectId, "active");
  const present = await assetsPresent(entries.flatMap((e) => (e.assetId ? [e.assetId] : [])));
  return rankForPlanner(entries.filter((e) => !e.assetId || present.has(e.assetId)), { projectId, query: at.query });
}

/** The chat planner's MEMORY section body, or "" when there is nothing to say. */
export async function plannerMemoryText(at: { projectId: string | null | undefined; query: string }): Promise<string> {
  return memoryLines(await plannerMemory(at));
}
