import type { Client } from "@libsql/client";
import { db, ready, now, id as newId } from "../db";
import { requireTenant } from "../tenant";
import { securityAuditStatement } from "../securityAudit";
import { assertPerson, type Caller } from "./people-only";
import { CONSENT_USES, ConsentError, cleanConsent, consentLive, type ConsentInput, type ConsentRecord, type ConsentUse } from "./consent-words";

/**
 * Identity consent records (Gaps A, Identity on the Cast card): the person whose face or voice an identity is
 * trained on agreed to it, for the uses and until the date written down, with a recording of them saying so.
 *
 * - Stored in the workspace's own database, in a table of its own made on first use (additive: nothing existing
 *   changes shape). Isolation is which database the query goes to (lib/tenant.ts), and every read also filters by
 *   production.
 * - Only a person records or withdraws one (lib/security/people-only.ts): a token, an MCP client and Atomik's
 *   `agent:` identities are refused here as well as at the route.
 * - Never deleted. Withdrawing marks it (`revoked_at`, who); the row and its recording stay, as the owner's
 *   never-delete rule asks.
 * - Training an identity of a person cites a live record (`consentForTraining`); the identity it started is linked
 *   back to the record so the card can follow it.
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
    recording_upload_id TEXT NOT NULL,
    attested INTEGER NOT NULL,
    recorded_by TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoked_by TEXT,
    identity_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS identity_consents_subject ON identity_consents(project_id, subject_key, recorded_at DESC)`,
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
    untilAt: Number(r.until_at), hasRecording: Boolean(r.recording_upload_id), recordingUrl: r.recording_upload_id ? `/api/uploads/${encodeURIComponent(String(r.recording_upload_id))}` : null, recordedAt: Number(r.recorded_at),
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

/** The recording has to be a sound or video file this workspace holds. */
async function recordingProblem(uploadId: string): Promise<string | null> {
  const rs = await db().execute({ sql: `SELECT mime FROM uploads WHERE id = ? LIMIT 1`, args: [uploadId] });
  const mime = String(rs.rows[0]?.mime ?? "");
  if (!rs.rows.length) return "The recording could not be found. Record it again.";
  if (!/^(audio|video)\//.test(mime)) return "The recording has to be sound or video of the person agreeing.";
  return null;
}

/** Records a consent. People only: a token, an MCP client or an agent is refused before anything is read. */
export async function recordConsent(input: ConsentInput, caller: Caller & { user: { id: string; name?: string } }, at = now()): Promise<ConsentRecord> {
  assertPerson(caller);
  const clean = cleanConsent(input, at);
  await consentsReady();
  const problem = await recordingProblem(clean.recordingUploadId);
  if (problem) throw new ConsentError(problem);
  const cid = newId("cns");
  await db().batch([
    {
      sql: `INSERT INTO identity_consents (id, project_id, subject_key, subject_label, person_name, covers_face, covers_voice, uses_json, other_use, until_at, recording_upload_id, attested, recorded_by, recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      args: [cid, clean.projectId, clean.subjectKey, clean.subjectLabel, clean.personName, clean.face ? 1 : 0, clean.voice ? 1 : 0, JSON.stringify(clean.uses), clean.otherUse, clean.untilAt, clean.recordingUploadId, caller.user.id, at],
    },
    securityAuditStatement({ workspaceId: requireTenant().id, actorId: caller.user.id, action: "identity_consent.recorded", targetType: "identity_consent", targetId: cid, details: { expiresAt: clean.untilAt } }),
  ], "write");
  return (await getConsent(cid))!;
}

/**
 * Withdraws a record: marked, never erased. The person who recorded it, or an owner or admin, may; nobody else, and
 * never a token or an agent. Training already started stays as it is; a new training needs a live record.
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
 * The live record a training request cites, or a refusal in words. It has to be this workspace's, for this
 * production, not withdrawn, not ended, and cover the face (an identity is trained on stills of a face).
 */
export async function consentForTraining(consentId: unknown, projectIds: (string | null | undefined)[], at = now()): Promise<ConsentRecord> {
  if (typeof consentId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(consentId)) throw new ConsentError("Record the person's consent first.");
  const record = await getConsent(consentId);
  if (!record) throw new ConsentError("That consent record is not in this workspace.", 404);
  const ids = projectIds.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (ids.length && !ids.includes(record.projectId)) throw new ConsentError("That consent was recorded for another production.", 409);
  if (!consentLive(record, at)) throw new ConsentError(record.revokedAt != null ? "That consent was withdrawn. Record it again before training." : "That consent has ended. Record it again before training.", 409);
  if (!record.face) throw new ConsentError("That consent covers the voice only; training an identity needs the face too.", 409);
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
