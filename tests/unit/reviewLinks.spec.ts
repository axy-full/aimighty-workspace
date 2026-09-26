import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { currentTenant, runInTenant, type TenantWorkspace } from "../../lib/tenant";
import { byteRange } from "../../lib/mediaRange";
import { originalKindOf, originalMediaOf } from "../../lib/originalMedia";
import { loadIsolated } from "./storageSeam";

/* Client review links (brief 2.6): the page a studio sends its clients. */

const dir = mkdtempSync(path.join(tmpdir(), "particl-review-links-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const original = readFileSync(path.resolve("tests/fixtures/astra-source.mp4"));
const workspace = { id: "review-studio", legacy: false } as TenantWorkspace;

/** The review media route over a fake private store that honours Range the way Blob does, or over local disk. */
async function reviewRoute(row: { kind: string; params?: string; bytes?: number | null }, calls: string[] = [], local = false) {
  const storage = local
    ? loadIsolated<typeof import("../../lib/storage")>("lib/storage.ts", { "./tenant": { currentTenant } }, {
        process: { ...process, env: { ...process.env, BLOB_READ_WRITE_TOKEN: "", STORAGE_BACKEND: "local" } },
      })
    : loadIsolated<typeof import("../../lib/storage")>("lib/storage.ts", {
    "./tenant": { currentTenant },
    "@vercel/blob": {
      head: async (name: string) => {
        calls.push(`head ${name}`);
        return { size: original.length };
      },
      get: async (name: string, options: { headers?: Record<string, string> }) => {
        calls.push(`get ${name}`);
        const m = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? "");
        const [start, end] = m ? [Number(m[1]), Number(m[2])] : [0, original.length - 1];
        const body = original.subarray(start, end + 1);
        const headers = new Headers({ "content-length": String(body.length) });
        if (m) headers.set("content-range", `bytes ${start}-${end}/${original.length}`);
        return {
          headers,
          statusCode: m ? 206 : 200,
          blob: { size: body.length },
          stream: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(body)); c.close(); } }),
        };
      },
    },
  }, { process: { ...process, env: { ...process.env, BLOB_READ_WRITE_TOKEN: "isolated-sdk-fixture-no-network" } } });
  return loadIsolated<typeof import("../../app/api/review/[token]/media/[genId]/route")>(
    "app/api/review/[token]/media/[genId]/route.ts",
    {
      "@/lib/tenant": { runInTenant },
      "@/lib/shares": { resolveShare: async () => ({ share: { projectId: "p1" }, workspace }) },
      "@/lib/db": { ready: async () => {}, db: () => ({ execute: async () => ({ rows: [row] }) }) },
      "@/lib/storage": storage,
      "@/lib/originalMedia": { originalMediaOf },
      "@/lib/mediaRange": { byteRange },
      "@/lib/downloadName": { downloadFilename: async (_id: string, ext: string) => `SH030_v2.${ext}` },
      "@/lib/contentDisposition": await import("../../lib/contentDisposition"),
    },
  );
}
const ctx = { params: Promise.resolve({ token: "t".repeat(32), genId: "gen_1" }) };

test("on local disk the review link answers ranges the same way", async () => {
  const genId = `rv${Date.now().toString(36)}`;
  const file = path.join(process.cwd(), ".data", "generations", `${genId}.mp4`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, original);
  try {
    const route = await reviewRoute({ kind: "video", params: "{}" }, [], true);
    const local = { params: Promise.resolve({ token: "t".repeat(32), genId }) };
    const tail = await route.GET(new Request("https://studio.test/x", { headers: { range: "bytes=-16" } }), local);
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes ${original.length - 16}-${original.length - 1}/${original.length}`);
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(original.subarray(original.length - 16));
    const whole = await route.GET(new Request("https://studio.test/x"), local);
    expect(whole.headers.get("content-length")).toBe(String(original.length));
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(original);
    const missing = await route.GET(new Request("https://studio.test/x"), { params: Promise.resolve({ token: "t".repeat(32), genId: `${genId}-none` }) });
    expect(missing.status).toBe(404);
  } finally {
    rmSync(file, { force: true });
  }
});

test("a review link answers byte ranges with 206, so an approved video plays on iPhone Safari", async () => {
  const calls: string[] = [];
  const route = await reviewRoute({ kind: "video", params: "{}" }, calls);
  const probe = await route.GET(new Request("https://studio.test/x", { headers: { range: "bytes=0-1" } }), ctx);
  expect(probe.status).toBe(206);
  expect(probe.headers.get("content-range")).toBe(`bytes 0-1/${original.length}`);
  expect(probe.headers.get("content-length")).toBe("2");
  expect(probe.headers.get("accept-ranges")).toBe("bytes");
  expect(probe.headers.get("content-type")).toBe("video/mp4");
  expect(Buffer.from(await probe.arrayBuffer())).toEqual(original.subarray(0, 2));

  const whole = await route.GET(new Request("https://studio.test/x"), ctx);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-length")).toBe(String(original.length));
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(Buffer.from(await whole.arrayBuffer())).toEqual(original);

  const past = await route.GET(new Request("https://studio.test/x", { headers: { range: `bytes=${original.length + 10}-` } }), ctx);
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe(`bytes */${original.length}`);

  expect(calls.every((call) => call.endsWith("ws/review-studio/generations/gen_1.mp4"))).toBe(true);
});

test("the size recorded with the take answers each range without a storage probe; a stale one is corrected", async () => {
  const calls: string[] = [];
  const recorded = await reviewRoute({ kind: "video", params: "{}", bytes: original.length }, calls);
  for (const range of ["bytes=0-1", "bytes=100-199", "bytes=-16"]) {
    const part = await recorded.GET(new Request("https://studio.test/x", { headers: { range } }), ctx);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toMatch(new RegExp(`/${original.length}$`));
  }
  expect(calls.filter((call) => call.startsWith("head"))).toEqual([]);

  // The row is wrong: storage's own length wins, never a broken answer.
  for (const bytes of [original.length - 5, original.length + 5000]) {
    calls.length = 0;
    const stale = await reviewRoute({ kind: "video", params: "{}", bytes }, calls);
    const tail = await stale.GET(new Request("https://studio.test/x", { headers: { range: `bytes=${original.length - 4}-` } }), ctx);
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes ${original.length - 4}-${original.length - 1}/${original.length}`);
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(original.subarray(original.length - 4));
    expect(calls.filter((call) => call.startsWith("head"))).toHaveLength(1);
  }
});

