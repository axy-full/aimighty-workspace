import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ProductFetchDependencies } from "../../lib/workbench/product-fetch";
import { parseConsumerVideoInput } from "../../lib/higgsfield-consumer/video-contract";

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
async function accepted(m: Awaited<ReturnType<typeof modules>>, mapped = true, variant?: 'motion-transfer' | 'object-swap') {
  await m.database.ready();
  const draftId = `draft-${randomUUID()}`,
    productionId = `project-${randomUUID()}`;
  if (mapped)
    await m.database.db().execute({
      sql: "INSERT INTO projects(id,name,created_at) VALUES(?,'Fixture',0)",
      args: [productionId],
    });
  await m.database.db().execute({
    sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,'owner',?,'Fixture',?,1,0)",
    args: [
      draftId,
      draftId,
      JSON.stringify({
        productionProjectId: mapped ? productionId : undefined,
      }),
    ],
  });
  if (variant) for (const [id, kind, ext] of [['original-motion', 'video', 'mp4'], ['original-look', 'image', 'png']] as const)
    await m.database.db().execute({ sql: 'INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES(?,?,?,?,100,?,?,?,0)', args: [id, `${id}.${ext}`, `${kind}/${ext}`, ext, 'fixture-hash', `/api/uploads/${id}`, kind] });
  const { job } = await m.jobs.createConsumerJob({
    userId: "owner",
    draftId,
    connectedOwnerId: "owner",
    connectionGeneration: randomUUID(),
    workflow: variant ? "genjutsu" : "marketing-video",
    idempotencyKey: randomUUID(),
    payload: variant ? { input: { variant, resolution: '1080p', prompt: 'Keep the camera movement; restage the world.', source: { uploadId: 'original-motion' }, references: [{ uploadId: 'original-look' }] }, params: { model: variant === 'motion-transfer' ? 'hf_mult_motion_control' : 'hf_mult_replace_object' } } : {
      input: {
        ...parseConsumerVideoInput({
          prompt: "A plain bottle.",
          duration: 15,
          resolution: "720p",
          aspectRatio: "16:9",
          generateAudio: true,
        }),
      },
    },
    quoteCredits: 75,
    quoteExpiresAt: Date.now() + 60_000,
    originalAssetIds: variant ? ['upload:original-motion', 'upload:original-look'] : [],
  });
  const scope = { id: job.id, userId: job.userId, draftId };
  const claim = await m.jobs.claimConsumerDispatch(scope);
  const result = (await m.jobs.markConsumerAccepted({
    ...scope,
    claimToken: claim!.claimToken,
    providerJobId: randomUUID(),
  }))!;
  saved.push(
    m.originals.consumerOriginalGenerationId(
      m.tenant.requireTenant().id,
      result.id,
    ),
  );
  return { job: result, productionId };
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
  const { originals } = await modules();
  expect(await originals.inspectConsumerVideoOriginal(original)).toEqual({
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
      originals.inspectConsumerVideoOriginal(bytes),
    ).rejects.toMatchObject({ code: "invalid_video" });
  const long = Buffer.from(original);
  for (let from = 0; ;) {
    const at = long.indexOf("stts", from);
    if (at < 0) break;
    const entries = long.readUInt32BE(at + 8);
    for (let index = 0; index < entries; index++) {
      const delta = at + 16 + index * 8;
      long.writeUInt32BE(long.readUInt32BE(delta) * 60, delta);
    }
    from = at + 4;
  }
  await expect(
    originals.inspectConsumerVideoOriginal(long),
  ).rejects.toMatchObject({ code: "invalid_video" });
});

