import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor, PreparedAdmission, PrepareAdmissionResult } from "../../lib/admissionTypes";
import { GENJUTSU_MODELS } from "../../lib/genjutsuTypes";
import { MARKETING_IMAGE_MODEL_ID } from "../../lib/models";
import { generationRequestBody } from "../../lib/workbench/generation-request";
import { INITIAL_VIRAL, genjutsuInput, viralRequest, type ViralMedia, type ViralState } from "../../lib/shell/viral";
import { INITIAL_IMAGE_AD, imageAdRequest, withBuild, withPreset, type ImageAdState } from "../../lib/shell/image-ads";
import type { DispatchRequest } from "../../lib/workspace/generate-submit";

/**
 * Viral and Business › Image ads on Particl's API key, end to end through the
 * real admission (POST /api/generate/quote's prepareGeneration, then POST
 * /api/generate) in a MANAGED workspace — one on the platform's keys, paying
 * in credits, which is what every workspace becomes — for the owner and for a
 * member. The bodies are the ones the Suites composers build (lib/shell/viral
 * and lib/shell/image-ads through the shared builder); nothing new prices them.
 * The provider is mocked (ENGINE_MOCK=1: fixed estimates, no network), the
 * worker is never run, and nothing is billed.
 */
const directory = mkdtempSync(path.join(tmpdir(), "particl-key-route-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-key-route-admission-keyring-secret";
process.env.ENGINE_MOCK = "1";
process.env.BLOB_READ_WRITE_TOKEN = "";
const user = (id: string, role: "admin" | "member") => ({ user: { id, email: `${id}@example.invalid`, name: id, role, owner: role === "admin", disabled: false, createdAt: 0, lastSeen: null } }) as AdmissionActor;
const OWNER = user("owner", "admin"), MEMBER = user("member-1", "member");
const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) => {
    if (name in overrides) return overrides[name];
    return name.startsWith("@/") ? nodeRequire(path.resolve(`${name.slice(2)}.ts`))
      : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), `${name}.ts`)) : nodeRequire(name);
  }, target, target.exports);
  return target.exports as T;
}
const forbidDispatch = () => { throw new Error("The acknowledged test queue must not run a provider worker."); };

