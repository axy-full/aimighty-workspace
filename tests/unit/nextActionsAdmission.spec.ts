import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor, PreparedAdmission } from "../../lib/admissionTypes";
import { SEEDANCE_25, nextActionBody, type NextSettings } from "../../lib/shell/next-actions";
import { DEFAULT_TOPAZ_IMAGE } from "../../lib/topaz";

/*
 * The priced Next actions against the real admission (lib/generationAdmission.ts), under ENGINE_MOCK with a local
 * workspace database: each action's request, exactly as the Next row builds it, is one the quote route accepts and prices
 * on its own engine; sent at that estimate, it is filed as a NEW take — under its source's shot, as the shot's next
 * version — and the source's own row is left exactly as it was; and a shot with an approved take asks why before it
 * prices another. Nothing leaves this process: the network is forbidden and every engine is the mock.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-next-actions-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "next-actions-unit-keyring-not-a-real-secret";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const nodeRequire = createRequire(path.resolve("package.json"));
const RUN = Math.random().toString(36).slice(2, 8);
/** Stored originals this file writes under .data, removed when it is done. */
const written: string[] = [];
test.afterAll(async () => { await Promise.all(written.map((file) => unlink(file).catch(() => {}))); });

function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/") ? nodeRequire(path.resolve(name.slice(2) + ".ts"))
        : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), name + ".ts"))
        : nodeRequire(name);
    },
    target, target.exports,
  );
  return target.exports as T;
}
const noInline = () => { throw new Error("Durable dispatch acknowledged; inline work must not run"); };
function service() {
  const queue = { enqueueRender: async () => true };
  const gen = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", { "@/lib/inngest": queue });
  const route = load<{ POST(req: Request): Promise<Response> }>("app/api/generate/route.ts", {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireRender: async () => actor },
    "@/lib/generationAdmission": gen,
    "next/server": { NextResponse: Response, after: noInline },
  });
  return { gen, route };
}
type Service = ReturnType<typeof service>;
type Seeded = { plate: string; still: string; clip: string };

/** A workspace of its own, with one project, a shot SH010 holding a still (v1) and a stored clip (v2), and an uploaded plate. */
async function scope(name: string, fn: (s: Service, seeded: Seeded) => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  const id = `${name}-${RUN}`;
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  await grantCredits(id, 100000, "Test", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the Next action tests"); };
  try {
    await runInTenant(ws, async () => {
      await ready();
      await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      await fn(service(), await seed(name));
    }, actor);
  } finally {
    globalThis.fetch = fetch;
  }
}
async function seed(name: string): Promise<Seeded> {
  const { db } = await import("../../lib/db");
  const { storeUpload, storeOriginalBytes } = await import("../../lib/storage");
  const sharp = (await import("sharp")).default;
  const plate = `plate_${name}_${RUN}`, still = `still_${name}_${RUN}`, clip = `clip_${name}_${RUN}`;
  const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#34506b" } }).png().toBuffer();
  const upload = await storeUpload(plate, "png", png, "image/png");
  written.push(path.join(process.cwd(), ".data", "uploads", `${plate}.png`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,kind,ext,bytes,sha256,width,height,stored_url,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,0)",
    args: [plate, "Plate.png", "image/png", "image", "png", png.length, upload.sha256, 1600, 900, upload.url] });
  await db().execute("INSERT INTO shots(id,project_id,code,created_at,updated_at) VALUES('shot_1','project','SH010',0,0)");
  await db().execute({ sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,stored_url,created_at,updated_at,shot_id,version,provider,task) VALUES(?,?,?,?,?,?,?,?,0,0,'shot_1',1,'google','generate')",
    args: [still, "project", "image", "gemini-3.1-flash-image", "A pier at dusk", JSON.stringify({ ratio: "16:9", resolution: "1K" }), "succeeded", `/api/media/${still}`] });
  const mp4 = readFileSync("tests/fixtures/astra-source.mp4");
  const original = await storeOriginalBytes("video", clip, mp4, "video/mp4");
  written.push(path.join(process.cwd(), ".data", "generations", `${clip}.mp4`));
  await db().execute({ sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,stored_url,bytes,created_at,updated_at,shot_id,version,provider,task) VALUES(?,?,?,?,?,?,?,?,?,0,0,'shot_1',2,'byteplus','generate')",
    args: [clip, "project", "video", SEEDANCE_25, "The ferry turns", JSON.stringify({ duration: 4, resolution: "720p", ratio: "720:1280" }), "succeeded", original.url, mp4.length] });
  return { plate, still, clip };
}
function value(result: Awaited<ReturnType<typeof import("../../lib/generationAdmission").prepareGeneration>>): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
async function row(id: string) {
  const { db } = await import("../../lib/db");
  return (await db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
}
const body = (settings: NextSettings, source: { genId: string } | { uploadId: string }, shotId: string, reason?: string) =>
  nextActionBody({ settings, source, productionProjectId: "project", shotId, reason });
function send(s: Service, request: Record<string, unknown>, prepared: PreparedAdmission, key: string) {
  return s.route.POST(new Request("http://localhost/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ ...request, maxCredits: prepared.quote.estimatedCredits, quoteFingerprint: prepared.quote.fingerprint }),
  }));
}

