import { createHash } from "node:crypto";
import { db, ready, now } from "./db";
import { getWorkspace } from "./platform";
import { runInTenant, requireTenant } from "./tenant";
import {
  storeUpload,
  readUploadBytes,
  deleteUpload,
  usingBlob,
  uploadPath,
} from "./storage";

export type WorkerProbeReceipt = {
  probeId: string;
  workspaceId: string;
  environment: string;
  deployment: string;
  status: "running" | "succeeded" | "failed";
  database: boolean;
  storage: boolean;
  cleanup: boolean;
  blob: boolean;
  sha256: string | null;
  storagePath: string;
  startedAt: number;
  finishedAt: number | null;
};
export function workerProbeIdentity() {
  return {
    environment:
      process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    deployment:
      process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_URL ?? "local",
  };
}
async function probeReady() {
  await ready();
  await db().execute(`CREATE TABLE IF NOT EXISTS worker_probe_receipts (
    id TEXT NOT NULL, environment TEXT NOT NULL, deployment TEXT NOT NULL,
    receipt TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(id,environment,deployment)
  )`);
}

/** Read-only proof for this exact deployment/environment in the resolved probe workspace. */
export async function latestWorkerProbe(): Promise<WorkerProbeReceipt | null> {
  await probeReady();
  const identity = workerProbeIdentity();
  const row = (
    await db().execute({
      sql: `SELECT receipt FROM worker_probe_receipts WHERE environment=? AND deployment=? ORDER BY updated_at DESC LIMIT 1`,
      args: [identity.environment, identity.deployment],
    })
  ).rows[0];
  return row ? (JSON.parse(String(row.receipt)) as WorkerProbeReceipt) : null;
}

/** No model calls. An authenticated Inngest event must name its isolated probe workspace. */
export async function runWorkerProbe(input: {
  workspaceId: string;
  probeId: string;
  expectedDeployment?: string;
  expectedEnvironment?: string;
}): Promise<WorkerProbeReceipt> {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.probeId) || !input.workspaceId)
    throw new Error("A scoped worker probe ID and workspace are required.");
  const identity = workerProbeIdentity();
  if (
    (input.expectedDeployment != null &&
      input.expectedDeployment !== identity.deployment) ||
    (input.expectedEnvironment != null &&
      input.expectedEnvironment !== identity.environment)
  )
    throw new Error(
      "This worker probe reached a different deployment or environment.",
    );
  const ws = await getWorkspace(input.workspaceId);
  if (!ws || ws.deletedAt || ws.suspendedAt || ws.legacy)
    throw new Error("An active isolated probe workspace is required.");
  return runInTenant(ws, async () => {
    await probeReady();
    const existing = (
      await db().execute({
        sql: "SELECT receipt FROM worker_probe_receipts WHERE id=? AND environment=? AND deployment=?",
        args: [input.probeId, identity.environment, identity.deployment],
      })
    ).rows[0];
    if (existing) {
      const receipt = JSON.parse(
        String(existing.receipt),
      ) as WorkerProbeReceipt;
      if (receipt.status === "succeeded") return receipt;
    }
    const digest = createHash("sha256")
      .update(
        `${requireTenant().id}:${identity.environment}:${identity.deployment}:${input.probeId}`,
      )
      .digest("hex");
    const uploadId = `worker_probe_${digest}`;
    const challenge = Buffer.from(`Particl worker storage proof\n${digest}\n`);
    const receipt: WorkerProbeReceipt = {
      probeId: input.probeId,
      workspaceId: ws.id,
      ...identity,
      status: "running",
      database: false,
      storage: false,
      cleanup: false,
      blob: usingBlob(),
      sha256: null,
      storagePath: uploadPath(uploadId, "txt"),
      startedAt: now(),
      finishedAt: null,
    };
    const persist = async () =>
      db().execute({
        sql: `INSERT INTO worker_probe_receipts(id,environment,deployment,receipt,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id,environment,deployment) DO UPDATE SET receipt=excluded.receipt,updated_at=excluded.updated_at`,
        args: [
          input.probeId,
          identity.environment,
          identity.deployment,
          JSON.stringify(receipt),
          receipt.startedAt,
          now(),
        ],
      });
    await persist();
    // This proves a write/read round trip, not just SELECT 1 against an unrelated DB.
    receipt.database = Boolean(
      (
        await db().execute({
          sql: "SELECT id FROM worker_probe_receipts WHERE id=?",
          args: [input.probeId],
        })
      ).rows[0],
    );
    let storedUrl = `/api/uploads/${uploadId}`;
    try {
      const stored = await storeUpload(
        uploadId,
        "txt",
        challenge,
        "text/plain",
      );
      storedUrl = stored.url;
      const downloaded = await readUploadBytes(uploadId, "txt", storedUrl);
      if (!downloaded.equals(challenge))
        throw new Error("Storage probe content mismatch.");
      receipt.sha256 = createHash("sha256").update(downloaded).digest("hex");
      receipt.storage = true;
    } catch {
      receipt.status = "failed";
    } finally {
      try {
        await deleteUpload(uploadId, "txt", storedUrl, true);
        receipt.cleanup = true;
      } catch {
        receipt.status = "failed";
      }
    }
    receipt.status =
      receipt.database && receipt.storage && receipt.cleanup
        ? "succeeded"
        : "failed";
    receipt.finishedAt = now();
    await persist();
    if (receipt.status !== "succeeded")
      throw new Error(
        "Worker database/storage verification failed; inspect its scoped receipt.",
      );
    return receipt;
  });
}
