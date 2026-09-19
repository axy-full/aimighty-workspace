import type { Client, Row, Transaction } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { db, ready, now, id as newId } from "./db";
import { currentTenant, requireTenant } from "./tenant";
import { mediaMutation, validateMediaSources } from "./mediaMutation";
import { presignedReadUrl, uploadPath, imagePath, usingBlob } from "./storage";
import { creditsApply } from "./credits";
import { billCredits } from "./creditTerms";
import {
  reserveGenerationSpend,
  SpendReservationError,
  type GenerationRequest,
} from "./generationRequests";
import { assertMeterFunding, meter, type MeterEvent } from "./meter";
import { platformDb } from "./platform";
import { billingReady, billingTransaction } from "./billingLedger";
import { withRecoveryJob, resolveRecoveryJobTx } from "./recovery";
import {
  createSoulReference,
  getSoulReference,
  deleteSoulReference,
  higgsfieldConfigured,
  higgsfieldCredentialFingerprint,
  higgsfieldSubmissionRejected,
  type SoulReference,
} from "./higgsfield";

export const SOUL_TRAINING_MODEL = "higgsfield/soul-id";
export const SOUL_TRAINING_USD = 2.5;
export const SOUL_MIN_PHOTOS = 1;
export const SOUL_MAX_PHOTOS = 40;
export type SoulIdentityState =
  "submitting" | "training" | "ready" | "failed" | "uncertain";
export type SoulSource =
  { uploadId: string; genId?: never } | { genId: string; uploadId?: never };
export type SoulIdentity = {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  subjectType: "character" | "element";
  references: SoulSource[];
  status: SoulIdentityState;
  previewUrl: string | null;
  createdAt: number;
  updatedAt: number;
  creditsBilled: number | null;
  error: string | null;
};
export class SoulIdentityError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "SoulIdentityError";
  }
}
const initialized = new WeakMap<Client, Promise<void>>();
let receiptsReady: Promise<void> | undefined;
export async function soulIdentitiesReady(): Promise<void> {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(
      client,
      client
        .batch(
          [
            `CREATE TABLE IF NOT EXISTS soul_identities(id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT,
      production_project_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL, subject_type TEXT NOT NULL,
      references_json TEXT NOT NULL, status TEXT NOT NULL, provider_reference_id TEXT, credential_fingerprint TEXT NOT NULL,
      paid_claim TEXT, cost_usd REAL, settlement_status TEXT, settled_at INTEGER, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_polled_at INTEGER, consent_at INTEGER NOT NULL,
      purged_at INTEGER)`,
            `CREATE INDEX IF NOT EXISTS soul_identity_project ON soul_identities(production_project_id,created_at)`,
          ],
          "write",
        )
        .then(() => {})
        .catch((error) => {
          initialized.delete(client);
          throw error;
        }),
    );
  await initialized.get(client);
  receiptsReady ??= (async () => {
    await billingReady();
    await platformDb()
      .execute(`CREATE TABLE IF NOT EXISTS soul_training_receipts(id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL, provider_reference_id TEXT NOT NULL, provider_status TEXT NOT NULL,
      credential_fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER)`);
    const columns = (
      await platformDb().execute("PRAGMA table_info(soul_training_receipts)")
    ).rows;
    if (!columns.some((column) => column.name === "settled_at"))
      await platformDb().execute(
        "ALTER TABLE soul_training_receipts ADD COLUMN settled_at INTEGER",
      );
  })().catch((error) => {
    receiptsReady = undefined;
    throw error;
  });
  await receiptsReady;
}
const rawIdentity = async (id: string): Promise<Row | null> =>
  (
    await db().execute({
      sql: "SELECT * FROM soul_identities WHERE id=? AND purged_at IS NULL",
      args: [id],
    })
  ).rows[0] ?? null;
const sources = (row: Row): SoulSource[] =>
  JSON.parse(String(row.references_json));
