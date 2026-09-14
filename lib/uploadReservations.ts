import type { Client, Transaction } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { db, ready, id, now } from "./db";
import { workspaceLimits, quotaVerdict } from "./limits";
import { deleteChunks, deleteUpload } from "./storage";

export const UPLOAD_TTL_MS = 24 * 3600_000;
export const UPLOAD_LEASE_MS = 20 * 60_000; // Longer than the 800-second finish function.
export const CHUNK_LEASE_MS = 5 * 60_000;
export const MAX_REFERENCE_BYTES = 200 * 1024 * 1024;
export const MAX_CHAT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_CHUNKS = Math.ceil(MAX_CHAT_BYTES / 3_500_000);
const MAX_SESSIONS = 32;
const initialized = new WeakMap<Client, Promise<void>>();

export class UploadError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "UploadError";
  }
}
export function uploadFailure(error: unknown): Response {
  if (error instanceof UploadError)
    return Response.json({ error: error.message }, { status: error.status });
  return Response.json(
    {
      error:
        "The upload could not finish. Its reserved storage will be released after cleanup. Try again shortly.",
    },
    { status: 503 },
  );
}
export async function uploadReservationsReady() {
  await ready();
  const client = db();
  let pending = initialized.get(client);
  if (!pending) {
    pending = client
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS upload_sessions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, state TEXT NOT NULL,
        reserved_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        lease TEXT, lease_until INTEGER, finish_key TEXT, upload_id TEXT NOT NULL,
        objects TEXT NOT NULL DEFAULT '[]', prepared TEXT, response TEXT,
        cleanup_attempted_at INTEGER NOT NULL DEFAULT 0
      )`,
          `CREATE TABLE IF NOT EXISTS upload_chunks (
        session_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        state TEXT NOT NULL, lease TEXT, lease_until INTEGER, PRIMARY KEY(session_id,chunk_index)
      )`,
          `CREATE INDEX IF NOT EXISTS upload_sessions_expiry ON upload_sessions(state,expires_at)`,
        ],
        "write",
      )
      .then(async () => {
        const columns = await client.execute(
          "PRAGMA table_info(upload_sessions)",
        );
        if (
          !columns.rows.some((column) => column.name === "cleanup_attempted_at")
        ) {
          await client
            .execute(
              "ALTER TABLE upload_sessions ADD COLUMN cleanup_attempted_at INTEGER NOT NULL DEFAULT 0",
            )
            .catch((error) => {
              // Another instance may have completed this additive migration.
              if (!/duplicate column name/i.test(String(error))) throw error;
            });
        }
      })
      .catch((error) => {
        initialized.delete(client);
        throw error;
      });
    initialized.set(client, pending);
  }
  await pending;
}
async function transaction<T>(work: (tx: Transaction) => Promise<T>) {
  await uploadReservationsReady();
  const tx = await db().transaction("write");
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  } finally {
    tx.close();
  }
}
const scoped = (owner: string, session: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(owner) || !/^[a-f0-9-]{16,64}$/.test(session))
    throw new UploadError("Invalid upload session.");
  return `${owner}/${session}`;
};
type Session = {
  id: string;
  owner_id: string;
  state: string;
  reserved_bytes: number;
  expires_at: number;
  lease: string | null;
  lease_until: number | null;
  finish_key: string | null;
  upload_id: string;
  objects: string;
  prepared: string | null;
  response: string | null;
};
async function sessionOf(
  tx: Transaction,
  key: string,
): Promise<Session | undefined> {
  return (
    await tx.execute({
      sql: "SELECT * FROM upload_sessions WHERE id=?",
      args: [key],
    })
  ).rows[0] as unknown as Session | undefined;
}
export async function reservedUploadBytes(): Promise<number> {
  await uploadReservationsReady();
  return Number(
    (
      await db().execute(
        "SELECT COALESCE(SUM(reserved_bytes),0) AS n FROM upload_sessions",
      )
    ).rows[0].n,
  );
}
async function admit(tx: Transaction, incoming: number, quota: number) {
  const result = await tx.execute(`SELECT
    (SELECT COALESCE(SUM(bytes),0) FROM generations) +
    (SELECT COALESCE(SUM(COALESCE(bytes,0)+COALESCE(derivative_bytes,0)),0) FROM uploads) +
    (SELECT COALESCE(SUM(reserved_bytes),0) FROM upload_sessions) AS used`);
  const verdict = quotaVerdict({
    usedBytes: Number(result.rows[0].used),
    incomingBytes: incoming,
    quotaBytes: quota,
  });
  if (!verdict.allow) throw new UploadError(verdict.error!, 507);
}
async function createSession(
  tx: Transaction,
  key: string,
  owner: string,
  bytes: number,
  at: number,
) {
  const active = Number(
    (
      await tx.execute(
        "SELECT COUNT(*) AS n FROM upload_sessions WHERE state NOT IN ('committed','aborted')",
      )
    ).rows[0].n,
  );
  if (active >= MAX_SESSIONS)
    throw new UploadError(
      "Too many unfinished uploads. Finish or cancel an upload before starting another.",
      429,
    );
  await tx.execute({
    sql: "INSERT INTO upload_sessions(id,owner_id,state,reserved_bytes,created_at,expires_at,upload_id) VALUES(?,?,'open',?,?,?,?)",
    args: [key, owner, bytes, at, at + UPLOAD_TTL_MS, id("upl")],
  });
}

export async function reserveUploadChunk(
  input: {
    owner: string;
    session: string;
    index: number;
    bytes: number;
    sha256: string;
  },
  at = now(),
) {
  const key = scoped(input.owner, input.session);
  if (
    !Number.isInteger(input.index) ||
    input.index < 0 ||
    input.index >= MAX_UPLOAD_CHUNKS ||
    input.bytes < 1 ||
    input.bytes > 4 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  )
    throw new UploadError("Invalid upload chunk.");
  const quota = (await workspaceLimits()).storageBytes;
  return transaction(async (tx) => {
    let session = await sessionOf(tx, key);
    if (session && (session.state !== "open" || session.expires_at <= at))
      throw new UploadError(
        "This upload session is closed or expired. Start a new upload.",
        409,
      );
    const existing = (
      await tx.execute({
        sql: "SELECT * FROM upload_chunks WHERE session_id=? AND chunk_index=?",
        args: [key, input.index],
      })
    ).rows[0];
    if (existing) {
      if (
        Number(existing.bytes) !== input.bytes ||
        existing.sha256 !== input.sha256
      )
        throw new UploadError(
          "This chunk already contains different bytes. Start a new upload.",
          409,
        );
      if (existing.state === "stored") return { key, stored: true, lease: "" };
      if (Number(existing.lease_until) > at)
        throw new UploadError(
          "This chunk is still being stored. Try again shortly.",
          409,
        );
    } else {
      await admit(tx, input.bytes, quota);
      if (!session) {
        await createSession(tx, key, input.owner, 0, at);
        session = await sessionOf(tx, key);
      }
      await tx.execute({
        sql: "UPDATE upload_sessions SET reserved_bytes=reserved_bytes+?,expires_at=? WHERE id=?",
        args: [input.bytes, at + UPLOAD_TTL_MS, key],
      });
    }
    const lease = randomUUID();
    await tx.execute({
      sql: `INSERT INTO upload_chunks(session_id,chunk_index,bytes,sha256,state,lease,lease_until) VALUES(?,?,?,?,'pending',?,?)
      ON CONFLICT(session_id,chunk_index) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until`,
      args: [
        key,
        input.index,
        input.bytes,
        input.sha256,
        lease,
        at + CHUNK_LEASE_MS,
      ],
    });
    return { key, stored: false, lease };
  });
}
export async function markUploadChunkStored(
  key: string,
  index: number,
  lease: string,
) {
  await transaction(async (tx) => {
    const done = await tx.execute({
      sql: "UPDATE upload_chunks SET state='stored',lease=NULL,lease_until=NULL WHERE session_id=? AND chunk_index=? AND lease=?",
      args: [key, index, lease],
    });
    if (!done.rowsAffected)
      throw new UploadError(
        "Upload ownership changed; start a new upload.",
        409,
      );
  });
}

export type UploadRecord = {
  id: string;
  filename: string;
  mime: string;
  ext: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  storedUrl: string;
  kind: string;
  durationS: number | null;
  derivativeUrl?: string | null;
  derivativeBytes?: number | null;
  derivativeNote?: string | null;
};
type Prepared = {
  record: UploadRecord;
  response: Record<string, unknown>;
  count: number;
};
export type FinishClaim = {
  key: string;
  lease: string;
  uploadId: string;
  bytes: number;
  prepared: Prepared | null;
  response: Record<string, unknown> | null;
};
export async function beginUploadFinish(
  owner: string,
  session: string,
  input: { count: number; filename: string; purpose: "chat" | "reference" },
  at = now(),
): Promise<FinishClaim> {
  if (
    !Number.isInteger(input.count) ||
    input.count < 1 ||
    input.count > MAX_UPLOAD_CHUNKS
  )
    throw new UploadError("Bad finish request.");
  const key = scoped(owner, session),
    finishKey = JSON.stringify(input);
  return transaction(async (tx) => {
    const found = await sessionOf(tx, key);
    if (
      !found ||
      found.state === "aborted" ||
      found.state === "aborting" ||
      found.expires_at <= at
    )
      throw new UploadError(
        "This upload has expired or was cancelled. Start it again.",
        410,
      );
    if (found.finish_key && found.finish_key !== finishKey)
      throw new UploadError(
        "The upload finish request changed. Start a new upload.",
        409,
      );
    if (
      found.response &&
      !(
        await tx.execute({
          sql: "SELECT id FROM uploads WHERE id=?",
          args: [found.upload_id],
        })
      ).rows.length
    )
      throw new UploadError(
        "This upload was removed. Start a new upload.",
        410,
      );
    if (found.response)
      return {
        key,
        lease: "",
        uploadId: found.upload_id,
        bytes: 0,
        prepared: null,
        response: JSON.parse(found.response),
      };
    if (Number(found.lease_until) > at)
      throw new UploadError(
        "This upload is still finishing. Try again shortly.",
        409,
      );
    const chunks = (
      await tx.execute({
        sql: "SELECT chunk_index,bytes,state FROM upload_chunks WHERE session_id=? ORDER BY chunk_index",
        args: [key],
      })
    ).rows;
    if (
      !found.prepared &&
      (chunks.length !== input.count ||
        chunks.some(
          (chunk, i) =>
            Number(chunk.chunk_index) !== i || chunk.state !== "stored",
        ))
    )
      throw new UploadError(
        "Some upload chunks are missing or still being stored.",
        409,
      );
    const bytes = chunks.reduce(
      (total, chunk) => total + Number(chunk.bytes),
      0,
    );
    if (
      !found.prepared &&
      bytes > (input.purpose === "chat" ? MAX_CHAT_BYTES : MAX_REFERENCE_BYTES)
    )
      throw new UploadError(
        input.purpose === "chat"
          ? "Chat files top out at 2 GB."
          : "Reference files top out at 200 MB.",
        413,
      );
    const lease = randomUUID();
    await tx.execute({
      sql: "UPDATE upload_sessions SET state='assembling',lease=?,lease_until=?,finish_key=?,expires_at=? WHERE id=?",
      args: [lease, at + UPLOAD_LEASE_MS, finishKey, at + UPLOAD_TTL_MS, key],
    });
    return {
      key,
      lease,
      uploadId: found.upload_id,
      bytes,
      prepared: found.prepared ? JSON.parse(found.prepared) : null,
      response: null,
    };
  });
}
export async function beginDirectUpload(
  owner: string,
  bytes: number,
  at = now(),
): Promise<FinishClaim> {
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > 4 * 1024 * 1024)
    throw new UploadError(
      "Direct uploads must be between 1 byte and 4 MB.",
      413,
    );
  const key = scoped(owner, randomUUID()),
    quota = (await workspaceLimits()).storageBytes,
    lease = randomUUID();
  return transaction(async (tx) => {
    await admit(tx, bytes, quota);
    await createSession(tx, key, owner, bytes, at);
    await tx.execute({
      sql: "UPDATE upload_sessions SET state='assembling',lease=?,lease_until=? WHERE id=?",
      args: [lease, at + UPLOAD_LEASE_MS, key],
    });
    const session = (await sessionOf(tx, key))!;
    return {
      key,
      lease,
      uploadId: session.upload_id,
      bytes,
      prepared: null,
      response: null,
    };
  });
}
async function owned(tx: Transaction, claim: FinishClaim): Promise<Session> {
  const session = await sessionOf(tx, claim.key);
  if (
    !session ||
    session.lease !== claim.lease ||
    session.state !== "assembling"
  )
    throw new UploadError("Upload ownership changed. Try again shortly.", 409);
  return session;
}
/** Record every possible storage object before writing it, so partial failures remain recoverable. */
export async function planUploadObjects(
  claim: FinishClaim,
  objects: { id: string; ext: string }[],
  bytes: number,
) {
  const quota = (await workspaceLimits()).storageBytes;
  await transaction(async (tx) => {
    const session = await owned(tx, claim);
    if (
      objects.some(
        (object) =>
          !/^[A-Za-z0-9_-]+$/.test(object.id) ||
          !/^[A-Za-z0-9]+$/.test(object.ext),
      )
    )
      throw new UploadError("Invalid stored upload path.");
    await admit(tx, Math.max(0, bytes - Number(session.reserved_bytes)), quota);
    const prior = JSON.parse(session.objects) as { id: string; ext: string }[];
    const combined = [...prior, ...objects].filter(
      (object, index, all) =>
        all.findIndex(
          (other) => other.id === object.id && other.ext === object.ext,
        ) === index,
    );
    await tx.execute({
      sql: "UPDATE upload_sessions SET objects=?,reserved_bytes=? WHERE id=? AND lease=?",
      args: [
        JSON.stringify(combined),
        Math.max(bytes, Number(session.reserved_bytes)),
        claim.key,
        claim.lease,
      ],
    });
  });
}
export async function prepareUpload(claim: FinishClaim, prepared: Prepared) {
  await transaction(async (tx) => {
    const session = await owned(tx, claim);
    if (
      prepared.record.id !== session.upload_id ||
      prepared.record.bytes + (prepared.record.derivativeBytes ?? 0) !==
        Number(session.reserved_bytes)
    )
      throw new UploadError(
        "The stored upload does not match its reservation.",
      );
    await tx.execute({
      sql: "UPDATE upload_sessions SET prepared=? WHERE id=? AND lease=?",
      args: [JSON.stringify(prepared), claim.key, claim.lease],
    });
  });
  claim.prepared = prepared;
}
/** Staging disappears before its reserved bytes become the published upload row. */
export async function completeUpload(
  claim: FinishClaim,
): Promise<Record<string, unknown>> {
  if (claim.response) return claim.response;
  const prepared = claim.prepared;
  if (!prepared)
    throw new UploadError("The upload has not finished storing.", 409);
  if (prepared.count) await deleteChunks(claim.key, prepared.count, true);
  return transaction(async (tx) => {
    await owned(tx, claim);
    const r = prepared.record;
    await tx.execute({
      sql: `INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,kind,duration_s,created_at,derivative_url,derivative_bytes,derivative_note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        r.id,
        r.filename,
        r.mime,
        r.ext,
        r.bytes,
        r.sha256,
        r.width,
        r.height,
        r.storedUrl,
        r.kind,
        r.durationS,
        now(),
        r.derivativeUrl ?? null,
        r.derivativeBytes ?? null,
        r.derivativeNote ?? null,
      ],
    });
    await tx.execute({
      sql: "DELETE FROM upload_chunks WHERE session_id=?",
      args: [claim.key],
    });
    await tx.execute({
      sql: "UPDATE upload_sessions SET state='committed',reserved_bytes=0,lease=NULL,lease_until=NULL,response=?,prepared=NULL WHERE id=?",
      args: [JSON.stringify(prepared.response), claim.key],
    });
    return prepared.response;
  });
}
/** Failed storage writes may have been accepted remotely. Keep their lease before cleanup. */
export async function abandonUpload(claim: FinishClaim) {
  await transaction(async (tx) => {
    const session = await sessionOf(tx, claim.key);
    if (
      !session ||
      session.lease !== claim.lease ||
      session.state !== "assembling"
    )
      return;
    // Prepared bytes can be published by an identical finish retry without any new write.
    if (session.prepared) {
      await tx.execute({
        sql: "UPDATE upload_sessions SET lease=NULL,lease_until=NULL WHERE id=? AND lease=?",
        args: [claim.key, claim.lease],
      });
      return;
    }
    const hasObjects = (JSON.parse(session.objects) as unknown[]).length > 0;
    await tx.execute({
      sql: "UPDATE upload_sessions SET state='aborting',expires_at=?,lease=NULL,lease_until=? WHERE id=? AND lease=?",
      args: [
        now(),
        hasObjects ? session.lease_until : null,
        claim.key,
        claim.lease,
      ],
    });
  });
}
export async function abortUploadSession(owner: string, session: string) {
  const key = scoped(owner, session);
  await transaction(async (tx) => {
    await tx.execute({
      sql: "UPDATE upload_sessions SET state='aborting',expires_at=? WHERE id=? AND state NOT IN ('committed','aborted')",
      args: [now(), key],
    });
  });
}
/** Transfer an existing upload into durable cleanup in the caller's reference-check transaction. */
export async function queueUploadDeletion(
  tx: Transaction,
  owner: string,
  uploadId: string,
) {
  const row = (
    await tx.execute({
      sql: "SELECT * FROM uploads WHERE id=?",
      args: [uploadId],
    })
  ).rows[0];
  if (!row) return null;
  const key = scoped(owner, randomUUID());
  const objects = [
    { id: uploadId, ext: String(row.ext), url: String(row.stored_url) },
  ];
  // deriveForProvider always writes a JPEG delivery copy; the master remains unchanged.
  if (row.derivative_url)
    objects.push({
      id: uploadId + "-api",
      ext: "jpg",
      url: String(row.derivative_url),
    });
  await tx.execute({
    sql: "INSERT INTO upload_sessions(id,owner_id,state,reserved_bytes,created_at,expires_at,upload_id,objects) VALUES(?,?,'aborting',?,?,?,?,?)",
    args: [
      key,
      owner,
      Number(row.bytes ?? 0) + Number(row.derivative_bytes ?? 0),
      now(),
      now(),
      uploadId,
      JSON.stringify(objects),
    ],
  });
  await tx.execute({ sql: "DELETE FROM uploads WHERE id=?", args: [uploadId] });
  return key;
}
/** Abort/expiry releases nothing until every staged or unpublished object is actually removed. */
export async function cleanupExpiredUploads(
  limit = 10,
  at = now(),
  onlyKey?: string,
) {
  await uploadReservationsReady();
  const candidates = (
    await db().execute({
      sql: `SELECT id FROM upload_sessions s WHERE (? IS NULL OR id=?) AND state NOT IN ('committed','aborted') AND expires_at<=?
    AND COALESCE(lease_until,0)<=? AND NOT EXISTS (SELECT 1 FROM upload_chunks c WHERE c.session_id=s.id AND COALESCE(c.lease_until,0)>?)
    ORDER BY cleanup_attempted_at,expires_at,id LIMIT ?`,
      args: [
        onlyKey ?? null,
        onlyKey ?? null,
        at,
        at,
        at,
        Math.min(32, Math.max(1, limit)),
      ],
    })
  ).rows;
  let cleaned = 0,
    failed = 0;
  for (const candidate of candidates) {
    const lease = randomUUID();
    const session = await transaction(async (tx) => {
      const result = await tx.execute({
        sql: `UPDATE upload_sessions SET state='aborting',lease=?,lease_until=?,cleanup_attempted_at=? WHERE id=? AND state NOT IN ('committed','aborted') AND expires_at<=? AND COALESCE(lease_until,0)<=?
        AND NOT EXISTS(SELECT 1 FROM upload_chunks c WHERE c.session_id=upload_sessions.id AND COALESCE(c.lease_until,0)>?)`,
        args: [
          lease,
          at + UPLOAD_LEASE_MS,
          at,
          String(candidate.id),
          at,
          at,
          at,
        ],
      });
      return result.rowsAffected
        ? sessionOf(tx, String(candidate.id))
        : undefined;
    });
    if (!session) continue;
    try {
      const chunks = (
        await db().execute({
          sql: "SELECT chunk_index FROM upload_chunks WHERE session_id=?",
          args: [session.id],
        })
      ).rows;
      // Missing chunk numbers are harmless: deleting deterministic absent paths is idempotent.
      if (chunks.length)
        await deleteChunks(
          session.id,
          Math.max(...chunks.map((chunk) => Number(chunk.chunk_index))) + 1,
          true,
        );
      for (const object of JSON.parse(session.objects) as {
        id: string;
        ext: string;
        url?: string;
      }[])
        await deleteUpload(
          object.id,
          object.ext,
          object.url ?? `/api/uploads/${object.id}`,
          true,
        );
      await transaction(async (tx) => {
        const result = await tx.execute({
          sql: "UPDATE upload_sessions SET state='aborted',reserved_bytes=0,lease=NULL,lease_until=NULL,prepared=NULL,objects='[]' WHERE id=? AND lease=?",
          args: [session.id, lease],
        });
        if (!result.rowsAffected)
          throw new UploadError("Cleanup ownership changed.", 409);
        await tx.execute({
          sql: "DELETE FROM upload_chunks WHERE session_id=?",
          args: [session.id],
        });
      });
      cleaned++;
    } catch {
      failed++;
      await db().execute({
        sql: "UPDATE upload_sessions SET lease=NULL,lease_until=NULL WHERE id=? AND lease=?",
        args: [session.id, lease],
      });
    }
  }
  await db().execute({
    sql: "DELETE FROM upload_sessions WHERE state IN ('committed','aborted') AND expires_at<?",
    args: [at - 7 * 86400_000],
  });
  return { attempted: candidates.length, cleaned, failed };
}