type Harness = Awaited<ReturnType<typeof setup>>;
async function fixture(name: string, actor: AdmissionActor, run: (f: Harness) => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  await platformReady();
  /* uses_platform_keys = 1: a managed workspace, on the platform's keys and paying in credits. */
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(directory, `${name}.db`)}`],
  });
  await grantCredits(name, 10000, "Key route test", OWNER.user.id, "manual");
  const workspace = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  expect(workspace.usesPlatformKeys).toBe(true);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network is forbidden in key-route admission tests."); };
  let localFiles: string[] = [];
  try {
    await runInTenant(workspace, async () => {
      const f = await setup(name, actor);
      localFiles = f.localFiles;
      await run(f);
    }, actor);
  } finally {
    globalThis.fetch = fetch;
    await Promise.all(localFiles.map((file) => unlink(file).catch(() => {})));
  }
}

async function setup(name: string, actor: AdmissionActor) {
  const database = await import("../../lib/db");
  const storage = await import("../../lib/storage");
  const metadata = await import("../../lib/videoMetadata.server");
  const higgsfield = await import("../../lib/higgsfield");
  const { saveDraft } = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  await database.ready();
  await database.db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Saved production',0)");
  await database.db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0)");
  /* The person's own draft of the production: admission files a transform only to a draft its sender owns. */
  await saveDraft(actor.user.id, { ...newProject("Key route draft"), id: "draft", productionProjectId: "project" }, 0);
  const dispatches: { id: string; kind: string }[] = [];
  const estimates: string[] = [];
  const genjutsu = await import("../../lib/genjutsu");
  const admission = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", {
    "@/lib/inngest": { enqueueRender: async (id: string, kind: string) => { dispatches.push({ id, kind }); return true; } },
    "@/lib/genjutsu": { ...genjutsu, estimateGenjutsuInput: async (model: string, input: Awaited<ReturnType<typeof genjutsu.genjutsuInput>>) => { estimates.push(model); return genjutsu.estimateGenjutsuInput(model, input); } },
    /* A 10 s, 1280×720 source: inside every floor, today's and the documented ones (4 s; Object Swap's pixels). */
    "@/lib/videoMetadata.server": { ...metadata, inspectOriginalVideo: async () => ({ width: 1280, height: 720, seconds: 10, firstTimestamp: 0 }) },
  });
  const handler = load<{ POST(request: Request): Promise<Response> }>("app/api/generate/route.ts", {
    "@/lib/auth": { withTenant: (fn: unknown) => fn, requireRender: async () => actor },
    "@/lib/generationAdmission": admission,
    "next/server": { after: forbidDispatch },
  });
  const localFiles: string[] = [];
  async function upload(id: string, kind: "video" | "image") {
    if (kind === "video") {
      const bytes = readFileSync("tests/fixtures/astra-source.mp4");
      const stored = await storage.storeUpload(id, "mp4", bytes, "video/mp4");
      localFiles.push(path.resolve(".data/uploads", `${id}.mp4`));
      await database.db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,width,height,duration_s,created_at) VALUES(?,?,'video/mp4','mp4',?,?,?,'video',1280,720,10,0)", args: [id, `${id}.mp4`, bytes.length, stored.sha256, stored.url] });
    } else {
      await database.db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES(?,?,'image/png','png',128,'fixture-sha',?,'image',0)", args: [id, `${id}.png`, `/api/uploads/${id}`] });
    }
  }
  async function post(body: Record<string, unknown>, key: string) {
    return handler.POST(new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  }
  const rows = async (model: string) => (await database.db().execute({ sql: "SELECT * FROM generations WHERE model=?", args: [model] })).rows;
  async function seenPreset(id: string) {
    await database.db().execute(`CREATE TABLE IF NOT EXISTS higgsfield_marketing_presets (
      id TEXT NOT NULL, credential_fingerprint TEXT NOT NULL, name TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(id,credential_fingerprint))`);
    await database.db().execute({ sql: "INSERT INTO higgsfield_marketing_presets(id,credential_fingerprint,name,seen_at) VALUES(?,?,?,?)", args: [id, higgsfield.higgsfieldCredentials().fingerprint, "Studio packshot", Date.now()] });
  }
  return { admission, database, dispatches, estimates, upload, post, rows, seenPreset, localFiles, name };
}
function prepared(result: PrepareAdmissionResult): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
const bodyOf = (request: DispatchRequest) => {
  if (!("input" in request) || !request.input) throw new Error("A generate request.");
  return generationRequestBody(request.input);
};
const approved = (body: Record<string, unknown>, quote: PreparedAdmission) => ({ ...body, maxCredits: quote.quote.estimatedCredits, quoteFingerprint: quote.quote.fingerprint });
const media = (id: string, kind: "video" | "image"): ViralMedia => ({ id: `upload:${id}`, sourceId: id, origin: "upload", kind, name: id, url: `/api/uploads/${id}`, seconds: kind === "video" ? 10 : null });
const still = (id: string) => ({ id: `upload:${id}`, name: id, sourceId: id, origin: "upload" as const, url: `/api/uploads/${id}` });

for (const [who, actor] of [["the owner", OWNER], ["a member", MEMBER]] as const) {
  test(`Viral's own body is priced by the live estimate and admitted once, filed to the project, for ${who} of a managed workspace`, async () =>
    fixture(`viral_${actor.user.role}`, actor, async (f) => {
      await f.upload("src", "video");
      for (const id of ["a", "b"]) await f.upload(id, "image");
      const state: ViralState = { ...INITIAL_VIRAL, prompt: "Keep the hands as filmed.", source: media("src", "video"), references: [media("b", "image"), media("a", "image")] };
      for (const page of ["motion", "swap"] as const) {
        const body = bodyOf(viralRequest(genjutsuInput(page, state)!, { id: "draft", productionProjectId: "project" }));
        const quote = prepared(await f.admission.prepareGeneration(body, actor));
        expect(quote.quote).toMatchObject({ unit: "cr" });
        expect(quote.quote.estimatedCredits).toBeGreaterThan(0);
        expect(quote.compiled.projectId).toBe("project");
        /* The order is the director's: the source apart, then b before a. */
        expect((quote.compiled.references as { id: string; kind: string }[]).map((r) => [r.id, r.kind])).toEqual([["src", "video"], ["b", "image"], ["a", "image"]]);
        const accepted = await f.post(approved(body, quote), `viral-${page}-${actor.user.id}`);
        const result = await accepted.json();
        expect(accepted.status, JSON.stringify(result)).toBe(202);
        /* The same press again (a lost reply) is the same job, never a second one. */
        expect((await (await f.post(approved(body, quote), `viral-${page}-${actor.user.id}`)).json()).id).toBe(result.id);
        const model = GENJUTSU_MODELS[page === "motion" ? "motion-transfer" : "object-swap"];
        const [row] = await f.rows(model);
        expect(row).toMatchObject({ id: result.id, project_id: "project", task: "genjutsu", provider: "higgsfield", created_by: actor.user.id, shot_id: null });
      }
      /* Each variant priced by its own live estimate; one dispatch each, however often the press is repeated. */
      expect([...new Set(f.estimates)].sort()).toEqual([GENJUTSU_MODELS["motion-transfer"], GENJUTSU_MODELS["object-swap"]].sort());
      expect(f.dispatches).toHaveLength(2);
    }));
}

