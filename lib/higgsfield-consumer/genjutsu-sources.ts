import type { Client, Transaction } from "@libsql/client";
import { createHash } from "node:crypto";
import { db, ready } from "@/lib/db";
import { workbenchTransaction } from "@/lib/workbench/records";
import { inspectOriginalVideo } from "@/lib/videoMetadata.server";
import {
  imagePath,
  videoPath,
  uploadPath,
  presignedReadUrl,
  usingBlob,
} from "@/lib/storage";
import { engineMock } from "@/lib/mock";
import type { Reference } from "@/lib/ark";
import { withRecoveryActivity } from "@/lib/recovery";
import {
  consumerMediaKey,
  parseConsumerGenjutsuInput,
  type ConsumerGenjutsuInput,
} from "./genjutsu-contract";

export class ConsumerGenjutsuError extends Error {
  constructor(
    public readonly code:
      | "source_unavailable"
      | "source_limits"
      | "import_uncertain"
      | "import_changed",
    public readonly status = 409,
  ) {
    super(
      {
        source_unavailable:
          "An original source is unavailable in this workspace.",
        source_limits:
          "Choose a 4–30 second original video and still images, each no larger than 50 MB.",
        import_uncertain:
          "An earlier media transfer could not be confirmed. It will not be retried automatically. No video was submitted.",
        import_changed:
          "The source, connection or selected connected wallet changed. Request a new quote.",
      }[code],
    );
  }
}
const MAX_BYTES = 50 * 1024 * 1024;
/** Source identities are checked in the final job/dispatch write transaction,
 * shared with deletion, so an earlier metadata read cannot admit stale sources. */
export async function validateConsumerGenjutsuSources(
  tx: Pick<Transaction, "execute">,
  value: unknown,
) {
  const input = parseConsumerGenjutsuInput(value);
  const refs: Reference[] = [];
  const sizes: number[] = [];
  for (const [i, ref] of [input.source, ...input.references].entries()) {
    const fromGeneration = Boolean(ref.genId),
      id = ref.genId ?? ref.uploadId!;
    const row = (
      await tx.execute({
        sql: fromGeneration
          ? "SELECT * FROM generations WHERE id=? AND deleted=0"
          : "SELECT * FROM uploads WHERE id=?",
        args: [id],
      })
    ).rows[0];
    if (
      !row ||
      !row.stored_url ||
      (fromGeneration && row.status !== "succeeded")
    )
      throw new ConsumerGenjutsuError("source_unavailable");
    const kind = i === 0 ? "video" : "image",
      bytes = Number(row.bytes);
    if (
      row.kind !== kind ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > MAX_BYTES
    )
      throw new ConsumerGenjutsuError("source_limits", 400);
    const ext = fromGeneration
      ? kind === "video"
        ? "mp4"
        : "png"
      : String(row.ext);
    if (!/^[A-Za-z0-9]+$/.test(ext))
      throw new ConsumerGenjutsuError("source_unavailable");
    refs.push({
      id,
      kind,
      fromGeneration,
      storedUrl: String(row.stored_url),
      ext,
      mime: fromGeneration
        ? kind === "video"
          ? "video/mp4"
          : "image/png"
        : String(row.mime),
      role: kind === "video" ? "reference_video" : "reference_image",
    });
    sizes.push(bytes);
  }
  return { refs, sizes };
}
export async function resolveConsumerGenjutsuSources(
  input: ConsumerGenjutsuInput,
) {
  await ready();
  const { refs, sizes } = await validateConsumerGenjutsuSources(db(), input);
  let source;
  try {
    source = await inspectOriginalVideo(refs[0], sizes[0]);
  } catch {
    throw new ConsumerGenjutsuError("source_limits", 400);
  }
  if (source.seconds < 4 || source.seconds > 30)
    throw new ConsumerGenjutsuError("source_limits", 400);
  if (!engineMock() && !usingBlob())
    throw new ConsumerGenjutsuError("source_unavailable", 503);
  const sources = await Promise.all(
    refs.map(async (ref) => {
      const path = ref.fromGeneration
        ? ref.kind === "video"
          ? videoPath(ref.id)
          : imagePath(ref.id)
        : uploadPath(ref.id, ref.ext);
      return {
        url: engineMock()
          ? `https://fixtures.particl.invalid/${path}`
          : await presignedReadUrl(path),
        type: ref.kind as "video" | "image",
      };
    }),
  );
  return { sources, source };
}
const initialized = new WeakMap<Client, Promise<void>>();
export async function consumerMediaImportsReady() {
  await ready();
  const client = db();
  if (!initialized.has(client))
    initialized.set(
      client,
      client
        .execute(
          `CREATE TABLE IF NOT EXISTS higgsfield_consumer_media_imports (
 user_id TEXT NOT NULL,draft_id TEXT NOT NULL,quote_key TEXT NOT NULL,source_index INTEGER NOT NULL,
 fingerprint TEXT NOT NULL,workspace_id TEXT NOT NULL,connection_generation TEXT NOT NULL,source_identity TEXT NOT NULL,
 state TEXT NOT NULL,media_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,draft_id,quote_key,source_index))`,
        )
        .then(() => {})
        .catch((e) => {
          initialized.delete(client);
          throw e;
        }),
    );
  await initialized.get(client);
}
/** No expiry/reclaim: a failed acknowledgement can still have imported bytes.
 * Successful receipts survive a lost quote response and reuse the same UUID. */