/** Owner-scoped recovery facts only; leases and private storage locations never leave the server. */
export async function uploadSessionStatus(
  owner: string,
  session: string,
  at = now(),
) {
  await uploadReservationsReady();
  const key = scoped(owner, session);
  const row = (
    await db().execute({
      sql: "SELECT * FROM upload_sessions WHERE id=?",
      args: [key],
    })
  ).rows[0] as unknown as Session | undefined;
  if (!row) return null;
  const chunks = (
    await db().execute({
      sql: "SELECT chunk_index,state,lease_until FROM upload_chunks WHERE session_id=? ORDER BY chunk_index",
      args: [key],
    })
  ).rows;
  const finish = row.finish_key
    ? (JSON.parse(row.finish_key) as {
        count: number;
        filename: string;
        purpose: "chat" | "reference";
      })
    : undefined;
  const retryAfterMs = Math.max(
    0,
    Number(row.lease_until ?? 0) - at,
    ...chunks.map((chunk) => Number(chunk.lease_until ?? 0) - at),
  );
  let state = row.state;
  let upload: Record<string, unknown> | undefined;
  if (row.response) {
    const exists = (
      await db().execute({
        sql: "SELECT id FROM uploads WHERE id=?",
        args: [row.upload_id],
      })
    ).rows.length;
    state = exists ? "committed" : "removed";
    if (exists) upload = JSON.parse(row.response);
  } else if (row.expires_at <= at && !["aborting", "aborted"].includes(state))
    state = "expired";
  else if (row.prepared && retryAfterMs === 0) state = "prepared";
  return {
    state,
    storedChunks: chunks
      .filter((chunk) => chunk.state === "stored")
      .map((chunk) => Number(chunk.chunk_index)),
    ...(finish ? { finish, count: finish.count } : {}),
    ...(upload ? { upload } : {}),
    retryAfterMs,
  };
}