test("Viral's refusals come before any estimate: more than eight stills, another person's draft, an unsaved project, an unapproved press", async () =>
  fixture("viral_refusals", MEMBER, async (f) => {
    await f.upload("src", "video");
    const ids = Array.from({ length: 9 }, (_, i) => `r${i}`);
    for (const id of ids) await f.upload(id, "image");
    const base: ViralState = { ...INITIAL_VIRAL, source: media("src", "video"), references: ids.slice(0, 1).map((id) => media(id, "image")) };
    const request = (state: ViralState, project = { id: "draft", productionProjectId: "project" }) => bodyOf(viralRequest(genjutsuInput("motion", state)!, project));
    /* The composer caps at eight; a body built past that is refused by the route all the same. */
    expect(await f.admission.prepareGeneration(request({ ...base, references: ids.map((id) => media(id, "image")) }), MEMBER)).toMatchObject({ ok: false, status: 400 });
    /* Someone else's draft, or a draft not linked to this production. */
    await f.database.db().execute("UPDATE workbench_projects SET owner='someone-else' WHERE project_id='draft'");
    expect(await f.admission.prepareGeneration(request(base), MEMBER)).toMatchObject({ ok: false });
    await f.database.db().execute({ sql: "UPDATE workbench_projects SET owner=? WHERE project_id='draft'", args: [MEMBER.user.id] });
    expect(await f.admission.prepareGeneration(request(base, { id: "draft", productionProjectId: "other-project" }), MEMBER)).toMatchObject({ ok: false });
    expect(f.estimates).toEqual([]);
    /* A quote is required, and so is its ceiling. */
    const body = request(base);
    const quote = prepared(await f.admission.prepareGeneration(body, MEMBER));
    for (const [patch, status] of [[{}, 400], [{ quoteFingerprint: quote.quote.fingerprint }, 400], [{ quoteFingerprint: quote.quote.fingerprint, maxCredits: 0 }, 409]] as const)
      expect((await f.post({ ...body, ...patch }, `unapproved-${Object.keys(patch).join("-") || "none"}`)).status).toBe(status);
    expect(await f.rows(GENJUTSU_MODELS["motion-transfer"])).toEqual([]);
    expect(f.dispatches).toEqual([]);
  }));

for (const [who, actor] of [["the owner", OWNER], ["a member", MEMBER]] as const) {
  test(`Image ads' own body runs Marketing Studio Image on the key: priced, admitted once and filed to the project, for ${who}`, async () =>
    fixture(`image_ads_${actor.user.role}`, actor, async (f) => {
      for (const id of ["product", "model", "extra"]) await f.upload(id, "image");
      const state: ImageAdState = { ...INITIAL_IMAGE_AD, prompt: "Bold hero shot on marble", aspect: "3:4", resolution: "2k", quality: "medium", productStill: still("product"), medias: [still("extra")] };
      const body = bodyOf(imageAdRequest(state, { productionProjectId: "project" }));
      expect(body).toMatchObject({ model: MARKETING_IMAGE_MODEL_ID, marketing: { quality: "medium", enhancePrompt: false }, references: [{ uploadId: "product", role: "reference_image" }, { uploadId: "extra", role: "reference_image" }] });
      expect(body).not.toHaveProperty("shotId");
      const quote = prepared(await f.admission.prepareGeneration(body, actor));
      expect(quote.quote.estimatedCredits).toBeGreaterThan(0);
      const accepted = await f.post(approved(body, quote), `image-ad-${actor.user.id}`);
      const result = await accepted.json();
      /* A still is admitted as running (200); a video as queued (202). Either is one job. */
      expect([200, 202], JSON.stringify(result)).toContain(accepted.status);
      expect((await (await f.post(approved(body, quote), `image-ad-${actor.user.id}`)).json()).id).toBe(result.id);
      const [row] = await f.rows(MARKETING_IMAGE_MODEL_ID);
      expect(row).toMatchObject({ id: result.id, project_id: "project", provider: "higgsfield", created_by: actor.user.id, shot_id: null });
      expect(JSON.parse(String(row.params))).toMatchObject({ marketing: { quality: "medium", enhancePrompt: false } });
    }));
}