test("collection preserves original bytes, records exact consumer credits and exposes one authenticated library generation", async () => {
  const m = await modules();
  await m.tenant.runInTenant(workspace(), async () => {
    const { job, productionId } = await accepted(m),
      f = transport();
    const result = await m.originals.collectConsumerVideoOriginal(
      job,
      sourceUrl,
      { fetchDependencies: f.deps },
    );
    expect(result).toMatchObject({
      providerJobId: job.providerJobId,
      bytes: original.length,
      sha256: createHash("sha256").update(original).digest("hex"),
      credits: 75,
      creditUnit: "higgsfield_credits",
      width: 720,
      height: 1280,
      seconds: 1.5,
    });
    expect(
      (await m.storage.readVideoBytes(result.generationId)).equals(original),
    ).toBe(true);
    const row = (
      await m.database.db().execute({
        sql: "SELECT * FROM generations WHERE id=?",
        args: [result.generationId],
      })
    ).rows[0];
    expect(row).toMatchObject({
      project_id: productionId,
      provider: "higgsfield",
      model: "marketing_studio_video",
      cost_usd: null,
      status: "succeeded",
      bytes: original.length,
      created_by: "owner",
    });
    expect(JSON.parse(String(row.params))).toMatchObject({
      consumerJobId: job.id,
      ratio: "16:9",
      aspectRatio: "16:9",
      consumerCredits: 75,
      consumerCreditUnit: "higgsfield_credits",
      originalSha256: result.sha256,
    });
    expect(await m.uploads.reservedUploadBytes()).toBe(0);
    expect((await m.quota.standing()).usedBytes).toBe(original.length);
    const generation = await import("../../lib/jobs");
    const gen = await generation.getGeneration(result.generationId);
    expect(gen?.storedUrl).toBe(`/api/media/${result.generationId}`);
    expect(gen?.costUsd).toBeNull();
    expect(
      await m.originals.hasRetainedConsumerOriginal(result.generationId),
    ).toBe(true);
    const forgedId = `gen-forged-${randomUUID()}`;
    await m.database.db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,stored_url,bytes,created_by,created_at,updated_at,provider,kind) VALUES(?,'marketing_studio_video','',?,'succeeded',?,?,'owner',0,0,'higgsfield','video')",
      args: [forgedId, row.params, `/api/media/${forgedId}`, original.length],
    });
    expect(await m.originals.hasRetainedConsumerOriginal(forgedId)).toBe(false);
    await m.database
      .db()
      .execute({ sql: "DELETE FROM generations WHERE id=?", args: [forgedId] });
    // This completed consumer original is not a legacy paid job; no legacy intent is admitted.
    expect(await generation.syncGeneration(gen!)).toBe(gen);
    const replay = await m.originals.collectConsumerVideoOriginal(
      job,
      sourceUrl,
      { fetchDependencies: transport([]).deps },
    );
    expect(replay).toEqual(result);
    expect(
      (await m.database.db().execute("SELECT COUNT(*) AS n FROM generations"))
        .rows[0].n,
    ).toBe(1);
  });
});

test("completed original availability fails closed on missing or mismatched tenant records without rewriting its receipt", async () => {
  const m = await modules(), videoService = await import("../../lib/higgsfield-consumer/video-service");
  let completed!: NonNullable<Awaited<ReturnType<typeof m.jobs.getConsumerJob>>>;
  await m.tenant.runInTenant(workspace(), async () => {
    const { job } = await accepted(m), scope = { id: job.id, userId: job.userId, draftId: job.draftId };
    const collected = await m.originals.collectConsumerVideoOriginal(job, sourceUrl, { fetchDependencies: transport().deps });
    const poll = (await m.jobs.claimConsumerPoll(scope))!;
    completed = (await m.jobs.completeConsumerJob({ ...scope, leaseToken: poll.leaseToken, resultManifest: { original: collected } }))!;
    expect(await videoService.consumerVideoView(completed)).toMatchObject({ originalAvailable: true, originalAvailability: "available" });
    const originalRow = (await m.database.db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [collected.generationId] })).rows[0];
    for (const [column, value] of [["stored_url", null], ["bytes", 1], ["created_by", "another-owner"], ["params", JSON.stringify({ consumerJobId: "another-job" })]] as const) {
      await m.database.db().execute({ sql: `UPDATE generations SET ${column}=? WHERE id=?`, args: [value, collected.generationId] });
      const view = await videoService.consumerVideoView(completed);
      expect(view).toMatchObject({ originalAvailable: false, originalAvailability: "unavailable" });
      expect(view.result!.original).not.toHaveProperty("asset");
      await m.database.db().execute({ sql: `UPDATE generations SET ${column}=? WHERE id=?`, args: [originalRow[column], collected.generationId] });
    }
    await m.database.db().execute({ sql: "DELETE FROM consumer_video_originals WHERE job_id=?", args: [job.id] });
    expect(await videoService.consumerVideoView(completed)).toMatchObject({ originalAvailable: false, originalAvailability: "unavailable" });
    expect((await m.jobs.getConsumerJob(scope))!.resultManifest).toEqual(completed.resultManifest);
  });
  await m.tenant.runInTenant(workspace(), async () => {
    await m.database.ready();
    expect(await videoService.consumerVideoView(completed)).toMatchObject({ originalAvailable: false, originalAvailability: "unavailable" });
  });
});

