import { createHash, randomUUID } from "node:crypto";

export const RECOVERY_PROTOCOL = "particl-recovery-fence-v1";
export class RecoveryFenceError extends Error {
  constructor(
    message = "The studio is paused for a consistent recovery checkpoint. Try again after maintenance.",
  ) {
    super(message);
    this.name = "RecoveryFenceError";
    this.status = 503;
    this.code = "RECOVERY_FENCED";
  }
}
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS recovery_fence(id INTEGER PRIMARY KEY CHECK(id=1), protocol TEXT NOT NULL,state TEXT NOT NULL,epoch INTEGER NOT NULL,owner TEXT,expires_at INTEGER,preconditions TEXT,inventory_hash TEXT,source_fingerprint TEXT,receipt_id TEXT,updated_at INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO recovery_fence(id,protocol,state,epoch,updated_at) VALUES(1,'${RECOVERY_PROTOCOL}','open',0,0)`,
  `CREATE TABLE IF NOT EXISTS recovery_activities(id TEXT PRIMARY KEY,parent_id TEXT,workspace_id TEXT,intent_id TEXT,kind TEXT NOT NULL,deployment TEXT NOT NULL,protocol TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS recovery_activities_pending ON recovery_activities(state,created_at)`,
  `CREATE TABLE IF NOT EXISTS recovery_intent_attempts(workspace_id TEXT NOT NULL,id TEXT NOT NULL,attempted_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,id))`,
  `CREATE TABLE IF NOT EXISTS recovery_intents(workspace_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,resolved_at INTEGER,PRIMARY KEY(workspace_id,id))`,
];

/** This client MUST be the undecorated platform connection. Admission commits
 * before application transactions start; it never calls the application DB. */
export class RecoveryFence {
  constructor(client, deployment = "local", clock = Date.now) {
    this.client = client;
    this.deployment = deployment;
    this.clock = clock;
    this.boot = undefined;
  }
  async ready() {
    this.boot ??= this.client.batch(SCHEMA, "write").catch((error) => {
      this.boot = undefined;
      throw error;
    });
    await this.boot;
  }
  async tx(run) {
    await this.ready();
    const tx = await this.client.transaction("write");
    try {
      const result = await run(tx);
      await tx.commit();
      return result;
    } catch (error) {
      if (!tx.closed) await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
  }
  async status() {
    await this.ready();
    const row = (
      await this.client.execute("SELECT * FROM recovery_fence WHERE id=1")
    ).rows[0];
    const activities = (
      await this.client.execute(
        "SELECT id,parent_id,workspace_id,intent_id,kind,deployment,protocol,epoch,state,created_at FROM recovery_activities WHERE state!='done' ORDER BY created_at,id",
      )
    ).rows;
    const intents = (
      await this.client.execute(
        "SELECT workspace_id,id,kind,epoch,state,created_at FROM recovery_intents WHERE state!='resolved' ORDER BY created_at,id",
      )
    ).rows;
    return { ...row, activities, intents };
  }
  async takeDrainIntents(limit = 8, excluded = []) {
    return this.tx(async (tx) => {
      if (
        (await tx.execute("SELECT state FROM recovery_fence WHERE id=1"))
          .rows[0].state !== "draining"
      )
        return [];
      const skipped = excluded.slice(0, 20);
      const rows = (
        await tx.execute({
          sql: `SELECT i.* FROM recovery_intents i LEFT JOIN recovery_intent_attempts a ON a.workspace_id=i.workspace_id AND a.id=i.id WHERE i.state='accepted' ${skipped.map(() => "AND NOT (i.workspace_id=? AND i.id=?)").join(" ")} ORDER BY COALESCE(a.attempted_at,0),i.created_at,i.id LIMIT ?`,
          args: [
            ...skipped.flatMap((row) => [row.workspaceId, row.id]),
            Math.max(1, Math.min(20, limit)),
          ],
        })
      ).rows;
      for (const row of rows)
        await tx.execute({
          sql: "INSERT INTO recovery_intent_attempts(workspace_id,id,attempted_at) VALUES(?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET attempted_at=excluded.attempted_at",
          args: [row.workspace_id, row.id, this.clock()],
        });
      return rows;
    });
  }
  /** @param {{kind:string,parentId?:string|null,workspaceId?:string|null,intentId?:string|null}} input */
  async admit({ kind, parentId = null, workspaceId = null, intentId = null }) {
    return this.tx(async (tx) => {
      const fence = (
        await tx.execute("SELECT * FROM recovery_fence WHERE id=1")
      ).rows[0];
      if (fence.protocol !== RECOVERY_PROTOCOL || fence.state === "closed")
        throw new RecoveryFenceError();
      const parent = parentId
        ? (
            await tx.execute({
              sql: "SELECT id,workspace_id,intent_id,protocol FROM recovery_activities WHERE id=? AND state='active'",
              args: [parentId],
            })
          ).rows[0]
        : null;
      const intent =
        workspaceId && intentId
          ? (
              await tx.execute({
                sql: "SELECT epoch FROM recovery_intents WHERE workspace_id=? AND id=? AND state='accepted'",
                args: [workspaceId, intentId],
              })
            ).rows[0]
          : null;
      const liveParent = parent?.protocol === RECOVERY_PROTOCOL ? parent : null;
      const exactParent =
        liveParent &&
        (!intentId ||
          (liveParent.workspace_id === workspaceId &&
            liveParent.intent_id === intentId));
      if (
        fence.state !== "open" &&
        !exactParent &&
        !(intent && Number(intent.epoch) < Number(fence.epoch))
      )
        throw new RecoveryFenceError();
      const id = randomUUID();
      await tx.execute({
        sql: "INSERT INTO recovery_activities(id,parent_id,workspace_id,intent_id,kind,deployment,protocol,epoch,state,created_at) VALUES(?,?,?,?,?,?,?,?,'active',?)",
        args: [
          id,
          liveParent?.id ?? null,
          workspaceId ?? liveParent?.workspace_id ?? null,
          intentId ?? liveParent?.intent_id ?? null,
          kind,
          this.deployment,
          RECOVERY_PROTOCOL,
          fence.epoch,
          this.clock(),
        ],
      });
      return id;
    });
  }
  async finish(id, uncertain = false) {
    await this.ready();
    await this.client.execute({
      sql: "UPDATE recovery_activities SET state=?,finished_at=? WHERE id=? AND state='active'",
      args: [uncertain ? "uncertain" : "done", this.clock(), id],
    });
  }
  /** Only the same platform transaction that accepts the funded job may call this. */
  async acceptJobTx(tx, workspaceId, id, kind) {
    const prior = (
      await tx.execute({
        sql: "SELECT state FROM recovery_intents WHERE workspace_id=? AND id=?",
        args: [workspaceId, id],
      })
    ).rows[0];
    if (prior?.state === "accepted") return;
    if (prior)
      throw new RecoveryFenceError(
        "This recovery intent has already completed.",
      );
    const result = await tx.execute({
      sql: `INSERT INTO recovery_intents(workspace_id,id,kind,epoch,state,created_at) SELECT ?,?,?,epoch,'accepted',? FROM recovery_fence WHERE id=1 AND state='open' AND protocol=?`,
      args: [workspaceId, id, kind, this.clock(), RECOVERY_PROTOCOL],
    });
    if (!result.rowsAffected) throw new RecoveryFenceError();
  }
  /** A successful or conclusively rejected terminal bill is already durable in
   * the same transaction. In-flight child activities still prevent closure. */
  async resolveJobTx(tx, workspaceId, id) {
    await tx.execute({
      sql: "UPDATE recovery_intents SET state='resolved',resolved_at=? WHERE workspace_id=? AND id=? AND state='accepted'",
      args: [this.clock(), workspaceId, id],
    });
  }
  async begin(owner, preconditions, ttlMs = 30 * 60_000) {
    validatePreconditions(preconditions);
    if (
      !owner ||
      owner.length < 24 ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > 2 * 60 * 60_000
    )
      throw new Error("Invalid recovery coordinator identity or lifetime.");
    return this.tx(async (tx) => {
      const previous = (
        await tx.execute("SELECT state,epoch FROM recovery_fence WHERE id=1")
      ).rows[0];
      if (previous.state !== "open")
        throw new RecoveryFenceError(
          "A recovery coordinator already owns the closed admission gate. Expiry never reopens it.",
        );
      const at = this.clock(),
        epoch = Number(previous.epoch) + 1;
      await tx.execute({
        sql: "UPDATE recovery_fence SET state='draining',epoch=?,owner=?,expires_at=?,preconditions=?,inventory_hash=NULL,source_fingerprint=NULL,receipt_id=NULL,updated_at=? WHERE id=1",
        args: [epoch, owner, at + ttlMs, JSON.stringify(preconditions), at],
      });
      return { epoch, owner, expiresAt: at + ttlMs };
    });
  }
  owned(row, owner, epoch, fresh = true) {
    if (
      row.owner !== owner ||
      Number(row.epoch) !== epoch ||
      row.protocol !== RECOVERY_PROTOCOL ||
      row.state === "open"
    )
      throw new RecoveryFenceError(
        "The recovery coordinator no longer owns this epoch.",
      );
    if (fresh && Number(row.expires_at) <= this.clock())
      throw new RecoveryFenceError(
        "Coordinator expired. Admission remains closed; renew ownership before continuing.",
      );
  }
  async renew(owner, epoch, ttlMs = 30 * 60_000) {
    if (ttlMs <= 0 || ttlMs > 2 * 60 * 60_000)
      throw new Error("Invalid coordinator lifetime.");
    return this.tx(async (tx) => {
      const row = (await tx.execute("SELECT * FROM recovery_fence WHERE id=1"))
        .rows[0];
      this.owned(row, owner, epoch, false);
      await tx.execute({
        sql: "UPDATE recovery_fence SET expires_at=?,updated_at=? WHERE id=1",
        args: [this.clock() + ttlMs, this.clock()],
      });
    });
  }
  async seal(owner, epoch, sourceFingerprint, inventoryHash) {
    if (
      !/^[a-f0-9]{64}$/.test(sourceFingerprint) ||
      !/^[a-f0-9]{64}$/.test(inventoryHash)
    )
      throw new Error("Verified source and inventory digests are required.");
    return this.tx(async (tx) => {
      const row = (await tx.execute("SELECT * FROM recovery_fence WHERE id=1"))
        .rows[0];
      this.owned(row, owner, epoch);
      const active = (
        await tx.execute(
          "SELECT COUNT(*) AS n FROM recovery_activities WHERE state!='done'",
        )
      ).rows[0];
      const jobs = (
        await tx.execute(
          "SELECT COUNT(*) AS n FROM recovery_intents WHERE state!='resolved'",
        )
      ).rows[0];
      if (Number(active.n) || Number(jobs.n))
        throw new RecoveryFenceError(
          "Admitted or uncertain operations remain. A timeout is never evidence of quiescence.",
        );
      const receiptId = randomUUID(),
        at = this.clock();
      await tx.execute({
        sql: "UPDATE recovery_fence SET state='closed',inventory_hash=?,source_fingerprint=?,receipt_id=?,updated_at=? WHERE id=1",
        args: [inventoryHash, sourceFingerprint, receiptId, at],
      });
      return {
        version: 1,
        protocol: RECOVERY_PROTOCOL,
        epoch,
        receiptId,
        issuedAt: at,
        expiresAt: Number(row.expires_at),
        sourceFingerprint,
        inventoryHash,
        preconditions: JSON.parse(String(row.preconditions)),
      };
    });
  }
  async verify(receipt, sourceFingerprint) {
    await this.ready();
    const row = (
      await this.client.execute("SELECT * FROM recovery_fence WHERE id=1")
    ).rows[0];
    if (
      !receipt ||
      receipt.protocol !== RECOVERY_PROTOCOL ||
      row.state !== "closed" ||
      Number(row.epoch) !== receipt.epoch ||
      row.receipt_id !== receipt.receiptId ||
      row.source_fingerprint !== sourceFingerprint ||
      receipt.sourceFingerprint !== sourceFingerprint ||
      row.inventory_hash !== receipt.inventoryHash ||
      hash(JSON.parse(String(row.preconditions))) !==
        hash(receipt.preconditions) ||
      this.clock() >= Number(row.expires_at) ||
      this.clock() >= receipt.expiresAt
    )
      throw new RecoveryFenceError(
        "A fresh live closed fence matching this exact receipt and source inventory is required.",
      );
    return true;
  }
  async reopen(owner, epoch) {
    return this.tx(async (tx) => {
      const row = (await tx.execute("SELECT * FROM recovery_fence WHERE id=1"))
        .rows[0];
      this.owned(row, owner, epoch, false);
      await tx.execute({
        sql: "UPDATE recovery_fence SET state='open',owner=NULL,expires_at=NULL,receipt_id=NULL,inventory_hash=NULL,source_fingerprint=NULL,updated_at=? WHERE id=1",
        args: [this.clock()],
      });
    });
  }
}
export function validatePreconditions(value) {
  if (
    !value ||
    !Array.isArray(value.deployments) ||
    !value.deployments.length ||
    value.deployments.some((d) => !d.id || d.protocol !== RECOVERY_PROTOCOL) ||
    !value.externalWritersExcluded ||
    !value.oldDeploymentsStopped ||
    typeof value.evidence !== "string" ||
    value.evidence.trim().length < 20
  )
    throw new Error(
      "Receipt requires the supported deployment/protocol inventory and concrete evidence excluding old deployments, manual DB writers and external storage writers.",
    );
}
