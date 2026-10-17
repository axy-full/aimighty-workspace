import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import sharp from "sharp";
import type { TenantWorkspace } from "../../lib/tenant";
import { IMAGE_TIERS, coverWidth, imageSizes, imageSrcSet, parseTier, tierUrl } from "../../lib/imageTiers";

/**
 * Pictures in width tiers (lib/imageTiers.ts; owner, 16 Oct 2026, 15:05: "every image served at ≥2× its displayed size via srcset"):
 * the srcset a Particl still is offered with, and the preview route's `?w=` that answers it (app/api/workbench/preview/[kind]/[id]).
 * The route keeps its access checks before any cache: an upload this person may not open, or one in another workspace, is a 404 at
 * every width. Real temporary databases; storage and sign-in are fakes, so no provider or bucket is touched.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-image-tiers-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const run = Math.random().toString(36).slice(2, 8);
const workspace = (id: string) => ({ id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, id + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false }) as TenantWorkspace;

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)), mod, mod.exports);
  return mod.exports as T;
}

test("a Particl still is offered in every tier, by width; any other picture is left as it is", () => {
  expect(IMAGE_TIERS).toEqual([320, 640, 960, 1280, 1920, 2560, 3840]);
  expect(tierUrl("/api/media/gen_1", 1280)).toBe("/api/workbench/preview/generation/gen_1?w=1280");
  expect(tierUrl("/api/uploads/upl_1", 640)).toBe("/api/workbench/preview/upload/upl_1?w=640");
  /* The 640 px thumbnail URL names the same still, so it gets the tiers too (a well never stretches the thumbnail). */
  expect(tierUrl("/api/workbench/preview/generation/gen_1", 1920)).toBe("/api/workbench/preview/generation/gen_1?w=1920");
  expect(imageSrcSet("/api/media/gen_1")).toBe(IMAGE_TIERS.map((w) => `/api/workbench/preview/generation/gen_1?w=${w} ${w}w`).join(", "));
  for (const other of ["/campaign/harbour.webp", "data:image/png;base64,AAAA", "https://vendor.test/x.png", "/api/uploads/session", "", "blob:https://particl.test/1"]) expect(imageSrcSet(other), other).toBeUndefined();
});

test("sizes is the width the file is drawn at: the box, or wider for a cover crop of a wider picture; the window before it is measured", () => {
  expect(imageSizes(412.2)).toBe("413px");
  expect(imageSizes(null)).toBe("100vw");
  expect(imageSizes(0)).toBe("100vw");
  /* A 16:9 still in a square well, cropped to cover: drawn 16/9 of the box's width. */
  expect(coverWidth({ width: 300, height: 300 }, 16 / 9)).toBeCloseTo(533.3, 1);
  /* A 9:16 still in a 16:9 well: the width governs. */
  expect(coverWidth({ width: 640, height: 360 }, 9 / 16)).toBe(640);
  expect(coverWidth({ width: 640, height: 360 }, null)).toBe(640);
  expect(coverWidth({ width: 0, height: 360 }, 1)).toBeNull();
});

test("only the tiers are widths the route answers", () => {
  for (const w of IMAGE_TIERS) expect(parseTier(String(w))).toBe(w);
  for (const no of ["700", "640.0", "0640", "", "-640", "1e3", "abc"]) expect(parseTier(no), no).toBeNull();
  expect(parseTier(null)).toBeNull();
});

test("the route: a tier is a downscale to exactly that width, the original at or past its own width, a 404 for any other width; access before cache", async () => {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const access = await import("../../lib/uploadAccess");
  const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "#4a6" } }).png().toBuffer();
  let viewer = { id: "u_up", role: "member" };
  const reads: string[] = [];
  const GET = load<typeof import("../../app/api/workbench/preview/[kind]/[id]/route")>("app/api/workbench/preview/[kind]/[id]/route.ts", {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireUser: async () => ({ user: viewer }) },
    "@/lib/db": database, "@/lib/tenant": tenant, "@/lib/uploadAccess": access,
    "@/lib/draftProject": { mayReadTake: async () => true },
    "@/lib/storage": { readImageBytes: async (id: string) => { reads.push(id); return big; }, readUploadBytes: async (id: string) => { reads.push(id); return big; } },
  }).GET;
  const ask = (kind: string, id: string, query = "") => GET(new Request(`https://particl.test/api/workbench/preview/${kind}/${id}${query}`), { params: Promise.resolve({ kind, id }) });
  const width = async (r: Response) => (await sharp(Buffer.from(await r.arrayBuffer())).metadata()).width;
  const ws = workspace(`tiers-a-${run}`);
  const id = `upl_tier_${run}`;
  await tenant.runInTenant(ws, async () => {
    await database.ready();
    await database.db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind,uploader_id) VALUES(?,?,?,?,?,?,NULL,NULL,'',1,'image',?)",
      args: [id, "frame.png", "image/png", "png", big.length, "x", "u_up"],
    });
    for (const w of [320, 640, 1280, 1920, 2560]) {
      const r = await ask("upload", id, `?w=${w}`);
      expect(r.status, `w=${w}`).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/webp");
      expect(await width(r), `w=${w}`).toBe(w);
    }
    /* Past the original's own width: the original itself, through its own route (which checks access again). */
    const past = await ask("upload", id, "?w=3840");
    expect(past.status).toBe(302);
    expect(past.headers.get("location")).toBe(`/api/uploads/${id}`);
    /* Without w, the 640 px thumbnail it has always been (inside a 640 box). */
    const thumb = await ask("upload", id);
    expect(thumb.status).toBe(200);
    expect(await width(thumb)).toBe(640);
    for (const bad of ["?w=700", "?w=", "?w=640.0"]) expect((await ask("upload", id, bad)).status, bad).toBe(404);
    /* Cached answers are still behind the access check: a teammate who may not open the upload gets the unknown id's 404 at every width. */
    const before = reads.length;
    viewer = { id: "u_mate", role: "member" };
    for (const q of ["?w=640", "?w=1280", "?w=3840", ""]) expect((await ask("upload", id, q)).status, `teammate ${q}`).toBe(404);
    expect(reads.length, "a refused request reads nothing").toBe(before);
    viewer = { id: "u_up", role: "member" };
    /* A starter production's demo still has no bytes here: every tier sends the viewer to its original. */
    await database.db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted,created_by,project_id,stored_url) VALUES(?,?,?,?,?,1,1,'image','',0,'u_up',NULL,?)",
      args: [`gen_demo_${run}`, "mock", "", "{}", "succeeded", "/api/platform/previews/still-a"],
    });
    const demo = await ask("generation", `gen_demo_${run}`, "?w=1280");
    expect(demo.status).toBe(302);
    expect(demo.headers.get("location")).toBe(`/api/media/gen_demo_${run}`);
  });
  /* Another workspace holding no such upload: a 404 at every width, even with this one's tiers cached. */
  await tenant.runInTenant(workspace(`tiers-b-${run}`), async () => {
    await database.ready();
    for (const q of ["?w=640", "?w=1280", ""]) expect((await ask("upload", id, q)).status, `other workspace ${q}`).toBe(404);
  });
});
