import type { Client } from "@libsql/client";
import { db, ready, now, id as newId } from "../db";
import { requireTenant } from "../tenant";
import { securityAuditStatement } from "../securityAudit";
import { assertPerson, type Caller } from "./people-only";
import { CONSENT_USES, ConsentError, cleanConsent, consentLive, type ConsentFileKind, type ConsentInput, type ConsentRecord, type ConsentUse } from "./consent-words";

/**
 * Identity consent ticks (Gaps A, Identity on the Cast card). A TICK, NOT A GATE (owner, 23 Oct 2026, 13:15 IST): a
 * record is who ticked and when, with an optional file (a recording of the person agreeing, or their signed release);
 * the other fields (whose face or voice, what it covers, the uses, an end date, the attest box) are optional, kept for
 * the lawyer's NOC, and nothing refuses to make, train, clone or lip-sync for want of any of it.
 *
 * - Stored in the existing table, unchanged in shape: a field that was not given is stored empty ('' / '[]' / 0), and
 *   an end date of 0 reads as "none".
 * - The workspace's own database, in a table of its own made on first use. Isolation is which database the query goes to (lib/tenant.ts), and every read also filters by
 *   production.
 * - Only a person ticks or withdraws one (lib/security/people-only.ts; rule 11): a token, an MCP client and
 *   Atomik's `agent:` identities are refused here as well as at the route, so no machine's tick reads as a person's.
 * - Never deleted. Withdrawing marks it (`revoked_at`, who); the row and its recording stay, as the owner's
 *   never-delete rule asks.
 * - Details edit the live tick in place (`updateConsent`: who ticked and when stay the ticking person's); the screens
 *   make a new tick only when there is none, and unticking withdraws every live tick of the cast member.
 * - A training request may cite a live tick (`consentForTraining`). It is never refused for want of consent: no tick,
 *   or one withdrawn or ended, trains uncited; what a tick covers or allows is never a condition. A citation that is
 *   malformed (no production named, another production's or cast member's tick, an id not in this workspace) is
 *   refused, as before. The Soul identity it started is linked back to the tick. A tick's who and when are only ever
 *   the ticking person's: a training that cites someone else's tick never records the presser as having ticked.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS identity_consents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    subject_label TEXT NOT NULL DEFAULT '',
    person_name TEXT NOT NULL,
    covers_face INTEGER NOT NULL DEFAULT 0,
    covers_voice INTEGER NOT NULL DEFAULT 0,
    uses_json TEXT NOT NULL,
    other_use TEXT NOT NULL DEFAULT '',
    until_at INTEGER NOT NULL,
    recording_id TEXT NOT NULL,
    attested INTEGER NOT NULL,
    recorded_by TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoked_by TEXT,
    identity_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS identity_consents_subject ON identity_consents(project_id, subject_key, recorded_at DESC)`,
  /* The recordings: never uploads (review of #558, M2). Not in the library, not a reference, not a token's to read. */
  `CREATE TABLE IF NOT EXISTS consent_recordings (
    id TEXT PRIMARY KEY, mime TEXT NOT NULL, ext TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
    stored_url TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
];

const initialized = new WeakMap<Client, Promise<void>>();
/** Makes the table in this workspace's database the first time it is needed. */
export async function consentsReady(): Promise<void> {
  await ready();
  const client = db();
  if (!initialized.has(client)) {
    initialized.set(client, client.batch(SCHEMA, "write").then(() => undefined).catch((error) => { initialized.delete(client); throw error; }));
  }
  await initialized.get(client);
}

type Row = Record<string, unknown>;

async function names(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rs = await db().execute({ sql: `SELECT id, name FROM users WHERE id IN (${unique.map(() => "?").join(",")})`, args: unique });
  return new Map(rs.rows.map((r) => [String(r.id), String(r.name)]));
}

/** `viewer`: the signed-in person reading, so each tick says whether it is theirs (`mine`); never an id. */
function toRecord(r: Row, who: Map<string, string>, viewer?: string | null): ConsentRecord {
  const uses = ((): ConsentUse[] => { try { const v = JSON.parse(String(r.uses_json)); return Array.isArray(v) ? CONSENT_USES.filter((u) => v.includes(u)) : []; } catch { return []; } })();
  return {
    id: String(r.id), projectId: String(r.project_id), subjectKey: String(r.subject_key), subjectLabel: String(r.subject_label ?? ""),
    personName: String(r.person_name), face: Number(r.covers_face) === 1, voice: Number(r.covers_voice) === 1, uses, otherUse: String(r.other_use ?? ""),
    untilAt: Number(r.until_at) > 0 ? Number(r.until_at) : null, attested: Number(r.attested) === 1, hasRecording: Boolean(r.recording_id), fileKind: r.recording_id ? fileKindOf(r.file_mime) ?? "recording" : null, recordingUrl: r.recording_id ? `/api/identity-consents/${encodeURIComponent(String(r.id))}/recording` : null, recordedAt: Number(r.recorded_at),
    recordedBy: who.get(String(r.recorded_by)) ?? null, mine: viewer != null && String(r.recorded_by) === viewer,
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at), identityId: r.identity_id == null ? null : String(r.identity_id),
  };
}

/** A production's records, newest first, withdrawn ones included (marked). Optionally one cast member's only. */
export async function listConsents(projectId: string, subjectKey?: string | null, viewer?: string | null): Promise<ConsentRecord[]> {
  await consentsReady();
  const rs = await db().execute({
    sql: `SELECT c.*, f.mime AS file_mime FROM identity_consents c LEFT JOIN consent_recordings f ON f.id = c.recording_id
          WHERE c.project_id = ?${subjectKey ? " AND c.subject_key = ?" : ""} ORDER BY c.recorded_at DESC, c.id DESC LIMIT 200`,
    args: subjectKey ? [projectId, subjectKey] : [projectId],
  });
  const who = await names(rs.rows.map((r) => String(r.recorded_by)));
  return rs.rows.map((r) => toRecord(r, who, viewer));
}

export async function getConsent(id: string, viewer?: string | null): Promise<ConsentRecord | null> {
  await consentsReady();
  const rs = await db().execute({ sql: `SELECT c.*, f.mime AS file_mime FROM identity_consents c LEFT JOIN consent_recordings f ON f.id = c.recording_id WHERE c.id = ? LIMIT 1`, args: [id] });
  const row = rs.rows[0];
  if (!row) return null;
  return toRecord(row, await names([String(row.recorded_by)]), viewer);
}

/* ── The recording ──────────────────────────────────────────────────────── */

/** A tick's file travels in one request: about a minute of voice, a short clip, or a signed release. */
export const MAX_RECORDING_BYTES = 4 * 1024 * 1024;
/**
 * What a tick's file may be, by type: a recording of the person agreeing (sound or video), or their signed release as
 * a PDF, a document for the lawyer (owner, 23 Oct 2026, 17:10). Every kind is stored and served the same private way.
 * Adding a type is one line here. Images are not accepted yet: that waits for the owner's word on review-558's P6.
 */
export const CONSENT_FILE_TYPES: Record<string, { ext: string; kind: ConsentFileKind }> = {
  "audio/webm": { ext: "webm", kind: "recording" }, "audio/ogg": { ext: "ogg", kind: "recording" }, "audio/mp4": { ext: "m4a", kind: "recording" },
  "audio/x-m4a": { ext: "m4a", kind: "recording" }, "audio/aac": { ext: "aac", kind: "recording" }, "audio/mpeg": { ext: "mp3", kind: "recording" },
  "audio/wav": { ext: "wav", kind: "recording" }, "audio/x-wav": { ext: "wav", kind: "recording" },
  "video/webm": { ext: "webm", kind: "recording" }, "video/mp4": { ext: "mp4", kind: "recording" }, "video/quicktime": { ext: "mov", kind: "recording" },
  "application/pdf": { ext: "pdf", kind: "document" },
};
/** A document has to be what it says: a PDF starts with its signature. */
const SIGNATURES: Partial<Record<ConsentFileKind, (bytes: Buffer) => boolean>> = {
  document: (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
};
export const fileKindOf = (mime: unknown): ConsentFileKind | null => (typeof mime === "string" ? CONSENT_FILE_TYPES[mime]?.kind ?? null : null);

/**
 * Stores the recording of a person agreeing, by the person recording the consent. It is not an upload: it has its own
 * table and storage path, so it never appears in the library, a picker or an engine's references, and only the
 * consent route serves it. People only.
 */
export async function storeConsentRecording(input: { bytes: Buffer; mime: string }, caller: Caller & { user: { id: string } }, at = now()): Promise<{ id: string; seconds: null }> {
  assertPerson(caller);
  const mime = input.mime.split(";")[0].trim().toLowerCase();
  const type = CONSENT_FILE_TYPES[mime];
  if (!type) throw new ConsentError("The file has to be sound or video of the person agreeing, or their signed release as a PDF.");
  const { ext } = type;
  if (!input.bytes.length) throw new ConsentError("The file is empty. Try again.");
  if (SIGNATURES[type.kind] && !SIGNATURES[type.kind]!(input.bytes)) throw new ConsentError("That file isn't a PDF. Add the signed release as a PDF.");
  if (input.bytes.length > MAX_RECORDING_BYTES) throw new ConsentError("Keep the file under 4 MB: about a minute of recording, or a short PDF.", 413);
  await consentsReady();
  const { createHash } = await import("node:crypto");
  const { storeConsentRecordingBytes } = await import("../storage");
  const id = newId("crec").replace(/[^A-Za-z0-9_-]/g, "");
  const stored = await storeConsentRecordingBytes(id, ext, input.bytes, mime);
  await db().execute({
    sql: `INSERT INTO consent_recordings (id, mime, ext, bytes, sha256, stored_url, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    args: [id, mime, ext, input.bytes.length, createHash("sha256").update(input.bytes).digest("hex"), stored, caller.user.id, at],
  });
  return { id, seconds: null };
}