test("Image ads with a preset: the product first and one more still at most, at high quality, and only a preset this key has listed", async () =>
  fixture("image_ads_preset", MEMBER, async (f) => {
    for (const id of ["product", "model", "extra"]) await f.upload(id, "image");
    const preset = { id: "0b9f3c2e-6a1d-4c8e-9f7a-2d5e8c1b4a60", name: "Studio packshot" };
    const state = withPreset({ ...INITIAL_IMAGE_AD, prompt: "Clean studio packshot", quality: "low", productStill: still("product"), medias: [still("model")] }, preset);
    expect(state.quality).toBe("high");
    const body = bodyOf(imageAdRequest(state, { productionProjectId: "project" }));
    expect(body.marketing).toEqual({ quality: "high", enhancePrompt: true, presetId: preset.id });
    /* A preset the key has not listed within the hour is refused before anything is priced. */
    expect(await f.admission.prepareGeneration(body, MEMBER)).toMatchObject({ ok: false, status: 409 });
    await f.seenPreset(preset.id);
    const quote = prepared(await f.admission.prepareGeneration(body, MEMBER));
    expect([200, 202]).toContain((await f.post(approved(body, quote), "image-ad-preset")).status);
    /* Three stills with a preset: refused by the provider's rule, before any estimate. */
    const three = bodyOf(imageAdRequest({ ...state, medias: [still("model"), still("extra")] }, { productionProjectId: "project" }));
    expect(await f.admission.prepareGeneration(three, MEMBER)).toMatchObject({ ok: false, status: 400 });
    expect((await f.rows(MARKETING_IMAGE_MODEL_ID))).toHaveLength(1);
  }));

test("Image ads on a 2.5 build: the composer's own body names its variant, is priced approximately, and is admitted once at that figure", async () =>
  fixture("image_ads_25", MEMBER, async (f) => {
    for (const id of ["product", "extra"]) await f.upload(id, "image");
    const preset = { id: "0b9f3c2e-6a1d-4c8e-9f7a-2d5e8c1b4a61", name: "Studio packshot" };
    await f.seenPreset(preset.id);
    const plain: ImageAdState = { ...withBuild({ ...INITIAL_IMAGE_AD, prompt: "Bold hero shot on marble", productStill: still("product"), medias: [still("extra")] }, "flare"), quality: "xhigh" };
    const enhanced = withPreset({ ...withBuild({ ...INITIAL_IMAGE_AD, prompt: "Clean studio packshot", productStill: still("product") }, "sunburst"), quality: "max" }, preset);
    for (const [state, variant, quality] of [[plain, "flare", "xhigh"], [enhanced, "sunburst", "max"]] as const) {
      const body = bodyOf(imageAdRequest(state, { productionProjectId: "project" }));
      expect(body.marketing).toMatchObject({ variant, quality });
      const quote = prepared(await f.admission.prepareGeneration(body, MEMBER));
      /* Approximate: from the published rates; the delivered image settles it. */
      expect(quote.quote).toMatchObject({ unit: "cr", approximate: true });
      expect(quote.quote.estimatedCredits).toBeGreaterThan(0);
      const accepted = await f.post(approved(body, quote), `image-ad-${variant}`);
      expect([200, 202], String(accepted.status)).toContain(accepted.status);
    }
    const rows = await f.rows(MARKETING_IMAGE_MODEL_ID);
    expect(rows.map((row) => (JSON.parse(String(row.params)) as { marketing: { variant?: string; quality: string } }).marketing).map((m) => [m.variant, m.quality]).sort())
      .toEqual([["flare", "xhigh"], ["sunburst", "max"]]);
    /* 2.0 Alpha's quote is the provider's live estimate, not an approximation. */
    const alpha = bodyOf(imageAdRequest({ ...INITIAL_IMAGE_AD, prompt: "Bold hero shot on marble", productStill: still("product") }, { productionProjectId: "project" }));
    expect(prepared(await f.admission.prepareGeneration(alpha, MEMBER)).quote).not.toHaveProperty("approximate");
  }));
