import { GENJUTSU_MODELS, isGenjutsuModel } from "./genjutsuTypes";
import { platformDb, platformReady } from "./platform";
import { db, now } from "./db";
import { requireTenant } from "./tenant";
import { SOUL_CHARACTER_MODEL_ID, MARKETING_IMAGE_MODEL_ID, isHiggsfieldImageModel } from "./models";
import type { RenderHandle } from "./engines/types";
import { generationSettlementReady } from "./generationSettlement";

const receiptModels = [SOUL_CHARACTER_MODEL_ID, MARKETING_IMAGE_MODEL_ID, ...Object.values(GENJUTSU_MODELS)];
const supported = (model: string) => isHiggsfieldImageModel(model) || isGenjutsuModel(model);
let boot: Promise<void> | undefined;
async function receiptsReady() {
  await platformReady();
  boot ??= platformDb().execute(`CREATE TABLE IF NOT EXISTS higgsfield_generation_receipts (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, handle_json TEXT NOT NULL,
    credential_fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER
  )`).then(() => undefined).catch(error => { boot = undefined; throw error; });
  await boot;
}

/** An independent acknowledgement survives a tenant database write outage. */
export async function saveHiggsfieldGenerationReceipt(id: string, handle: RenderHandle, fingerprint: string) {
  if (handle.provider !== "higgsfield" || !supported(handle.model) ||
      !fingerprint || handle.credentialFingerprint !== fingerprint || !handle.ref)
    throw new Error("The accepted Higgsfield request does not match its admitted connection.");
  await receiptsReady();
  const saved = await platformDb().execute({
    sql: `INSERT INTO higgsfield_generation_receipts(id,workspace_id,handle_json,credential_fingerprint,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
      WHERE workspace_id=excluded.workspace_id AND handle_json=excluded.handle_json
        AND credential_fingerprint=excluded.credential_fingerprint RETURNING id`,
    args: [id, requireTenant().id, JSON.stringify(handle), fingerprint, now()],
  });
  if (!saved.rows.length) throw new Error("A different Higgsfield request receipt already exists for this generation.");
}

/** A receipt is complete only after the exact terminal bill was delivered. */
export async function settleHiggsfieldGenerationReceipt(id: string): Promise<boolean> {
  await receiptsReady();
  await generationSettlementReady();
  const outcome = (await db().execute({
    sql: `SELECT g.status,s.event,s.settled_at FROM generations g JOIN generation_settlements s ON s.id=g.id
      WHERE g.id=? AND g.provider='higgsfield' AND g.model IN (?,?,?,?) AND g.status IN ('succeeded','failed','cancelled')`,
    args: [id, ...receiptModels],
  })).rows[0];
  if (!outcome?.settled_at) return false;
  const event = JSON.parse(String(outcome.event));
  if (typeof event.engineCostUsd !== "number" || !Number.isFinite(event.engineCostUsd)) return false;
  await platformDb().execute({ sql: `UPDATE higgsfield_generation_receipts SET settled_at=?,updated_at=?
    WHERE id=? AND workspace_id=? AND settled_at IS NULL`, args: [now(), now(), id, requireTenant().id] });
  return true;
}

/** Restore only the known accepted request; this helper cannot submit work. */
export async function restoreHiggsfieldGenerationReceipt(id: string): Promise<void> {
  await receiptsReady();
  const receipt = (await platformDb().execute({ sql: `SELECT handle_json,credential_fingerprint
    FROM higgsfield_generation_receipts WHERE id=? AND workspace_id=? AND settled_at IS NULL`,
    args: [id, requireTenant().id] })).rows[0];
  if (!receipt) return;
  const row = (await db().execute({ sql: `SELECT params,status,model FROM generations
    WHERE id=? AND provider='higgsfield' AND model IN (?,?,?,?) AND deleted=0`, args: [id, ...receiptModels] })).rows[0];
  if (!row) throw new Error("An accepted Higgsfield request has no recoverable generation record.");
  const params = JSON.parse(String(row.params));
  const handle = JSON.parse(String(receipt.handle_json)) as RenderHandle;
  const key = isGenjutsuModel(String(row.model)) ? "higgsfieldVideoHandle" : "higgsfieldStillHandle";
  if (!params.paidClaim || (row.model === SOUL_CHARACTER_MODEL_ID ? params.soulCredentialFingerprint : params.higgsfieldCredentialFingerprint) !== receipt.credential_fingerprint ||
      handle.credentialFingerprint !== receipt.credential_fingerprint || handle.provider !== "higgsfield" ||
      !supported(handle.model) || handle.model !== row.model || !handle.ref ||
      (params[key] && params[key].ref !== handle.ref))
    throw new Error("The saved Higgsfield acknowledgement does not match its original admission.");
  if (await settleHiggsfieldGenerationReceipt(id)) return;
  // A prior ambiguous failure may have ended the execution slot. Only an exact
  // independent acknowledgement permits reopening it for GET-only collection.
  await db().execute({ sql: `UPDATE generations SET params=json_set(params,?,json(?)),
    status=CASE WHEN status='failed' THEN 'running' ELSE status END,updated_at=?
    WHERE id=? AND deleted=0 AND params=? AND status IN ('queued','running','failed')`,
    args: [`$.${key}`, JSON.stringify(handle), now(), id, row.params] });
}

/** Run before the ordinary pending scan so lost tenant handles become visible. */
export async function restoreHiggsfieldGenerationReceipts(limit: number): Promise<{ attempted: number; failed: number }> {
  await receiptsReady();
  const rows = (await platformDb().execute({ sql: `SELECT id FROM higgsfield_generation_receipts
    WHERE workspace_id=? AND settled_at IS NULL ORDER BY updated_at,id LIMIT ?`,
    args: [requireTenant().id, Math.max(1, Math.min(50, limit))] })).rows;
  let failed = 0;
  for (const row of rows) {
    try { await restoreHiggsfieldGenerationReceipt(String(row.id)); } catch { failed++; }
    // Rotate unresolved receipts so one cannot starve later accepted requests.
    await platformDb().execute({ sql: "UPDATE higgsfield_generation_receipts SET updated_at=? WHERE id=? AND workspace_id=?",
      args: [now(), row.id, requireTenant().id] });
  }
  return { attempted: rows.length, failed };
}