export async function resolveConsumerMediaImport(
  input: {
    userId: string;
    draftId: string;
    quoteKey: string;
    sourceIndex: number;
    request: ConsumerGenjutsuInput;
    workspaceId: string;
    connectionGeneration: string;
  },
  perform: () => Promise<string>,
) {
  await consumerMediaImportsReady();
  const source = [input.request.source, ...input.request.references][
    input.sourceIndex
  ];
  if (!source) throw new ConsumerGenjutsuError("source_unavailable");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        request: parseConsumerGenjutsuInput(input.request),
        workspaceId: input.workspaceId,
        generation: input.connectionGeneration,
      }),
    )
    .digest("hex");
  const keys = [input.userId, input.draftId, input.quoteKey, input.sourceIndex];
  const previous = await workbenchTransaction(async (tx) => {
    const draft = (
      await tx.execute({
        sql: "SELECT 1 FROM workbench_projects WHERE owner=? AND project_id=?",
        args: [input.userId, input.draftId],
      })
    ).rows[0];
    if (!draft) throw new ConsumerGenjutsuError("source_unavailable");
    await validateConsumerGenjutsuSources(tx, input.request);
    const row = (
      await tx.execute({
        sql: "SELECT * FROM higgsfield_consumer_media_imports WHERE user_id=? AND draft_id=? AND quote_key=? AND source_index=?",
        args: keys,
      })
    ).rows[0];
    if (row) {
      if (row.fingerprint !== fingerprint)
        throw new ConsumerGenjutsuError("import_changed");
      if (row.state === "ready" && typeof row.media_id === "string")
        return row.media_id;
      throw new ConsumerGenjutsuError("import_uncertain");
    }
    const now = Date.now();
    await tx.execute({
      sql: "INSERT INTO higgsfield_consumer_media_imports VALUES(?,?,?,?,?,?,?,?,'claimed',NULL,?,?)",
      args: [
        ...keys,
        fingerprint,
        input.workspaceId,
        input.connectionGeneration,
        consumerMediaKey(source),
        now,
        now,
      ],
    });
    return null;
  });
  if (previous) return previous;
  return withRecoveryActivity(
    "consumer-media-import",
    async () => {
      const mediaId = await perform();
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(mediaId))
        throw new ConsumerGenjutsuError("import_uncertain");
      const result = await db().execute({
        sql: "UPDATE higgsfield_consumer_media_imports SET state='ready',media_id=?,updated_at=? WHERE user_id=? AND draft_id=? AND quote_key=? AND source_index=? AND fingerprint=? AND state='claimed'",
        args: [mediaId, Date.now(), ...keys, fingerprint],
      });
      if (result.rowsAffected !== 1)
        throw new ConsumerGenjutsuError("import_uncertain");
      return mediaId;
    },
    { uncertainOnError: true },
  );
}