test("a review link reads each kind from its own object and serves it as its own type", async () => {
  const calls: string[] = [];
  const model = await reviewRoute({ kind: "model", params: "{}" }, calls);
  const glb = await model.GET(new Request("https://studio.test/x"), ctx);
  expect(glb.status).toBe(200);
  expect(glb.headers.get("content-type")).toBe("model/gltf-binary");
  expect(glb.headers.get("content-disposition")).toContain("SH030_v2.glb");
  expect(calls.at(-1)).toBe("get ws/review-studio/generations/gen_1.glb");

  const jpeg = await (await reviewRoute({ kind: "image", params: JSON.stringify({ consumerOriginalMime: "image/jpeg" }) }))
    .GET(new Request("https://studio.test/x"), ctx);
  expect(jpeg.headers.get("content-type")).toBe("image/jpeg");

  expect(originalMediaOf({ kind: "audio", params: JSON.stringify({ consumerOriginalMime: "audio/wav" }) })).toEqual({ kind: "audio", contentType: "audio/wav", ext: "wav" });
  expect(originalMediaOf({ kind: "image", params: { consumerOriginalMime: "image/webp" } })).toEqual({ kind: "image", contentType: "image/webp", ext: "webp" });
  expect(originalMediaOf({ kind: "model", params: "{}" })).toEqual({ kind: "model", contentType: "model/gltf-binary", ext: "glb" });
  expect(originalMediaOf({ kind: "model", params: JSON.stringify({ consumerOriginalMime: "application/zip" }) }).ext).toBe("zip");
  // A declared type outside the kind's allowlist is not believed.
  expect(originalMediaOf({ kind: "image", params: JSON.stringify({ consumerOriginalMime: "text/html" }) })).toEqual({ kind: "image", contentType: "image/png", ext: "png" });
  expect(originalMediaOf({ kind: "video", params: "not json" })).toEqual({ kind: "video", contentType: "video/mp4", ext: "mp4" });
  expect([originalKindOf("audio"), originalKindOf("model"), originalKindOf("training")]).toEqual(["audio", "model", "video"]);
});

test("deleting a workspace ends its review links at once, and a link on an already-deleted workspace opens nothing", async () => {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { mintShare, resolveShare } = await import("../../lib/shares");
  const { markWorkspaceDeleted } = await import("../../lib/purge");
  await platformReady();
  const p = platformDb();
  for (const id of ["review-gone", "review-old"])
    await p.execute({
      sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES(?,?,?,?,'owner',0,0)`,
      args: [id, id, "Customer", `file:${path.join(dir, id + ".db")}`],
    });

  const { token, share } = await mintShare({ workspaceId: "review-gone", projectId: "p1", by: "owner" });
  expect((await resolveShare(token))?.share.id).toBe(share.id);
  await markWorkspaceDeleted("review-gone");
  expect(await resolveShare(token)).toBeNull();
  const row = (await p.execute({ sql: `SELECT revoked_at FROM p_shares WHERE id=?`, args: [share.id] })).rows[0];
  expect(row.revoked_at).not.toBeNull();

  // Deleted before links were revoked with it: the workspace's own state decides.
  const older = await mintShare({ workspaceId: "review-old", projectId: "p1", by: "owner" });
  await p.execute(`UPDATE workspaces SET deleted_at=1 WHERE id='review-old'`);
  expect(await resolveShare(older.token)).toBeNull();
});
