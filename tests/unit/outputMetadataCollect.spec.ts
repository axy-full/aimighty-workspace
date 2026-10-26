import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { VideoJob } from "../../lib/submitVideo";
import { GENJUTSU_MODELS } from "../../lib/genjutsuTypes";
import { cleanOutputBytes } from "../../lib/storage/outputMetadata";

/*
 * The API-key video collection (lib/genjutsuVideo.ts) with the output-metadata
 * switch at marker and strip. Its receipt (sha256 and length of the original)
 * must describe the bytes actually stored, so a collection whose final write
 * was lost settles on the next poll from the stored object, instead of
 * refusing it as "Original changed" and leaving a paid render unsettled.
 * Mocked engine (ENGINE_MOCK=1), no network; the same scenario as
 * genjutsuLifecycle.spec.ts "collection crash after storage ...".
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-output-metadata-collect-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-output-metadata-collect";
const originalFetch = globalThis.fetch;
const previousMode = process.env.OUTPUT_METADATA;
const requestId = "5d1f1c0e-6a52-4c1b-9d55-2f7b9a0c4e11";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const actor = { user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin" as const, owner: true, disabled: false, createdAt: 0, lastSeen: null } };
const CLIP = readFileSync(path.resolve("public/fixtures/clip.mp4"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test.describe.configure({ mode: "serial" });
test.beforeEach(() => { process.env.ENGINE_MOCK = "1"; process.env.HF_CREDENTIALS = "fixture:key"; globalThis.fetch = async () => { throw new Error("External network forbidden"); }; });
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousMode === undefined) delete process.env.OUTPUT_METADATA; else process.env.OUTPUT_METADATA = previousMode;
});

function workspace(name: string): TenantWorkspace {
  return { id: name, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, name + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 20, rendersPerHour: 200, storageQuotaBytes: null, deletedAt: null };
}
async function job(id: string): Promise<VideoJob> {
  const { db, ready, now } = await import("../../lib/db"), { getModel } = await import("../../lib/models"), { getTask } = await import("../../lib/tasks"), { meter } = await import("../../lib/meter"), { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
  await ready(); await fundFixtureWorkspace(); const model = getModel(GENJUTSU_MODELS["motion-transfer"]);
  const params = { ratio: "adaptive", resolution: "720p", duration: 5, watermark: false, higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(), higgsfieldVendorCostUsd: 0.75, genjutsuSource: { width: 1280, height: 720, seconds: 5, firstTimestamp: 0 } };
  await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,provider,task,created_by,created_at,updated_at) VALUES(?,'video',?,'',?,'queued','higgsfield','genjutsu','owner',?,?)", args: [id, model.id, JSON.stringify(params), now(), now()] });
  await meter({ id, kind: "video", engine: "higgsfield", model: model.id, status: "running", engineCostUsd: .75 });
  const source = { id: "source", kind: "video" as const, mime: "video/mp4", ext: "mp4", storedUrl: "/api/uploads/source", role: "reference_video" as const };
  return { genId: id, model, task: getTask("genjutsu"), prompt: "", params, source, references: [source], ts: now() };
}

for (const mode of ["strip", "marker"] as const) {
  test(`${mode}: a collection whose final write was lost settles from the stored, rewritten original on the next poll`, async () => {
    process.env.OUTPUT_METADATA = mode;
    const { runInTenant } = await import("../../lib/tenant"), { db } = await import("../../lib/db"), { engineFor } = await import("../../lib/engines"),
      { submitVideoJob } = await import("../../lib/submitVideo"), { reconcileGenjutsuVideo } = await import("../../lib/genjutsuVideo"),
      { getGeneration } = await import("../../lib/jobs"), { readVideoBytes } = await import("../../lib/storage");
    const engine = engineFor("higgsfield"), render = engine.render, poll = engine.poll;
    const id = `gen_output_metadata_${mode}`;
    let polls = 0;
    engine.render = async (req) => ({ handle: { provider: "higgsfield", model: req.kind === "video" ? req.model.id : "", ref: requestId, endpoint: statusUrl, credentialFingerprint: req.kind === "video" ? req.params.higgsfieldCredentialFingerprint : undefined } });
    engine.poll = async () => { polls++; return { status: "succeeded", videoUrl: "fixture:clip.mp4", totalTokens: null, error: null, vendorStartedAt: null, vendorEndedAt: null, raw: {} }; };
    const expected = cleanOutputBytes(CLIP, mode, "mp4");
    try {
      await runInTenant(workspace(`output_metadata_${mode}`), async () => {
        await submitVideoJob(await job(id));
        // The original is stored, then the outcome write fails: the take stays running with its receipt.
        const client = db(), batch = client.batch.bind(client);
        client.batch = async (...args: Parameters<typeof client.batch>) => {
          if (JSON.stringify(args).includes("status='succeeded',stored_url")) throw new Error("DB unavailable after private store");
          return batch(...args);
        };
        try { await expect(reconcileGenjutsuVideo(id)).rejects.toThrow(/retained/); } finally { client.batch = batch; }
        const reserved = (await db().execute({ sql: "SELECT bytes,params FROM generations WHERE id=?", args: [id] })).rows[0];
        const receipt = JSON.parse(String(reserved.params)).genjutsuOriginal;
        // Receipt, quota figure and stored object are the same, rewritten bytes.
        const stored = await readVideoBytes(id);
        expect(stored.equals(expected)).toBe(true);
        expect(receipt.sha256).toBe(sha(expected));
        expect(receipt.bytes).toBe(expected.length);
        expect(Number(reserved.bytes)).toBe(expected.length);
        expect(stored.includes(Buffer.from("Big Buck Bunny"))).toBe(false);
        // Next poll: the stored object matches the receipt; it settles without asking the provider again.
        await reconcileGenjutsuVideo(id);
        expect(polls).toBe(1);
        expect((await getGeneration(id))?.status).toBe("succeeded");
        // And once more: nothing changes.
        await reconcileGenjutsuVideo(id);
        expect((await getGeneration(id))?.status).toBe("succeeded");
        expect((await readVideoBytes(id)).equals(expected)).toBe(true);
        expect(Number((await db().execute({ sql: "SELECT bytes FROM generations WHERE id=?", args: [id] })).rows[0].bytes)).toBe(expected.length);
      }, actor);
    } finally {
      engine.render = render; engine.poll = poll;
      await unlink(path.resolve(".data/generations", id + ".mp4")).catch(() => {});
    }
  });
}
