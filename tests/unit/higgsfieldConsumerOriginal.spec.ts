import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ProductFetchDependencies } from "../../lib/workbench/product-fetch";
import { seedCollectedOriginal } from "../helpers/consumerLedger";

/**
 * Originals collected from the connected account, after its sign-in was
 * removed: nothing collects one any more, so what is tested is what still
 * reads them (the Library's retained take, deletion's retention guard, purge)
 * plus the pieces the API-key collector shares: the pinned public fetch and
 * the MP4 inspection (lib/videoOriginal.ts). Collected originals are seeded
 * as the old collector left them (tests/helpers/consumerLedger.ts).
 */
const directory = mkdtempSync(
  path.join(tmpdir(), "particl-consumer-original-"),
);
process.env.PLATFORM_DATABASE_URL = `file:${directory}/platform.db`;
process.env.KEYRING_SECRET ??= "consumer-original-unit-keyring-not-real";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";
const original = readFileSync("tests/fixtures/astra-source.mp4");
const sourceUrl = "https://media.example.com/original.mp4";
const saved: string[] = [];
test.afterAll(async () => {
  await Promise.all(
    saved.map((id) =>
      unlink(path.join(process.cwd(), ".data/generations", `${id}.mp4`)).catch(
        () => {},
      ),
    ),
  );
});
function workspace(quota = original.length * 4): TenantWorkspace {
  const id = `consumer-original-${randomUUID()}`;
  return {
    id,
    slug: id,
    name: id,
    legacy: false,
    dbUrl: `file:${directory}/${id}.db`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: false,
    allowanceUsd: null,
    ownerId: "owner",
    createdAt: 0,
    gatewayKeyId: null,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: null,
    rendersPerHour: null,
    storageQuotaBytes: quota,
    deletedAt: null,
  };
}
type Page = {
  status?: number;
  headers?: IncomingMessage["headers"];
  bytes?: Buffer;
};
function transport(pages: Page[] = [{ bytes: original }]) {
  const calls: { url: URL; options: RequestOptions }[] = [];
  const request = ((
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    calls.push({ url, options });
    const req = new EventEmitter() as ClientRequest;
    req.destroy = () => req;
    req.end = (() => {
      queueMicrotask(() => {
        const page = pages.shift();
        if (!page) {
          req.emit("error", new Error("No fixture response"));
          return;
        }
        const response = Readable.from([
          page.bytes ?? original,
        ]) as IncomingMessage;
        response.statusCode = page.status ?? 200;
        response.headers = { "content-type": "video/mp4", ...page.headers };
        callback(response);
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as ProductFetchDependencies["https"];
  return {
    calls,
    deps: {
      http: request,
      https: request,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    },
  };
}
async function modules() {
  return {
    originals: await import("../../lib/higgsfield-consumer/video-original"),
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    database: await import("../../lib/db"),
    tenant: await import("../../lib/tenant"),
    storage: await import("../../lib/storage"),
    quota: await import("../../lib/limits"),
    uploads: await import("../../lib/uploadReservations"),
  };
}
/** A draft on a production, and an original the account made in it, collected before the sign-in was removed. */
async function collected(m: Awaited<ReturnType<typeof modules>>, options: { completed?: boolean } = {}) {
  await m.database.ready();
  const draftId = `draft-${randomUUID()}`,
    productionId = `project-${randomUUID()}`;
  await m.database.db().execute({
    sql: "INSERT INTO projects(id,name,created_at) VALUES(?,'Fixture',0)",
    args: [productionId],
  });
  await m.database.db().execute({
    sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,'owner',?,'Fixture',?,1,0)",
    args: [draftId, draftId, JSON.stringify({ productionProjectId: productionId })],
  });
  const seeded = await seedCollectedOriginal({ userId: "owner", draftId, bytes: original, projectId: productionId, completed: options.completed });
  saved.push(seeded.generationId);
  const scope = { id: seeded.jobId, userId: "owner", draftId };
  return { ...seeded, scope, draftId, productionId };
}

test("video transport pins every public destination, forwards no credentials, and refuses unsafe redirects/MIME/compression/size", async () => {
  const { fetchPublicConsumerVideoBytes, CONSUMER_VIDEO_BYTES } =
    await import("../../lib/workbench/product-fetch");
  const good = transport([
    { status: 302, headers: { location: "/final.mp4" } },
    { bytes: original },
  ]);
  expect(
    (await fetchPublicConsumerVideoBytes(sourceUrl, good.deps)).bytes.equals(
      original,
    ),
  ).toBe(true);
  for (const call of good.calls) {
    expect(call.options).toMatchObject({
      agent: false,
      method: "GET",
      headers: { "Accept-Encoding": "identity" },
    });
    expect(JSON.stringify(call.options.headers)).not.toMatch(
      /authorization|cookie|bearer/i,
    );
    call.options.lookup!("media.example.com", {}, (err, address) => {
      expect(err).toBeNull();
      expect(address).toBe("93.184.216.34");
    });
  }
  const insecure = transport();
  await expect(
    fetchPublicConsumerVideoBytes(
      "http://media.example.com/video",
      insecure.deps,
    ),
  ).rejects.toMatchObject({ code: "unsafe_url" });
  expect(insecure.calls).toHaveLength(0);
  for (const page of [
    { status: 302, headers: { location: "https://127.0.0.1/private" } },
    { headers: { "content-type": "text/html" } },
    { headers: { "content-encoding": "gzip" } },
    { headers: { "content-length": String(CONSUMER_VIDEO_BYTES + 1) } },
    { headers: { "content-length": String(original.length + 1) } },
    { headers: { "content-length": "invalid" } },
  ]) {
    const bad = transport([page]);
    await expect(
      fetchPublicConsumerVideoBytes(sourceUrl, bad.deps),
    ).rejects.toThrow();
    expect(bad.calls).toHaveLength(1);
  }
  const privateDns = transport();
  await expect(
    fetchPublicConsumerVideoBytes(sourceUrl, {
      ...privateDns.deps,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
  ).rejects.toMatchObject({ code: "unsafe_url" });
  expect(privateDns.calls).toHaveLength(0);
});

test("actual MP4 inspection measures original packets and rejects invalid or overlong media without conversion", async () => {
  const inspection = await import("../../lib/videoOriginal");
  expect(await inspection.inspectVideoOriginal(original)).toEqual({
    width: 720,
    height: 1280,
    seconds: 1.5,
  });
  for (const bytes of [
    Buffer.from("<html>not an original</html>"),
    original.subarray(0, 32),
    original.subarray(0, Math.floor(original.length / 2)),
  ])
    await expect(
      inspection.inspectVideoOriginal(bytes),
    ).rejects.toMatchObject({ code: "invalid_video" });
  const stretched = (factor: number) => {
    const long = Buffer.from(original);
    for (let from = 0; ;) {
      const at = long.indexOf("stts", from);
      if (at < 0) break;
      const entries = long.readUInt32BE(at + 8);
      for (let index = 0; index < entries; index++) {
        const delta = at + 16 + index * 8;
        long.writeUInt32BE(long.readUInt32BE(delta) * factor, delta);
      }
      from = at + 4;
    }
    return long;
  };
  // A 90 s result is kept; one past the ten-minute limit is not.
  expect((await inspection.inspectVideoOriginal(stretched(60))).seconds).toBeCloseTo(90, 0);
  expect(inspection.VIDEO_ORIGINAL_SECONDS).toBe(600);
  await expect(
    inspection.inspectVideoOriginal(stretched(500)),
  ).rejects.toMatchObject({ code: "invalid_video" });
  /* The API-key collector (Genjutsu, Cinema Studio) inspects with this, not with the removed account code. */
  const collector = readFileSync("lib/genjutsuVideo.ts", "utf8");
  expect(collector).toContain('import { inspectVideoOriginal } from "./videoOriginal";');
  expect(collector).not.toContain("higgsfield-consumer");
});

test("a collected original stays an ordinary Library take, kept on its server-written receipt; a forged one is not", async () => {
  const m = await modules();
  const generation = await import("../../lib/jobs");
  await m.tenant.runInTenant(workspace(), async () => {
    const take = await collected(m);
    expect(await m.originals.hasRetainedConsumerOriginal(take.generationId)).toBe(true);
    expect((await m.quota.standing()).usedBytes).toBe(original.length);
    const gen = (await generation.getGeneration(take.generationId))!;
    expect(gen).toMatchObject({
      storedUrl: `/api/media/${take.generationId}`, costUsd: null, projectId: take.productionId,
      providerCreditQuote: { provider: "higgsfield", unit: "higgsfield_credits", credits: 75, basis: "approved_quote" },
    });
    /* No legacy paid intent is admitted for it, and nothing is read from a provider. */
    expect(await generation.syncGeneration(gen)).toBe(gen);
    const row = (await m.database.db().execute({ sql: "SELECT params FROM generations WHERE id=?", args: [take.generationId] })).rows[0];
    const forgedId = `gen-forged-${randomUUID()}`;
    await m.database.db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,created_by,created_at,updated_at,provider,kind) VALUES(?,'marketing_studio_video','',?,'succeeded',?,?,'owner',0,0,'higgsfield','video')",
      args: [forgedId, row.params, `/api/media/${forgedId}`, original.length],
    });
    expect(await m.originals.hasRetainedConsumerOriginal(forgedId)).toBe(false);
  });
});

test("an original whose ledger never completed stays protected from deletion; one the ledger completed can be deleted, its receipt kept", async () => {
  const m = await modules();
  const deletion = await import("../../lib/mediaDeletion");
  const { workbenchTransaction } = await import("../../lib/workbench/records");
  await m.tenant.runInTenant(workspace(), async () => {
    const realFetch = globalThis.fetch;
    let network = 0;
    globalThis.fetch = async () => { network++; throw new Error("No provider calls allowed"); };
    try {
      /* The old collector stored it, then the request died before the ledger's completion: nothing will finish it now. */
      const pending = await collected(m);
      expect((await m.jobs.getConsumerJob(pending.scope))?.status).toBe("accepted");
      await deletion.mediaDeletionReady();
      await expect(
        workbenchTransaction((tx) => deletion.markGenerationDeletion(tx, pending.generationId)),
      ).rejects.toThrow("still being finalized");
      const retained = (await m.database.db().execute({ sql: "SELECT deleted,bytes,stored_url FROM generations WHERE id=?", args: [pending.generationId] })).rows[0];
      expect(retained).toMatchObject({ deleted: 0, bytes: original.length, stored_url: m.storage.videoPath(pending.generationId) });
      expect((await m.storage.readVideoBytes(pending.generationId)).equals(original)).toBe(true);

      /* One whose completion the ledger did record deletes like any take; its receipt stays word for word. */
      const done = await collected(m, { completed: true });
      const manifest = (await m.jobs.getConsumerJob(done.scope))!.resultManifest;
      expect(manifest).toMatchObject({ original: { generationId: done.generationId, sha256: done.sha256, bytes: original.length } });
      expect((await m.quota.standing()).usedBytes).toBe(original.length * 2);
      await workbenchTransaction((tx) => deletion.markGenerationDeletion(tx, done.generationId));
      expect(await deletion.cleanupDeletedGenerations(1, Date.now(), done.generationId)).toMatchObject({ cleaned: 1, failed: 0 });
      expect((await m.quota.standing()).usedBytes).toBe(original.length);
      expect((await m.jobs.getConsumerJob(done.scope))!.resultManifest).toEqual(manifest);
      expect(network).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("ordinary deleted-workspace purge disposes a collected original after grace and lease expiry and resumes failed cleanup without provider calls", async () => {
  const m = await modules();
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { accountDbReady } = await import("../../lib/accountDb");
  const { markWorkspaceDeleted, purgeWorkspace, PURGE_GRACE_MS } =
    await import("../../lib/purge");
  await platformReady();
  await accountDbReady();
  const ws = workspace();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,0,0)",
    args: [ws.id, ws.slug, ws.name, ws.dbUrl, ws.ownerId],
  });
  await m.tenant.runInTenant(ws, async () => {
    const take = await collected(m),
      scope = take.scope;
    /* A status read the old collector had leased when it stopped. */
    await m.database.db().execute({
      sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_hash='abandoned',poll_lease_until=? WHERE id=?",
      args: [Date.now() + 180_000, take.jobId],
    });
    const receiptBefore = (
      await m.database
        .db()
        .execute({
          sql: "SELECT receipt_json FROM consumer_video_originals WHERE job_id=?",
          args: [take.jobId],
        })
    ).rows[0].receipt_json;
    await markWorkspaceDeleted(ws.id);
    const retry = () =>
      platformDb().execute({
        // Deleting no longer queues a purge (never-delete); the retired purge is driven directly.
        sql: "INSERT INTO workspace_purges(workspace_id,next_attempt_at,updated_at) VALUES(?,0,0) ON CONFLICT(workspace_id) DO UPDATE SET next_attempt_at=0",
        args: [ws.id],
      });
    await retry();
    expect((await purgeWorkspace(ws)).errors).toContain(
      "Consumer original disposal is waiting for the deletion grace period.",
    );
    expect((await m.jobs.getConsumerJob(scope))?.status).toBe("accepted");
    await platformDb().execute({
      sql: "UPDATE workspaces SET deleted_at=? WHERE id=?",
      args: [Date.now() - PURGE_GRACE_MS - 1, ws.id],
    });
    await retry();
    expect((await purgeWorkspace(ws)).errors).toContain(
      "Consumer original collection still has an active poll lease.",
    );
    expect((await m.jobs.getConsumerJob(scope))?.status).toBe("accepted");
    await m.database
      .db()
      .execute({
        sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=0 WHERE id=?",
        args: [take.jobId],
      });

    await m.database
      .db()
      .execute({
        sql: "UPDATE consumer_video_originals SET receipt_json='{}' WHERE job_id=?",
        args: [take.jobId],
      });
    await retry();
    expect((await purgeWorkspace(ws)).errors).toContain(
      "Consumer original disposal requires its verified immutable receipt.",
    );
    expect((await m.jobs.getConsumerJob(scope))?.status).toBe("accepted");
    await m.database
      .db()
      .execute({
        sql: "UPDATE consumer_video_originals SET receipt_json=? WHERE job_id=?",
        args: [receiptBefore, take.jobId],
      });

    const realFetch = globalThis.fetch;
    let networkCalls = 0,
      files = 0,
      databases = 0;
    globalThis.fetch = async () => {
      networkCalls++;
      throw new Error("No provider calls allowed");
    };
    try {
      await retry();
      const first = await purgeWorkspace(ws, {
        files: async () => {
          files++;
          throw new Error("Fixture private storage unavailable");
        },
        key: async () => {
          throw new Error("Unexpected key deletion");
        },
        database: async () => {
          databases++;
          throw new Error("Unexpected database deletion");
        },
      });
      expect(first).toMatchObject({
        completed: false,
        pending: true,
        dbDropped: false,
      });
      expect(files).toBe(1);
      expect(databases).toBe(0);
      const disposed = (await m.jobs.getConsumerJob(scope))!;
      expect(disposed).toMatchObject({
        status: "completed",
        failureCode: null,
        providerJobId: take.providerJobId,
        quoteCredits: 75,
      });
      expect(disposed.resultManifest).toMatchObject({
        disposal: {
          reason: "workspace_deleted",
          state: "purge_pending",
          attachable: false,
          workspaceId: ws.id,
          originalReceipt: {
            generationId: take.generationId,
            providerJobId: take.providerJobId,
            sha256: take.sha256,
            bytes: original.length,
            credits: 75,
            creditUnit: "higgsfield_credits",
          },
        },
      });
      expect(disposed.resultManifest).not.toHaveProperty("original");
      expect(disposed.resultManifest).not.toHaveProperty("asset");
      expect(
        (
          await m.database
            .db()
            .execute({
              sql: "SELECT receipt_json FROM consumer_video_originals WHERE job_id=?",
              args: [take.jobId],
            })
        ).rows[0].receipt_json,
      ).toBe(receiptBefore);
      expect(
        (await m.storage.readVideoBytes(take.generationId)).equals(
          original,
        ),
      ).toBe(true);
      expect((await m.quota.standing()).usedBytes).toBe(original.length);
      await retry();
      const second = await purgeWorkspace(ws, {
        files: async () => {
          files++;
          expect((await m.jobs.getConsumerJob(scope))?.resultManifest).toEqual(
            disposed.resultManifest,
          );
          await m.storage.deleteVideo(
            take.generationId,
            true,
            take.receipt.asset.url,
          );
          return { files: 1, uploads: 0 };
        },
        key: async () => {
          throw new Error("Unexpected key deletion");
        },
        database: async () => {
          databases++;
          throw new Error("Fixture database removal unavailable");
        },
      });
      expect(second).toMatchObject({
        completed: false,
        pending: true,
        dbDropped: false,
      });
      expect(files).toBe(2);
      expect(databases).toBe(1);
      expect((await m.jobs.getConsumerJob(scope))?.resultManifest).toEqual(
        disposed.resultManifest,
      );
      expect(
        (
          await m.database
            .db()
            .execute({
              sql: "SELECT receipt_json FROM consumer_video_originals WHERE job_id=?",
              args: [take.jobId],
            })
        ).rows[0].receipt_json,
      ).toBe(receiptBefore);
      await retry();
      expect((await purgeWorkspace(ws)).completed).toBe(true);
      expect((await purgeWorkspace(ws)).completed).toBe(true);
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("cleanup cannot remove an already marked pending original or let it starve unrelated deletions", async () => {
  const m = await modules();
  const deletion = await import("../../lib/mediaDeletion");
  await m.tenant.runInTenant(workspace(), async () => {
    const take = await collected(m);
    await deletion.mediaDeletionReady();
    // A previous deployment/manual tombstone must not bypass the cleanup guard.
    await m.database.db().execute({
      sql: "UPDATE generations SET deleted=1 WHERE id=?",
      args: [take.generationId],
    });
    const unrelated = `unrelated-${randomUUID()}`;
    await m.database.db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,deleted,created_at,updated_at) VALUES(?,'fixture','','{}','succeeded',?,1,1,0,1)",
      args: [unrelated, `/api/media/${unrelated}`],
    });
    expect(await deletion.cleanupDeletedGenerations(1)).toMatchObject({
      attempted: 1,
      cleaned: 1,
      failed: 0,
    });
    expect(
      (await m.storage.readVideoBytes(take.generationId)).equals(original),
    ).toBe(true);
    expect(
      (
        await m.database.db().execute({
          sql: "SELECT bytes FROM generations WHERE id=?",
          args: [take.generationId],
        })
      ).rows[0].bytes,
    ).toBe(original.length);
    expect(await deletion.cleanupDeletedGenerations(1)).toMatchObject({
      attempted: 0,
      cleaned: 0,
      failed: 0,
    });
  });
});

test("immutable storage refuses different bytes under the same deterministic generation path", async () => {
  const m = await modules();
  await m.tenant.runInTenant(workspace(), async () => {
    const id = `gen-original-${randomUUID()}`;
    saved.push(id);
    await m.storage.storeVideoBytes(id, original);
    await expect(
      m.storage.storeVideoBytes(
        id,
        Buffer.concat([original, Buffer.from([1])]),
      ),
    ).rejects.toThrow(/not overwritten/);
    expect((await m.storage.readVideoBytes(id)).equals(original)).toBe(true);
    await expect(
      m.storage.readVideoBytesLimited(id, original.length - 1),
    ).rejects.toThrow(/recorded length/);
  });
});
