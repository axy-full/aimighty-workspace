import type { Client } from "@libsql/client";
import { db, ready, now, id as newId } from "../db";
import { requireTenant } from "../tenant";
import { securityAuditStatement } from "../securityAudit";
import { assertPerson, type Caller } from "./people-only";
import { CONSENT_USES, ConsentError, cleanConsent, consentLive, type ConsentInput, type ConsentRecord, type ConsentUse } from "./consent-words";

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
 * - A training request may cite a live tick (`consentTick`); it is never refused for citing none, or one that
 *   doesn't match. The identity it started is linked back to the tick so the card can follow it.
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

function toRecord(r: Row, who: Map<string, string>): ConsentRecord {
  const uses = ((): ConsentUse[] => { try { const v = JSON.parse(String(r.uses_json)); return Array.isArray(v) ? CONSENT_USES.filter((u) => v.includes(u)) : []; } catch { return []; } })();
  return {
    id: String(r.id), projectId: String(r.project_id), subjectKey: String(r.subject_key), subjectLabel: String(r.subject_label ?? ""),
    personName: String(r.person_name), face: Number(r.covers_face) === 1, voice: Number(r.covers_voice) === 1, uses, otherUse: String(r.other_use ?? ""),
    untilAt: Number(r.until_at) > 0 ? Number(r.until_at) : null, attested: Number(r.attested) === 1, hasRecording: Boolean(r.recording_id), recordingUrl: r.recording_id ? `/api/identity-consents/${encodeURIComponent(String(r.id))}/recording` : null, recordedAt: Number(r.recorded_at),
    recordedBy: who.get(String(r.recorded_by)) ?? null,
    revokedAt: r.revoked_at == null ? null : Number(r.revoked_at), identityId: r.identity_id == null ? null : String(r.identity_id),
  };
}

/** A production's records, newest first, withdrawn ones included (marked). Optionally one cast member's only. */
export async function listConsents(projectId: string, subjectKey?: string | null): Promise<ConsentRecord[]> {
  await consentsReady();
  const rs = await db().execute({
    sql: `SELECT * FROM identity_consents WHERE project_id = ?${subjectKey ? " AND subject_key = ?" : ""} ORDER BY recorded_at DESC, id DESC LIMIT 200`,
    args: subjectKey ? [projectId, subjectKey] : [projectId],
  });
  const who = await names(rs.rows.map((r) => String(r.recorded_by)));
  return rs.rows.map((r) => toRecord(r, who));
}

export async function getConsent(id: string): Promise<ConsentRecord | null> {
  await consentsReady();
  const rs = await db().execute({ sql: `SELECT * FROM identity_consents WHERE id = ? LIMIT 1`, args: [id] });
  const row = rs.rows[0];
  if (!row) return null;
  return toRecord(row, await names([String(row.recorded_by)]));
}

/* ── The recording ──────────────────────────────────────────────────────── */

/** A recording travels in one request: about a minute of voice, or a short clip. */
export const MAX_RECORDING_BYTES = 4 * 1024 * 1024;
const RECORDING_TYPES: Record<string, string> = {
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
  "video/webm": "webm", "video/mp4": "mp4", "video/quicktime": "mov",
};

/**
 * Stores the recording of a person agreeing, by the person recording the consent. It is not an upload: it has its own
 * table and storage path, so it never appears in the library, a picker or an engine's references, and only the
 * consent route serves it. People only.
 */
export async function storeConsentRecording(input: { bytes: Buffer; mime: string }, caller: Caller & { user: { id: string } }, at = now()): Promise<{ id: string; seconds: null }> {
  assertPerson(caller);
  const mime = input.mime.split(";")[0].trim().toLowerCase();
  const ext = RECORDING_TYPES[mime];
  if (!ext) throw new ConsentError("The recording has to be sound or video of the person agreeing.");
  if (!input.bytes.length) throw new ConsentError("Nothing was recorded. Try again.");
  if (input.bytes.length > MAX_RECORDING_BYTES) throw new ConsentError("Keep the recording under 4 MB: about a minute of the person agreeing.", 413);
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
export async function readConsentRecording(consentId: string, caller: Caller & { user: { id: string; role?: string; owner?: boolean } }): Promise<{ bytes: Buffer; mime: string }> {
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
  return { bytes: await readConsentRecordingBytes(String(row.id), String(row.ext)), mime: String(row.mime) };
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
  return (await getConsent(cid))!;
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

/**
 * The tick a training request cites, when it cites one that fits: this workspace's, for the production the request
 * names, for the same cast member, and live. Null otherwise. Never a refusal (owner, 23 Oct 2026: "a tick, not a
 * gate"): a request with no tick, or one that doesn't fit, trains all the same and is simply not linked to a tick.
 */
export async function consentTick(consentId: unknown, projectIds: (string | null | undefined)[], subjectKey: unknown, at = now()): Promise<ConsentRecord | null> {
  if (typeof consentId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(consentId)) return null;
  const ids = projectIds.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (!ids.length || typeof subjectKey !== "string" || !subjectKey) return null;
  const record = await getConsent(consentId).catch(() => null);
  if (!record || !ids.includes(record.projectId) || record.subjectKey !== subjectKey || !consentLive(record, at)) return null;
  return record;
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

/** Links the identity a training request started to the record it cited. */
export async function linkConsentIdentity(consentId: string, identityId: string): Promise<void> {
  await consentsReady();
  await db().execute({ sql: `UPDATE identity_consents SET identity_id = ? WHERE id = ? AND revoked_at IS NULL`, args: [identityId, consentId] });
}