const event = (
  row: Row,
  status: MeterEvent["status"],
  cost: number,
): MeterEvent => ({
  id: String(row.id),
  kind: "training",
  engine: "higgsfield",
  model: SOUL_TRAINING_MODEL,
  status,
  engineCostUsd: cost,
  projectId:
    row.production_project_id == null
      ? null
      : String(row.production_project_id),
  createdBy: String(row.owner),
});

async function productionFor(
  tx: Pick<Transaction, "execute">,
  projectId: string | null,
  owner: string,
): Promise<string | null> {
  if (!projectId) return null;
  const draft = (
    await tx.execute({
      sql: "SELECT body FROM workbench_projects WHERE owner=? AND project_id=?",
      args: [owner, projectId],
    })
  ).rows[0];
  if (!draft)
    throw new SoulIdentityError(
      "Save this production before training its identity, using the account that owns the draft.",
      404,
    );
  const productionId: unknown = JSON.parse(
    String(draft.body),
  ).productionProjectId;
  if (
    typeof productionId !== "string" ||
    !(
      await tx.execute({
        sql: "SELECT id FROM projects WHERE id=?",
        args: [productionId],
      })
    ).rows.length
  )
    throw new SoulIdentityError(
      "Save this production before training its identity.",
      409,
    );
  return productionId;
}
async function canRead(row: Row): Promise<boolean> {
  const owner = currentTenant()?.user?.id;
  if (!owner) return false;
  if (row.owner === owner || row.production_project_id == null) return true;
  const drafts = await db().execute({
    sql: "SELECT body FROM workbench_projects WHERE owner=?",
    args: [owner],
  });
  return drafts.rows.some((draft) => {
    try {
      return (
        JSON.parse(String(draft.body)).productionProjectId ===
        row.production_project_id
      );
    } catch {
      return false;
    }
  });
}
async function publicIdentity(
  row: Row,
  bills?: Map<string, number>,
): Promise<SoulIdentity> {
  const refs = sources(row);
  const bill = bills
    ? bills.has(String(row.id))
      ? { billed_credits: bills.get(String(row.id)) }
      : null
    : (
        await platformDb().execute({
          sql: "SELECT billed_credits FROM meter_events WHERE workspace_id=? AND id=?",
          args: [requireTenant().id, String(row.id)],
        })
      ).rows[0];
  return {
    id: String(row.id),
    projectId: row.project_id == null ? null : String(row.project_id),
    name: String(row.name),
    description: String(row.description),
    subjectType: row.subject_type as SoulIdentity["subjectType"],
    references: refs,
    status:
      row.status === "ready" && row.settled_at == null
        ? "training"
        : (row.status as SoulIdentityState),
    previewUrl: refs[0]?.uploadId
      ? `/api/uploads/${refs[0].uploadId}`
      : refs[0]?.genId
        ? `/api/media/${refs[0].genId}`
        : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    creditsBilled:
      creditsApply(requireTenant()) && bill
        ? Number(bill.billed_credits)
        : null,
    error: row.error == null ? null : String(row.error),
  };
}
export function soulIdentityTerms() {
  const inCredits = creditsApply(requireTenant());
  return {
    chargePolicy: "accepted-request" as const,
    minPhotos: SOUL_MIN_PHOTOS,
    maxPhotos: SOUL_MAX_PHOTOS,
    trainingCredits: inCredits
      ? billCredits(SOUL_TRAINING_USD, "identity-training")
      : null,
    ...(inCredits ? {} : { trainingCostUsd: SOUL_TRAINING_USD }),
  };
}
export async function getSoulIdentity(
  id: string,
): Promise<SoulIdentity | null> {
  await soulIdentitiesReady();
  const row = await rawIdentity(id);
  return row && (await canRead(row)) ? publicIdentity(row) : null;
}
export async function listSoulIdentities(
  projectId?: string | null,
): Promise<SoulIdentity[]> {
  await soulIdentitiesReady();
  const owner = currentTenant()?.user?.id;
  if (!owner) throw new SoulIdentityError("Sign in to view identities.", 401);
  // A new unsaved draft can view configuration and terms before its first save.
  if (
    projectId &&
    !(
      await db().execute({
        sql: "SELECT 1 FROM workbench_projects WHERE owner=? AND project_id=?",
        args: [owner, projectId],
      })
    ).rows.length
  )
    return [];
  const productionId = await productionFor(db(), projectId ?? null, owner);
  const rows = await db().execute({
    sql: `SELECT * FROM soul_identities WHERE purged_at IS NULL AND ${productionId ? "(production_project_id=? OR production_project_id IS NULL)" : "owner=?"} ORDER BY created_at DESC LIMIT 200`,
    args: [productionId ?? owner],
  });
  if (!rows.rows.length) return [];
  const meterRows = await platformDb().execute({
    sql: `SELECT id,billed_credits FROM meter_events WHERE workspace_id=? AND id IN (${rows.rows.map(() => "?").join(",")})`,
    args: [requireTenant().id, ...rows.rows.map((row) => String(row.id))],
  });
  const bills = new Map(
    meterRows.rows.map((row) => [String(row.id), Number(row.billed_credits)]),
  );
  return Promise.all(rows.rows.map((row) => publicIdentity(row, bills)));
}
export type CreateSoulIdentityInput = {
  projectId?: string | null;
  name: string;
  description?: string;
  subjectType: "character" | "element";
  references: SoulSource[];
  consent: true;
  maxCredits?: number;
  maxUsd?: number;
};
type Dependencies = {
  submit?: typeof createSoulReference;
  poll?: typeof getSoulReference;
  sign?: typeof presignedReadUrl;
};
function cleanInput(value: CreateSoulIdentityInput): CreateSoulIdentityInput {
  if (
    !value ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.trim().length > 100 ||
    /[\u0000-\u001f]/.test(value.name)
  )
    throw new SoulIdentityError(
      "Give this identity a name of 1–100 characters.",
    );
  if (value.subjectType !== "character" && value.subjectType !== "element")
    throw new SoulIdentityError(
      "Choose Character or Element for this identity.",
    );
  if (value.consent !== true)
    throw new SoulIdentityError(
      "Confirm you have permission to train an identity of this person or character.",
    );
  if (
    value.projectId != null &&
    (typeof value.projectId !== "string" ||
      !value.projectId ||
      value.projectId.length > 160)
  )
    throw new SoulIdentityError("Invalid production.");
  if (
    value.description != null &&
    (typeof value.description !== "string" || value.description.length > 1000)
  )
    throw new SoulIdentityError(
      "Keep the identity description below 1,000 characters.",
    );
  if (
    !Array.isArray(value.references) ||
    value.references.length < 1 ||
    value.references.length > 40
  )
    throw new SoulIdentityError(
      "Choose between 1 and 40 still references of one person or character.",
    );
  const seen = new Set<string>();
  for (const ref of value.references) {
    if (!ref || typeof ref !== "object" || Object.keys(ref).length !== 1)
      throw new SoulIdentityError(
        "Choose an existing uploaded or generated still.",
      );
    const key = "uploadId" in ref ? "uploadId" : "genId";
    const id = ref[key];
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(id) ||
      seen.has(`${key}:${id}`)
    )
      throw new SoulIdentityError(
        "Each identity reference must be a different existing still.",
      );
    seen.add(`${key}:${id}`);
  }
  const quote = soulIdentityTerms();
  if (
    value.maxCredits != null &&
    (!Number.isFinite(value.maxCredits) ||
      value.maxCredits < (quote.trainingCredits ?? 0))
  )
    throw new SoulIdentityError(
      "The identity quote changed. Review its current credit price before training.",
      409,
    );
  if (
    value.maxUsd != null &&
    (!Number.isFinite(value.maxUsd) || value.maxUsd < SOUL_TRAINING_USD)
  )
    throw new SoulIdentityError(
      "The identity quote changed. Review its current price before training.",
      409,
    );
  return {
    ...value,
    name: value.name.trim(),
    description: value.description?.trim() ?? "",
  };
}
async function verifiedPaths(
  tx: Transaction,
  refs: SoulSource[],
  productionId: string | null,
): Promise<string[]> {
  await validateMediaSources(tx, refs);
  const paths: string[] = [];
  for (const ref of refs) {
    if (ref.uploadId) {
      const row = (
        await tx.execute({
          sql: "SELECT mime,ext,stored_url FROM uploads WHERE id=?",
          args: [ref.uploadId],
        })
      ).rows[0];
      if (
        !row ||
        !["image/jpeg", "image/png", "image/webp"].includes(String(row.mime)) ||
        !/^(jpg|jpeg|png|webp)$/.test(String(row.ext)) ||
        !row.stored_url
      )
        throw new SoulIdentityError(
          "Identity training accepts stored JPEG, PNG or WebP stills only.",
        );
      paths.push(uploadPath(ref.uploadId, String(row.ext)));
    } else {
      const row = (
        await tx.execute({
          sql: "SELECT kind,status,stored_url,project_id FROM generations WHERE id=? AND deleted=0",
          args: [ref.genId!],
        })
      ).rows[0];
      if (
        !row ||
        row.kind !== "image" ||
        row.status !== "succeeded" ||
        !row.stored_url ||
        (productionId && row.project_id !== productionId)
      )
        throw new SoulIdentityError(
          "Choose a completed still from this production.",
        );
      paths.push(imagePath(ref.genId!));
    }
  }
  return paths;
}
async function saveReceipt(row: Row, outcome: SoulReference) {
  await billingTransaction(async (tx, ts) => {
    const current = (
      await tx.execute({
        sql: "SELECT * FROM soul_training_receipts WHERE id=?",
        args: [String(row.id)],
      })
    ).rows[0];
    if (
      current &&
      (current.workspace_id !== requireTenant().id ||
        current.provider_reference_id !== outcome.id ||
        current.credential_fingerprint !== row.credential_fingerprint)
    )
      throw new Error("Identity receipt mismatch.");
    await tx.execute({
      sql: `INSERT INTO soul_training_receipts(id,workspace_id,provider_reference_id,provider_status,credential_fingerprint,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_status=CASE WHEN soul_training_receipts.settled_at IS NULL THEN excluded.provider_status ELSE soul_training_receipts.provider_status END,updated_at=excluded.updated_at`,
      args: [
        String(row.id),
        requireTenant().id,
        outcome.id,
        outcome.status,
        String(row.credential_fingerprint),
        ts,
      ],
    });
  });
}
async function settle(row: Row): Promise<void> {
  if (!row.settlement_status || row.settled_at != null) return;
  const cost = Number(row.cost_usd ?? 0);
  await meter(
    event(row, row.settlement_status as "succeeded" | "failed", cost),
    { critical: true },
  );
  // A known terminal failed training is still a charged custom-reference request.
  // It is no longer an unresolved provider operation, unlike an unknown submit.
  if (row.provider_reference_id)
    await saveReceipt(row, {
      id: String(row.provider_reference_id),
      status: row.settlement_status === "succeeded" ? "completed" : "failed",
    });
  await billingTransaction(async (tx, ts) => {
    if (row.settlement_status === "failed" && cost > 0)
      await resolveRecoveryJobTx(tx, requireTenant().id, String(row.id));
    await tx.execute({
      sql: "UPDATE soul_training_receipts SET settled_at=? WHERE id=? AND workspace_id=?",
      args: [ts, String(row.id), requireTenant().id],
    });
  });
  await db().execute({
    sql: "UPDATE soul_identities SET settled_at=? WHERE id=? AND settlement_status=?",
    args: [now(), String(row.id), String(row.settlement_status)],
  });
}
async function finishKnown(row: Row, result: SoulReference): Promise<void> {
  const terminal = result.status === "completed" || result.status === "failed";
  const state =
    result.status === "completed"
      ? "ready"
      : result.status === "failed"
        ? "failed"
        : "training";
  await db().execute({
    sql: `UPDATE soul_identities SET provider_reference_id=?,status=?,cost_usd=?,settlement_status=?,error=?,updated_at=? WHERE id=? AND status IN ('submitting','training','uncertain') AND (provider_reference_id IS NULL OR provider_reference_id=?)`,
    args: [
      result.id,
      state,
      SOUL_TRAINING_USD,
      terminal ? (state === "ready" ? "succeeded" : "failed") : null,
      state === "failed"
        ? "The identity trainer could not train this identity. Its accepted training request remains charged."
        : null,
      now(),
      String(row.id),
      result.id,
    ],
  });
  const fresh = await rawIdentity(String(row.id));
  if (fresh) await settle(fresh);
}
async function failUnsent(
  row: Row,
  message: string,
  rejectedClaim?: string,
): Promise<void> {
  // A status poll may label an in-flight POST uncertain before its definitive
  // rejection arrives. Only that exact submitter may release its reservation.
  // Crash cleanup has no such proof and must lose to any acquired paid claim.
  const changed = await db().execute({
    sql: `UPDATE soul_identities SET status='failed',cost_usd=0,settlement_status='failed',error=?,updated_at=?
      WHERE id=? AND provider_reference_id IS NULL AND settlement_status IS NULL AND settled_at IS NULL
      AND ${rejectedClaim ? "paid_claim=? AND status IN ('submitting','uncertain')" : "paid_claim IS NULL AND status='submitting'"}`,
    args: [
      message,
      now(),
      String(row.id),
      ...(rejectedClaim ? [rejectedClaim] : []),
    ],
  });
  if (!changed.rowsAffected) return;
  const fresh = await rawIdentity(String(row.id));
  if (fresh) await settle(fresh);
}
/** One immutable identity is one paid attempt. This function is called only by the idempotent route envelope. */
export async function createSoulIdentity(
  input: CreateSoulIdentityInput,
  claim: GenerationRequest,
  deps: Dependencies = {},
): Promise<SoulIdentity> {
  const value = cleanInput(input);
  const owner = currentTenant()?.user?.id;
  if (!owner || owner !== claim.userId)
    throw new SoulIdentityError("Sign in to create an identity.", 401);
  if (!higgsfieldConfigured())
    throw new SoulIdentityError(
      "Identity training is not configured for this workspace.",
      503,
    );
  if (process.env.ENGINE_MOCK !== "1" && !usingBlob())
    throw new SoulIdentityError(
      "Private cloud storage is required for identity training.",
      503,
    );
  await soulIdentitiesReady();
  const id = newId("soul");
  const fingerprint = higgsfieldCredentialFingerprint();
  const paths = await mediaMutation(async (tx) => {
    const productionId = await productionFor(
      tx,
      value.projectId ?? null,
      owner,
    );
    const paths = await verifiedPaths(tx, value.references, productionId);
    const ts = now();
    await tx.execute({
      sql: `INSERT INTO soul_identities(id,owner,project_id,production_project_id,name,description,subject_type,references_json,status,credential_fingerprint,created_at,updated_at,consent_at) VALUES(?,?,?,?,?,?,?,?,'submitting',?,?,?,?)`,
      args: [
        id,
        owner,
        value.projectId ?? null,
        productionId,
        value.name,
        value.description ?? "",
        value.subjectType,
        JSON.stringify(value.references),
        fingerprint,
        ts,
        ts,
        ts,
      ],
    });
    // Commit the recoverable ID with the identity, before any external paid operation.
    const identity: SoulIdentity = {
      id,
      projectId: value.projectId ?? null,
      name: value.name,
      description: value.description ?? "",
      subjectType: value.subjectType,
      references: value.references,
      status: "submitting",
      previewUrl: value.references[0].uploadId
        ? `/api/uploads/${value.references[0].uploadId}`
        : `/api/media/${value.references[0].genId}`,
      createdAt: ts,
      updatedAt: ts,
      creditsBilled: null,
      error: null,
    };
    const written = await tx.execute({
      sql: "UPDATE generation_requests SET response_json=?,response_status=202,updated_at=? WHERE user_id=? AND request_key=?",
      args: [JSON.stringify({ identity }), ts, owner, claim.key],
    });
    if (written.rowsAffected !== 1)
      throw new SoulIdentityError(
        "The paid request has no durable admission.",
        409,
      );
    return paths;
  });
  const row = (await rawIdentity(id))!;
  try {
    await reserveGenerationSpend(event(row, "running", SOUL_TRAINING_USD), {
      token: currentTenant()?.token,
      projectId: row.production_project_id as string | null,
    });
  } catch (error) {
    await failUnsent(
      row,
      error instanceof SpendReservationError
        ? error.message
        : "The training reservation could not be confirmed. No provider request was sent.",
    );
    throw error;
  }
  await withRecoveryJob(requireTenant().id, id, async () => {
    let paidClaim: string | undefined;
    let accepted: SoulReference | null = null;
    try {
      const urls: string[] = [];
      for (const pathname of paths)
        urls.push(
          deps.sign
            ? await deps.sign(pathname)
            : process.env.ENGINE_MOCK === "1"
              ? `https://fixtures.particl.invalid/${pathname}`
              : await presignedReadUrl(pathname),
        );
      await assertMeterFunding(id, "higgsfield");
      if (higgsfieldCredentialFingerprint() !== fingerprint)
        throw new Error(
          "The identity trainer account changed before this training started.",
        );
      const claimToken = randomUUID();
      const won = await db().execute({
        sql: "UPDATE soul_identities SET paid_claim=?,cost_usd=?,updated_at=? WHERE id=? AND status='submitting' AND paid_claim IS NULL",
        args: [claimToken, SOUL_TRAINING_USD, now(), id],
      });
      if (!won.rowsAffected) return;
      paidClaim = claimToken;
      accepted = await (deps.submit ?? createSoulReference)(value.name, urls);
      // Independent databases provide two recovery locations for a known remote UUID.
      await saveReceipt(row, accepted).catch(() => {});
      await finishKnown(row, accepted);
      await saveReceipt(row, accepted);
    } catch (error) {
      if (accepted) {
        // Retry persistence only, never the paid POST, if the first database write failed.
        await saveReceipt(row, accepted).catch(() => {});
        await finishKnown(row, accepted).catch(() => {});
      } else if (!paidClaim || higgsfieldSubmissionRejected(error)) {
        await failUnsent(
          row,
          paidClaim
            ? "The identity trainer rejected this training request. No training charge was recorded."
            : "Training did not start. Check the workspace configuration and prepare a new request.",
          paidClaim,
        );
      } else {
        await db().execute({
          sql: "UPDATE soul_identities SET status='uncertain',error=?,updated_at=? WHERE id=? AND status='submitting'",
          args: [
            "The identity trainer may have accepted this paid training request. Its reservation is retained; do not start it again. Contact support to reconcile the provider request.",
            now(),
            id,
          ],
        });
      }
    }
  });
  return publicIdentity((await rawIdentity(id))!);
}