test("every Next action's request, as the row builds it, is one admission accepts and prices on its own engine", async () => scope("priced", async (s, { plate, still, clip }) => {
  const cases: [string, Record<string, unknown>, (p: PreparedAdmission) => void][] = [
    ["upscale a still", body({ action: "upscale", media: "image", topaz: DEFAULT_TOPAZ_IMAGE }, { uploadId: plate }, ""), (p) => {
      expect(p.compiled).toMatchObject({ params: { topaz: DEFAULT_TOPAZ_IMAGE, references: [{ uploadId: plate, role: "reference_image", kind: "image" }] } });
    }],
    ["outpaint", body({ action: "outpaint", ratio: "9:16", prompt: "more of the harbour" }, { genId: still }, "shot_1"), (p) => {
      expect(p.compiled).toMatchObject({ shotId: "shot_1", params: { ratio: "9:16", references: [{ genId: still, role: "reference_image" }] } });
    }],
    ["animate", body({ action: "animate", prompt: "The camera pushes in slowly", ratio: "16:9", resolution: "720p", duration: 5, audio: false }, { genId: still }, "shot_1"), (p) => {
      expect(p.compiled).toMatchObject({ shotId: "shot_1", params: { ratio: "16:9", resolution: "720p", duration: 5, references: [{ genId: still, role: "first_frame", kind: "image" }] } });
    }],
    ["upscale a clip", body({ action: "upscale", media: "video", fps: 30 }, { genId: clip }, "shot_1"), (p) => {
      expect(p.compiled).toMatchObject({ params: { task: "upscale", sourceGenId: clip, fps60: false } });
    }],
    ["reframe", body({ action: "reframe", ratio: "16:9", prompt: "" }, { genId: clip }, "shot_1"), (p) => {
      expect(p.compiled).toMatchObject({ params: { task: "reframe", ratio: "16:9", sourceGenId: clip } });
    }],
    ["extend", body({ action: "extend", direction: "forward", prompt: "the ferry clears the harbour", resolution: "720p", duration: 5, audio: true }, { genId: clip }, "shot_1"), (p) => {
      expect(p.compiled).toMatchObject({ params: { task: "extend", sourceGenId: clip, sourceSeconds: 4 } });
      expect(String(p.compiled.prompt)).toContain("Continue from the final frame: the ferry clears the harbour");
    }],
  ];
  for (const [name, request, check] of cases) {
    const prepared = value(await s.gen.prepareGeneration(request, actor));
    expect(prepared.quote.estimatedCredits, name).toBeGreaterThan(0);
    expect(prepared.quote.fingerprint, name).toMatch(/^[a-f0-9]{64}$/);
    check(prepared);
  }
  /* Quoting makes nothing: only the seeded takes are on record. */
  const { db } = await import("../../lib/db");
  expect((await db().execute("SELECT id FROM generations ORDER BY id")).rows.map((r) => r.id)).toEqual([clip, still].sort());
}));

test("sent at its estimate, an action files a NEW take under its source's shot as the next version; the source's row is left as it was", async () => scope("filed", async (s, { still, clip }) => {
  const before = { still: await row(still), clip: await row(clip) };

  const outpaint = body({ action: "outpaint", ratio: "9:16", prompt: "" }, { genId: still }, "shot_1");
  const a = await send(s, outpaint, value(await s.gen.prepareGeneration(outpaint, actor)), `next-outpaint-${RUN}`);
  expect(a.ok, await a.clone().text()).toBe(true);
  const made = await row(String((await a.json()).id));
  expect(made).toMatchObject({ project_id: "project", shot_id: "shot_1", version: 3, kind: "image", model: "fal-ai/bria/expand" });
  expect(JSON.parse(String(made.params)).references).toEqual([{ genId: still, role: "reference_image", kind: "image" }]);

  const extend = body({ action: "extend", direction: "backward", prompt: "she walks up to the pier", resolution: "720p", duration: 5, audio: false }, { genId: clip }, "shot_1");
  const b = await send(s, extend, value(await s.gen.prepareGeneration(extend, actor)), `next-extend-${RUN}`);
  expect(b.ok, await b.clone().text()).toBe(true);
  const extended = await row(String((await b.json()).id));
  expect(extended).toMatchObject({ shot_id: "shot_1", version: 4, task: "extend", source_gen_id: clip, model: SEEDANCE_25 });
  expect(String(extended.prompt)).toContain("Extend backward: she walks up to the pier");

  /* The originals are untouched: same row, same file, same review state. */
  expect(await row(still)).toEqual(before.still);
  expect(await row(clip)).toEqual(before.clip);
}));

test("a shot with an approved take asks why before another is priced; the reason is kept with the new take", async () => scope("approved", async (s, { still }) => {
  const { db } = await import("../../lib/db");
  await db().execute({ sql: "UPDATE generations SET review_state='approved', approved_by='Ana', approved_at=1 WHERE id=?", args: [still] });
  const asked = await s.gen.prepareGeneration(body({ action: "outpaint", ratio: "1:1", prompt: "" }, { genId: still }, "shot_1"), actor);
  expect(asked).toMatchObject({ ok: false, status: 409, body: { needsReason: true, approvedVersion: 1 } });
  const withReason = body({ action: "outpaint", ratio: "1:1", prompt: "" }, { genId: still }, "shot_1", "Square for the poster");
  const prepared = value(await s.gen.prepareGeneration(withReason, actor));
  const sent = await send(s, withReason, prepared, `next-reason-${RUN}`);
  expect(sent.ok, await sent.clone().text()).toBe(true);
  expect(JSON.parse(String((await row(String((await sent.json()).id))).params)).reason).toBe("Square for the poster");
  /* A take filed under no shot of this production (an upload, or one from elsewhere) is never asked. */
  expect((await s.gen.prepareGeneration(body({ action: "outpaint", ratio: "1:1", prompt: "" }, { genId: still }, ""), actor)).ok).toBe(true);
}));