/** A record's recording, for the recorder, an owner or an admin, by session; nobody else and never a token. */
export async function readConsentRecording(consentId: string, caller: Caller & { user: { id: string; role?: string; owner?: boolean } }): Promise<{ bytes: Buffer; mime: string; kind: ConsentFileKind }> {
  assertPerson(caller);
  await consentsReady();
  const rs = await db().execute({
    sql: `SELECT c.recorded_by, r.id, r.mime, r.ext FROM identity_consents c JOIN consent_recordings r ON r.id = c.recording_id WHERE c.id = ? LIMIT 1`,
    args: [consentId],
  });
  const row = rs.rows[0];
  if (!row) throw new ConsentError("That recording is not in this workspace.", 404);
  const admin = caller.user.owner === true || caller.user.role === "admin";
  if (String(row.recorded_by) !== caller.user.id && !admin) throw new ConsentError("The person who recorded it, or an owner or admin, can play it.", 403);
  const { readConsentRecordingBytes } = await import("../storage");
  return { bytes: await readConsentRecordingBytes(String(row.id), String(row.ext)), mime: String(row.mime), kind: fileKindOf(String(row.mime)) ?? "recording" };
}

/** The recording has to be one this person made for it, in this workspace. */
async function recordingProblem(recordingId: string, recorder: string): Promise<string | null> {
  const rs = await db().execute({ sql: `SELECT created_by FROM consent_recordings WHERE id = ? LIMIT 1`, args: [recordingId] });
  if (!rs.rows.length) return "The recording could not be found. Record it again.";
  if (String(rs.rows[0].created_by) !== recorder) return "Use a recording you made for this consent.";
  return null;
}