/** Background-safe polling never submits a new training request, including after a crash. */
export async function syncSoulIdentity(
  id: string,
  deps: Dependencies = {},
): Promise<SoulIdentity | null> {
  await soulIdentitiesReady();
  let row = await rawIdentity(id);
  if (!row) return null;
  const user = currentTenant()?.user;
  if (user && !(await canRead(row))) return null;
  if (row.settled_at != null) return publicIdentity(row);
  if (!row.paid_claim && Number(row.created_at) > now() - 120_000)
    return publicIdentity(row);
  return withRecoveryJob(requireTenant().id, id, async () => {
    row = (await rawIdentity(id))!;
    if (row.settlement_status) {
      await settle(row);
      return publicIdentity((await rawIdentity(id))!);
    }
    if (!row.paid_claim) {
      await failUnsent(
        row,
        "Training was interrupted before provider submission. No charge was recorded.",
      );
      return publicIdentity((await rawIdentity(id))!);
    }
    const receipt = (
      await platformDb().execute({
        sql: "SELECT * FROM soul_training_receipts WHERE id=? AND workspace_id=?",
        args: [id, requireTenant().id],
      })
    ).rows[0];
    if (
      receipt &&
      receipt.credential_fingerprint === row.credential_fingerprint
    ) {
      await finishKnown(row, {
        id: String(receipt.provider_reference_id),
        status: receipt.provider_status as SoulReference["status"],
      });
      row = (await rawIdentity(id))!;
      if (row.settled_at != null) return publicIdentity(row);
    }
    if (!row.provider_reference_id) {
      await db().execute({
        sql: "UPDATE soul_identities SET status='uncertain',error=?,updated_at=? WHERE id=? AND status='submitting'",
        args: [
          "The provider submission is unresolved. The reservation is retained; this request will not be submitted twice.",
          now(),
          id,
        ],
      });
      return publicIdentity((await rawIdentity(id))!);
    }
    if (
      !higgsfieldConfigured() ||
      higgsfieldCredentialFingerprint() !== row.credential_fingerprint
    ) {
      await db().execute({
        sql: "UPDATE soul_identities SET error=?,last_polled_at=? WHERE id=?",
        args: [
          "Restore the original identity trainer account to check this identity. Its training reservation is retained.",
          now(),
          id,
        ],
      });
      return publicIdentity((await rawIdentity(id))!);
    }
    const leased = await db().execute({
      sql: "UPDATE soul_identities SET last_polled_at=? WHERE id=? AND (last_polled_at IS NULL OR last_polled_at<?)",
      args: [now(), id, now() - 15_000],
    });
    if (leased.rowsAffected) {
      try {
        const result = await (deps.poll ?? getSoulReference)(
          String(row.provider_reference_id),
        );
        if (result.id !== row.provider_reference_id)
          throw new Error("Identity handle mismatch.");
        await saveReceipt(row, result);
        await finishKnown(row, result);
      } catch {
        await db().execute({
          sql: "UPDATE soul_identities SET error=? WHERE id=? AND status IN ('training','uncertain','submitting')",
          args: [
            "The identity trainer’s status is temporarily unavailable. The accepted training request will be checked again; no new request is sent.",
            id,
          ],
        });
      }
    }
    return publicIdentity((await rawIdentity(id))!);
  });
}
export async function syncSoulIdentities(
  limit = 5,
  options: { deadlineAt?: number } = {},
): Promise<{ synced: number; failed: number; deferred: number }> {
  await soulIdentitiesReady();
  const rows = await db().execute({
    sql: "SELECT id FROM soul_identities WHERE settled_at IS NULL AND purged_at IS NULL ORDER BY COALESCE(last_polled_at,0),created_at LIMIT ?",
    args: [Math.max(0, Math.min(20, limit))],
  });
  let synced = 0,
    failed = 0;
  for (const row of rows.rows) {
    if (options.deadlineAt != null && now() + 25_000 > options.deadlineAt)
      break;
    let failedAttempt = false;
    try {
      await syncSoulIdentity(String(row.id));
    } catch {
      failedAttempt = true;
    }
    // Rotate even unknown UUIDs and failed checks; they must not starve known
    // requests. Do this after polling so it does not suppress the GET lease.
    try {
      await db().execute({
        sql: "UPDATE soul_identities SET last_polled_at=? WHERE id=?",
        args: [now(), String(row.id)],
      });
    } catch {
      failedAttempt = true;
    }
    if (failedAttempt) failed++;
    else synced++;
  }
  return { synced, failed, deferred: rows.rows.length - synced - failed };
}
export async function requireReadySoulIdentity(
  id: string,
  productionProjectId?: string | null,
  workbenchProjectId?: string | null,
): Promise<{
  id: string;
  providerReferenceId: string;
  credentialFingerprint: string;
}> {
  await soulIdentitiesReady();
  const row = await rawIdentity(id);
  if (!row || !(await canRead(row)))
    throw new SoulIdentityError(
      "This identity is not available in this workspace.",
      404,
    );
  if (workbenchProjectId) {
    const mapped = await productionFor(
      db(),
      workbenchProjectId,
      currentTenant()!.user!.id,
    );
    if (productionProjectId != null && mapped !== productionProjectId)
      throw new SoulIdentityError(
        "The identity production mapping changed.",
        409,
      );
    productionProjectId = mapped;
  }
  if (
    row.production_project_id != null &&
    row.production_project_id !== productionProjectId
  )
    throw new SoulIdentityError("Choose an identity from this production.", 409);
  if (
    row.status !== "ready" ||
    row.settled_at == null ||
    !row.provider_reference_id
  )
    throw new SoulIdentityError(
      "This identity is not ready. Wait for its training and accounting to finish.",
      409,
    );
  if (row.credential_fingerprint !== higgsfieldCredentialFingerprint())
    throw new SoulIdentityError(
      "This identity belongs to a different trainer account. Restore its original credentials.",
      409,
    );
  return {
    id: String(row.id),
    providerReferenceId: String(row.provider_reference_id),
    credentialFingerprint: String(row.credential_fingerprint),
  };
}
/** Called only by whole-workspace purge. Do not delete unfinished remote training. */
export async function purgeSoulIdentities(): Promise<void> {
  await soulIdentitiesReady();
  const generationReceipts =
    (
      await platformDb().execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='higgsfield_generation_receipts'",
      )
    ).rows.length > 0;
  if (
    generationReceipts &&
    (
      await platformDb().execute({
        sql: "SELECT 1 FROM higgsfield_generation_receipts WHERE workspace_id=? AND settled_at IS NULL LIMIT 1",
        args: [requireTenant().id],
      })
    ).rows.length
  )
    throw new SoulIdentityError(
      "Soul generation receipts must be reconciled before this workspace can be purged.",
      409,
    );
  const rows = (
    await db().execute("SELECT * FROM soul_identities WHERE purged_at IS NULL")
  ).rows;
  if (
    rows.some(
      (row) =>
        row.settled_at == null ||
        !["ready", "failed"].includes(String(row.status)),
    )
  )
    throw new SoulIdentityError(
      "Identity training must be reconciled before this workspace can be purged.",
      409,
    );
  for (const row of rows) {
    if (row.provider_reference_id) {
      if (
        !higgsfieldConfigured() ||
        row.credential_fingerprint !== higgsfieldCredentialFingerprint()
      )
        throw new SoulIdentityError(
          "Restore the original identity trainer account before purging its identities.",
          409,
        );
      await deleteSoulReference(String(row.provider_reference_id));
    }
    await billingTransaction(async (tx) => {
      await tx.execute({
        sql: "DELETE FROM soul_training_receipts WHERE id=? AND workspace_id=?",
        args: [String(row.id), requireTenant().id],
      });
    });
    await db().execute({
      sql: "UPDATE soul_identities SET purged_at=? WHERE id=?",
      args: [now(), String(row.id)],
    });
  }
  if (generationReceipts)
    await billingTransaction(async (tx) => {
      await tx.execute({
        sql: "DELETE FROM higgsfield_generation_receipts WHERE workspace_id=? AND settled_at IS NOT NULL",
        args: [requireTenant().id],
      });
    });
}