test("both consumer Genjutsu modes retain original bindings, their own credit unit and a deletion guard until completion", async () => {
  const m = await modules(), generation = await import('../../lib/jobs');
  const availability = await import('../../lib/higgsfield-consumer/video-availability');
  const retention = await import('../../lib/higgsfield-consumer/original-retention');
  for (const variant of ['motion-transfer', 'object-swap'] as const) await m.tenant.runInTenant(workspace(), async () => {
    const { job, productionId } = await accepted(m, true, variant);
    const collected = await m.originals.collectConsumerVideoOriginal(job, sourceUrl, { fetchDependencies: transport().deps });
    const gen = (await generation.getGeneration(collected.generationId))!;
    expect(gen).toMatchObject({ model: variant === 'motion-transfer' ? 'hf_mult_motion_control' : 'hf_mult_replace_object', projectId: productionId, costUsd: null,
      providerCreditQuote: { provider: 'higgsfield', unit: 'higgsfield_credits', credits: 75, basis: 'approved_quote' },
      params: { task: 'genjutsu', workbenchProjectId: job.draftId, sourceUploadId: 'original-motion', resolution: '1080p', references: [{ uploadId: 'original-look', role: 'reference_image' }] } });
    expect(await generation.syncGeneration(gen)).toBe(gen);
    expect(await retention.consumerOriginalPending(m.database.db(), gen.id)).toBe(true);
    const scope = { id: job.id, userId: job.userId, draftId: job.draftId }, poll = (await m.jobs.claimConsumerPoll(scope))!;
    const completed = (await m.jobs.completeConsumerJob({ ...scope, leaseToken: poll.leaseToken, resultManifest: { original: collected } }))!;
    expect((await availability.consumerOriginalAvailability([completed])).get(job.id)).toBe('available');
    expect(await retention.consumerOriginalPending(m.database.db(), gen.id)).toBe(false);
    await m.database.db().execute({ sql: "UPDATE generations SET model='marketing_studio_video' WHERE id=?", args: [gen.id] });
    expect((await availability.consumerOriginalAvailability([completed])).get(job.id)).toBe('unavailable');
    await expect(m.originals.collectConsumerVideoOriginal(completed, sourceUrl, { fetchDependencies: transport([]).deps })).rejects.toMatchObject({ code: 'conflict' });
  });
});