/**
 * Records a person's tick: who (this signed-in person) and when (now), with whatever optional fields were given. People
 * only: a token, an MCP client or an agent is refused before anything is read, so a machine never writes a tick.
 */
export async function recordConsent(input: ConsentInput, caller: Caller & { user: { id: string; name?: string } }, at = now()): Promise<ConsentRecord> {
  assertPerson(caller);
  const clean = cleanConsent(input, at);
  await consentsReady();
  /* A file is optional; one that is given has to be one this person added, in this workspace. */
  const problem = clean.recordingId ? await recordingProblem(clean.recordingId, caller.user.id) : null;
  if (problem) throw new ConsentError(problem);
  const cid = newId("cns");
  await db().batch([
    {
      sql: `INSERT INTO identity_consents (id, project_id, subject_key, subject_label, person_name, covers_face, covers_voice, uses_json, other_use, until_at, recording_id, attested, recorded_by, recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [cid, clean.projectId, clean.subjectKey, clean.subjectLabel, clean.personName, clean.face ? 1 : 0, clean.voice ? 1 : 0, JSON.stringify(clean.uses), clean.otherUse, clean.untilAt ?? 0, clean.recordingId, clean.attested ? 1 : 0, caller.user.id, at],
    },
    securityAuditStatement({ workspaceId: requireTenant().id, actorId: caller.user.id, action: "identity_consent.recorded", targetType: "identity_consent", targetId: cid, details: clean.untilAt != null ? { expiresAt: clean.untilAt } : {} }),
  ], "write");
  return (await getConsent(cid, caller.user.id))!;
}

/**
 * Adds to the optional details of a live tick, in place. It merges: a field the request leaves out stays as it was.
 * It never drops the file: a tick that has one keeps it (an empty or missing file id leaves it attached, and another
 * file is refused); a tick with none may be given one, which has to be this person's own recording. Who ticked and
 * when are never changed: they stay the ticking person's. Every edit is audited with who made it and when
 * (`identity_consent.updated`: its actor and time). The person who ticked it, or an owner or admin, may; nobody else,
 * and never a token or an agent.
 */
export async function updateConsent(consentId: string, input: ConsentInput, caller: Caller & { user: { id: string; role?: string; owner?: boolean } }, at = now()): Promise<ConsentRecord> {
  assertPerson(caller);
  await consentsReady();
  const rs = await db().execute({ sql: `SELECT * FROM identity_consents WHERE id = ? LIMIT 1`, args: [consentId] });
  const row = rs.rows[0];
  if (!row) throw new ConsentError("That consent record is not in this workspace.", 404);
  const admin = caller.user.owner === true || caller.user.role === "admin";
  if (String(row.recorded_by) !== caller.user.id && !admin) throw new ConsentError("The person who ticked it, or an admin, can change its details.", 403);
  if (row.revoked_at != null || (Number(row.until_at) > 0 && Number(row.until_at) <= at)) throw new ConsentError("That tick is no longer live. Tick it again.", 409);
  const given = (key: keyof ConsentInput) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  const was = toRecord(row, new Map());
  const keptFile = String(row.recording_id ?? "");
  const newFile = given("recordingId") && typeof input.recordingId === "string" ? input.recordingId : "";
  if (keptFile && newFile && newFile !== keptFile) throw new ConsentError("This tick already has its file, and it is kept.", 409);
  const merged: ConsentInput = {
    projectId: was.projectId, subjectKey: was.subjectKey,
    subjectLabel: given("subjectLabel") ? input.subjectLabel : was.subjectLabel,
    personName: given("personName") ? input.personName : was.personName,
    face: given("face") ? input.face : was.face,
    voice: given("voice") ? input.voice : was.voice,
    uses: given("uses") ? input.uses : was.uses,
    otherUse: given("otherUse") ? input.otherUse : was.otherUse,
    until: given("until") ? input.until : was.untilAt ?? undefined,
    attested: given("attested") ? input.attested : was.attested,
    recordingId: keptFile || newFile,
  };
  const clean = cleanConsent(merged, at);
  if (!keptFile && clean.recordingId) {
    const problem = await recordingProblem(clean.recordingId, caller.user.id);
    if (problem) throw new ConsentError(problem);
  }
  await db().batch([
    {
      sql: `UPDATE identity_consents SET subject_label = ?, person_name = ?, covers_face = ?, covers_voice = ?, uses_json = ?, other_use = ?, until_at = ?, recording_id = ?, attested = ?
            WHERE id = ? AND revoked_at IS NULL`,
      args: [clean.subjectLabel, clean.personName, clean.face ? 1 : 0, clean.voice ? 1 : 0, JSON.stringify(clean.uses), clean.otherUse, clean.untilAt ?? 0, clean.recordingId, clean.attested ? 1 : 0, consentId],
    },
    securityAuditStatement({ workspaceId: requireTenant().id, actorId: caller.user.id, action: "identity_consent.updated", targetType: "identity_consent", targetId: consentId, details: clean.untilAt != null ? { expiresAt: clean.untilAt } : {} }),
  ], "write");
  return (await getConsent(consentId, caller.user.id))!;
}

/**
 * Withdraws a record: marked, never erased. The person who recorded it, or an owner or admin, may; nobody else, and
 * never a token or an agent. Training already started stays as it is; nothing refuses for want of a tick.
 */
export async function withdrawConsent(consentId: string, caller: Caller & { user: { id: string; role?: string; owner?: boolean } }, at = now()): Promise<boolean> {
  assertPerson(caller);
  await consentsReady();
  const rs = await db().execute({ sql: `SELECT recorded_by, revoked_at FROM identity_consents WHERE id = ? LIMIT 1`, args: [consentId] });
  const row = rs.rows[0];
  if (!row) throw new ConsentError("That consent record is not in this workspace.", 404);
  const admin = caller.user.owner === true || caller.user.role === "admin";
  if (String(row.recorded_by) !== caller.user.id && !admin) throw new ConsentError("The person who recorded it, or an admin, can withdraw it.", 403);
  if (row.revoked_at != null) return false;
  const [done] = await db().batch([
    { sql: `UPDATE identity_consents SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL`, args: [at, caller.user.id, consentId] },
    securityAuditStatement({ workspaceId: requireTenant().id, actorId: caller.user.id, action: "identity_consent.withdrawn", targetType: "identity_consent", targetId: consentId }, true),
  ], "write");
  return (done.rowsAffected ?? 0) > 0;
}

/** A cited tick, with the id of the person who ticked it (server side only: never sent to a browser). */
export type CitedTick = ConsentRecord & { tickedById: string };

/**
 * The tick a training request cites (review of #558, M1; owner, 23 Oct 2026: "a tick, not a gate").
 *
 * - No tick cited: null. The training proceeds unticked.
 * - A cited tick that is withdrawn or past its end date: null. The training proceeds, uncited (nothing refuses for
 *   want of consent).
 * - A live tick of this workspace, for the production the request names and the same cast member: that tick, with the
 *   id of the person who ticked it. What it covers and allows are notes for the lawyer's NOC, never a condition.
 * - A malformed citation is refused in words, before anything is claimed or sent: no production named, an id not in
 *   this workspace, another production's tick, another cast member's, or no cast member named.
 *
 * A failed read is logged (the id and the error code, nothing else) and cites nothing; it never stops a training.
 */
export async function consentForTraining(consentId: unknown, projectIds: (string | null | undefined)[], subjectKey: unknown, at = now()): Promise<CitedTick | null> {
  if (consentId == null || consentId === "") return null;
  if (typeof consentId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(consentId)) throw new ConsentError("That consent tick could not be read. Open the training from the Cast card.");
  const ids = projectIds.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (!ids.length) throw new ConsentError("Training an identity needs the production it is for. Open it from the production's Cast card.");
  let row: Row | undefined;
  try {
    await consentsReady();
    row = (await db().execute({ sql: `SELECT * FROM identity_consents WHERE id = ? LIMIT 1`, args: [consentId] })).rows[0];
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    console.warn("consent tick: read failed", { consentId, code: typeof code === "string" ? code : "unknown" });
    return null;
  }
  if (!row) throw new ConsentError("That consent record is not in this workspace.", 404);
  const record = toRecord(row, await names([String(row.recorded_by)]).catch(() => new Map<string, string>()));
  if (!ids.includes(record.projectId)) throw new ConsentError("That consent was recorded for another production.", 409);
  if (typeof subjectKey !== "string" || !subjectKey) throw new ConsentError("Say which cast member this identity is for.");
  if (subjectKey !== record.subjectKey) throw new ConsentError("That consent was recorded for another cast member.", 409);
  if (!consentLive(record, at)) return null;
  return { ...record, tickedById: String(row.recorded_by) };
}

/** The keys a training request's project answers to: the draft itself and the production it belongs to. */
export async function projectKeysFor(draftId: unknown, owner: string): Promise<string[]> {
  if (typeof draftId !== "string" || !draftId) return [];
  const keys = [draftId];
  const rs = await db().execute({ sql: `SELECT body FROM workbench_projects WHERE project_id = ? AND owner = ? LIMIT 1`, args: [draftId, owner] }).catch(() => ({ rows: [] as Row[] }));
  try {
    const production = JSON.parse(String(rs.rows[0]?.body ?? "{}")).productionProjectId;
    if (typeof production === "string" && production) keys.push(production);
  } catch { /* no production */ }
  return keys;
}

/** Links the Soul identity a training request started to the tick it cited (the card follows it). Only the Soul route links. */
export async function linkConsentIdentity(consentId: string, identityId: string): Promise<void> {
  await consentsReady();
  await db().execute({ sql: `UPDATE identity_consents SET identity_id = ? WHERE id = ? AND revoked_at IS NULL`, args: [identityId, consentId] });
}