test("collector leases exclude concurrent writers and durable reservations compete atomically with uploads", async () => {
  const m = await modules();
  await m.tenant.runInTenant(workspace(original.length + 1), async () => {
    const { job } = await accepted(m),
      f = transport();
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    const first = m.originals.collectConsumerVideoOriginal(job, sourceUrl, {
      fetchDependencies: f.deps,
      store: async (id, bytes) => {
        started();
        await gate;
        return m.storage.storeVideoBytes(id, bytes);
      },
    });
    await entered;
    expect(await m.uploads.reservedUploadBytes()).toBe(original.length);
    await expect(
      m.originals.collectConsumerVideoOriginal(job, sourceUrl, {
        fetchDependencies: f.deps,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    await expect(
      m.uploads.reserveUploadChunk({
        owner: "owner",
        session: randomUUID(),
        index: 0,
        bytes: 2,
        sha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 507 });
    release();
    await first;
    expect(f.calls).toHaveLength(1);
    expect(await m.uploads.reservedUploadBytes()).toBe(0);
  });
});

test("lost storage acknowledgements recover the same private original after lease expiry without downloading again", async () => {
  const m = await modules();
  await m.tenant.runInTenant(workspace(), async () => {
    const { job } = await accepted(m);
    await expect(
      m.originals.collectConsumerVideoOriginal(job, sourceUrl, {
        fetchDependencies: transport().deps,
        store: async (id, bytes) => {
          await m.storage.storeVideoBytes(id, bytes);
          throw new Error("Lost storage acknowledgement");
        },
      }),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(await m.uploads.reservedUploadBytes()).toBe(original.length);
    await m.database
      .db()
      .execute("UPDATE consumer_video_originals SET lease_until=0");
    const noNetwork = transport([]);
    const result = await m.originals.collectConsumerVideoOriginal(
      job,
      sourceUrl,
      { fetchDependencies: noNetwork.deps },
    );
    expect(noNetwork.calls).toHaveLength(0);
    expect(
      (await m.storage.readVideoBytes(result.generationId)).equals(original),
    ).toBe(true);
    expect(await m.uploads.reservedUploadBytes()).toBe(0);
  });
});

test("changed original hashes, stale collector leases and unrelated generations cannot overwrite an accepted artifact", async () => {
  const m = await modules();
  await m.tenant.runInTenant(workspace(), async () => {
    const { job } = await accepted(m);
    await expect(
      m.originals.collectConsumerVideoOriginal(job, sourceUrl, {
        fetchDependencies: transport().deps,
        store: async () => {
          throw new Error("Fixture storage outage");
        },
      }),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    await m.database
      .db()
      .execute("UPDATE consumer_video_originals SET lease_until=0");
    await expect(
      m.originals.collectConsumerVideoOriginal(job, sourceUrl, {
        fetchDependencies: transport([
          { bytes: Buffer.concat([original, Buffer.from([0])]) },
        ]).deps,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await m.uploads.reservedUploadBytes()).toBe(original.length);
    await m.database
      .db()
      .execute("UPDATE consumer_video_originals SET lease_until=0");
    await expect(
      m.originals.collectConsumerVideoOriginal(job, sourceUrl, {
        fetchDependencies: transport().deps,
        store: async (id, bytes) => {
          const stored = await m.storage.storeVideoBytes(id, bytes);
          await m.database
            .db()
            .execute(
              "UPDATE consumer_video_originals SET lease='newer-collector',lease_until=9999999999999",
            );
          return stored;
        },
      }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(
      (await m.database.db().execute("SELECT COUNT(*) AS n FROM generations"))
        .rows[0].n,
    ).toBe(0);
    expect(await m.uploads.reservedUploadBytes()).toBe(original.length);
    const other = await accepted(m);
    const id = m.originals.consumerOriginalGenerationId(
      m.tenant.requireTenant().id,
      other.job.id,
    );
    await m.database.db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at) VALUES(?,'other','', '{}','succeeded',0,0)",
      args: [id],
    });
    const noFetch = transport([]);
    await expect(
      m.originals.collectConsumerVideoOriginal(other.job, sourceUrl, {
        fetchDependencies: noFetch.deps,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(noFetch.calls).toHaveLength(0);
  });
});

test("deleted drafts collect without project attachment; deleted originals never resurrect; tenant-spoofed jobs refuse", async () => {
  const m = await modules();
  let foreign!: Awaited<ReturnType<typeof accepted>>["job"];
  await m.tenant.runInTenant(workspace(), async () => {
    const { job } = await accepted(m);
    foreign = job;
    await m.database.db().execute("DELETE FROM workbench_projects");
    const result = await m.originals.collectConsumerVideoOriginal(
      job,
      sourceUrl,
      { fetchDependencies: transport().deps },
    );
    expect(
      (
        await m.database.db().execute({
          sql: "SELECT project_id FROM generations WHERE id=?",
          args: [result.generationId],
        })
      ).rows[0].project_id,
    ).toBeNull();
    await m.database.db().execute({
      sql: "UPDATE generations SET deleted=1 WHERE id=?",
      args: [result.generationId],
    });
    const noFetch = transport([]);
    await expect(
      m.originals.collectConsumerVideoOriginal(job, sourceUrl, {
        fetchDependencies: noFetch.deps,
      }),
    ).rejects.toMatchObject({ code: "deleted" });
    expect(noFetch.calls).toHaveLength(0);
  });
  await m.tenant.runInTenant(workspace(), async () => {
    const noFetch = transport([]);
    await expect(
      m.originals.collectConsumerVideoOriginal(foreign, sourceUrl, {
        fetchDependencies: noFetch.deps,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(noFetch.calls).toHaveLength(0);
    expect(
      (await m.database.db().execute("SELECT COUNT(*) AS n FROM generations"))
        .rows[0].n,
    ).toBe(0);
  });
});

test("a crash after collection protects the original from deletion until a fresh poll finalizes the ledger", async () => {
  const m = await modules();
  const deletion = await import("../../lib/mediaDeletion");
  const { workbenchTransaction } = await import("../../lib/workbench/records");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { accountDbReady } = await import("../../lib/accountDb");
  await platformReady();
  await accountDbReady();
  const ws = workspace();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,0,0)",
    args: [ws.id, ws.slug, ws.name, ws.dbUrl, ws.ownerId],
  });
  await m.tenant.runInTenant(ws, async () => {
    const { job } = await accepted(m);
    const scope = { id: job.id, userId: job.userId, draftId: job.draftId };
    const abandoned = (await m.jobs.claimConsumerPoll(scope))!;
    const collected = await m.originals.collectConsumerVideoOriginal(
      job,
      sourceUrl,
      { fetchDependencies: transport().deps },
    );
    // Simulate the request dying after the original commits but before ledger completion.
    expect((await m.jobs.getConsumerJob(scope))?.status).toBe("accepted");
    await deletion.mediaDeletionReady();
    await expect(
      workbenchTransaction((tx) =>
        deletion.markGenerationDeletion(tx, collected.generationId),
      ),
    ).rejects.toThrow("still being finalized");
    const retained = (
      await m.database.db().execute({
        sql: "SELECT deleted,bytes,stored_url FROM generations WHERE id=?",
        args: [collected.generationId],
      })
    ).rows[0];
    expect(retained).toMatchObject({
      deleted: 0,
      bytes: original.length,
      stored_url: collected.asset.url,
    });
    expect((await m.quota.standing()).usedBytes).toBe(original.length);
    expect(
      (await m.storage.readVideoBytes(collected.generationId)).equals(original),
    ).toBe(true);

    await m.database.db().execute({
      sql: "UPDATE higgsfield_consumer_jobs SET poll_lease_until=0 WHERE id=?",
      args: [job.id],
    });
    expect(
      await m.jobs.completeConsumerJob({
        ...scope,
        leaseToken: abandoned.leaseToken,
        resultManifest: { original: collected },
      }),
    ).toBeNull();
    const fresh = (await m.jobs.claimConsumerPoll(scope))!;
    const noNetwork = transport([]);
    const replay = await m.originals.collectConsumerVideoOriginal(
      fresh.job,
      sourceUrl,
      { fetchDependencies: noNetwork.deps },
    );
    expect(replay).toEqual(collected);
    expect(noNetwork.calls).toHaveLength(0);
    expect(
      (
        await m.jobs.completeConsumerJob({
          ...scope,
          leaseToken: fresh.leaseToken,
          resultManifest: { original: replay },
        })
      )?.status,
    ).toBe("completed");

    const videoService = await import("../../lib/higgsfield-consumer/video-service");
    const beforeDeletion = await videoService.pollConsumerMarketingVideo(scope);
    expect(beforeDeletion.job).toMatchObject({ originalAvailability: "available", originalAvailable: true, result: { original: collected } });
    const immutableManifest = (await m.jobs.getConsumerJob(scope))!.resultManifest;
    await workbenchTransaction((tx) =>
      deletion.markGenerationDeletion(tx, collected.generationId),
    );
    expect(
      await deletion.cleanupDeletedGenerations(
        1,
        Date.now(),
        collected.generationId,
      ),
    ).toMatchObject({ cleaned: 1, failed: 0 });
    expect((await m.quota.standing()).usedBytes).toBe(0);
    for (const view of [(await videoService.pollConsumerMarketingVideo(scope)).job,
      ...(await videoService.consumerMarketingJobs(job.userId, job.draftId))]) {
      expect(view).toMatchObject({ status: "completed", originalAvailability: "deleted", originalAvailable: false,
        result: { original: { generationId: collected.generationId, sha256: collected.sha256, bytes: collected.bytes } } });
      expect(view.result!.original).not.toHaveProperty("asset");
    }
    expect((await m.jobs.getConsumerJob(scope))!.resultManifest).toEqual(immutableManifest);
    await expect(
      m.originals.collectConsumerVideoOriginal(fresh.job, sourceUrl, {
        fetchDependencies: noNetwork.deps,
      }),
    ).rejects.toMatchObject({ code: "deleted" });
    expect(noNetwork.calls).toHaveLength(0);
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
    const { job } = await accepted(m),
      scope = { id: job.id, userId: job.userId, draftId: job.draftId };
    const abandoned = (await m.jobs.claimConsumerPoll(scope))!;
    const f = transport();
    const collected = await m.originals.collectConsumerVideoOriginal(
      job,
      sourceUrl,
      { fetchDependencies: f.deps },
    );
    const receiptBefore = (
      await m.database
        .db()
        .execute({
          sql: "SELECT receipt_json FROM consumer_video_originals WHERE job_id=?",
          args: [job.id],
        })
    ).rows[0].receipt_json;
    await markWorkspaceDeleted(ws.id);
    const retry = () =>
      platformDb().execute({
        sql: "UPDATE workspace_purges SET next_attempt_at=0 WHERE workspace_id=?",
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
        args: [job.id],
      });

    await m.database
      .db()
      .execute({
        sql: "UPDATE consumer_video_originals SET receipt_json='{}' WHERE job_id=?",
        args: [job.id],
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
        args: [receiptBefore, job.id],
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
        providerJobId: job.providerJobId,
        quoteCredits: 75,
      });
      expect(disposed.resultManifest).toMatchObject({
        disposal: {
          reason: "workspace_deleted",
          state: "purge_pending",
          attachable: false,
          workspaceId: ws.id,
          originalReceipt: {
            generationId: collected.generationId,
            providerJobId: job.providerJobId,
            sha256: collected.sha256,
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
              args: [job.id],
            })
        ).rows[0].receipt_json,
      ).toBe(receiptBefore);
      expect(
        (await m.storage.readVideoBytes(collected.generationId)).equals(
          original,
        ),
      ).toBe(true);
      expect((await m.quota.standing()).usedBytes).toBe(original.length);
      expect(
        await m.jobs.completeConsumerJob({
          ...scope,
          leaseToken: abandoned.leaseToken,
          resultManifest: { original: collected },
        }),
      ).toBeNull();
      await retry();
      const second = await purgeWorkspace(ws, {
        files: async () => {
          files++;
          expect((await m.jobs.getConsumerJob(scope))?.resultManifest).toEqual(
            disposed.resultManifest,
          );
          await m.storage.deleteVideo(
            collected.generationId,
            true,
            collected.asset.url,
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
              args: [job.id],
            })
        ).rows[0].receipt_json,
      ).toBe(receiptBefore);
      await retry();
      expect((await purgeWorkspace(ws)).completed).toBe(true);
      expect((await purgeWorkspace(ws)).completed).toBe(true);
      expect(networkCalls).toBe(0);
      expect(f.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("cleanup cannot remove an already marked pending original or let it starve unrelated deletions", async () => {
  const m = await modules();
  const deletion = await import("../../lib/mediaDeletion");
  await m.tenant.runInTenant(workspace(), async () => {
    const { job } = await accepted(m);
    const collected = await m.originals.collectConsumerVideoOriginal(
      job,
      sourceUrl,
      { fetchDependencies: transport().deps },
    );
    await deletion.mediaDeletionReady();
    // A previous deployment/manual tombstone must not bypass the cleanup guard.
    await m.database.db().execute({
      sql: "UPDATE generations SET deleted=1 WHERE id=?",
      args: [collected.generationId],
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
      (await m.storage.readVideoBytes(collected.generationId)).equals(original),
    ).toBe(true);
    expect(
      (
        await m.database.db().execute({
          sql: "SELECT bytes FROM generations WHERE id=?",
          args: [collected.generationId],
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
