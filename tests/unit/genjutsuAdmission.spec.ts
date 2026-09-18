import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor, PreparedAdmission, PrepareAdmissionResult } from "../../lib/admissionTypes";
import type { Reference } from "../../lib/ark";
import type { VideoMetadata } from "../../lib/videoMetadata.server";
import { GENJUTSU_MODELS } from "../../lib/genjutsuTypes";

const directory = mkdtempSync(path.join(tmpdir(), "particl-genjutsu-admission-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-genjutsu-admission-keyring-secret";
process.env.ENGINE_MOCK = "1";
process.env.BLOB_READ_WRITE_TOKEN = "";
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
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
type EstimateInput = Awaited<ReturnType<typeof import("../../lib/genjutsu").genjutsuInput>>;
type VideoSource = { sourceUploadId: string; sourceGenId?: never } | { sourceGenId: string; sourceUploadId?: never };
type ImageReference = ({ uploadId: string; genId?: never } | { genId: string; uploadId?: never }) & { role: "reference_image" };
type State = {
  price: number;
  estimateError: Error | null;
  credential: string;
  metadata: VideoMetadata | null;
  inspections: Reference[];
  estimates: { model: string; input: EstimateInput }[];
  dispatches: { id: string; kind: string }[];
};
async function fixture(name: string, run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(directory, `${name}.db`)}`],
  });
  await grantCredits(name, 10000, "Genjutsu test", actor.user.id, "manual");
  const workspace = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network is forbidden in Genjutsu admission tests."); };
  let localFiles: string[] = [];
  try {
    await runInTenant(workspace, async () => {
      const f = await setup(name);
      localFiles = f.localFiles;
      await run(f);
    }, actor);
  } finally {
    globalThis.fetch = fetch;
    await Promise.all(localFiles.map(file => unlink(file).catch(() => {})));
  }
}
async function setup(name: string) {
  const database = await import("../../lib/db");
  const storage = await import("../../lib/storage");
  const genjutsu = await import("../../lib/genjutsu");
  const higgsfield = await import("../../lib/higgsfield");
  const metadata = await import("../../lib/videoMetadata.server");
  const { saveDraft } = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  await database.ready();
  await database.db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Saved production',0),('other-project','Other production',0)");
  await database.db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0)");
  await saveDraft(actor.user.id, { ...newProject("Genjutsu draft"), id: "draft", productionProjectId: "project" }, 0);
  const state: State = { price: 0.75, estimateError: null, credential: "a".repeat(64), metadata: null, inspections: [], estimates: [], dispatches: [] };
  const admission = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", {
    "@/lib/inngest": { enqueueRender: async (id: string, kind: string) => { state.dispatches.push({ id, kind }); return true; } },
    "@/lib/higgsfield": { ...higgsfield, higgsfieldCredentialFingerprint: () => state.credential },
    "@/lib/genjutsu": { ...genjutsu, estimateGenjutsuInput: async (model: string, input: EstimateInput) => {
      state.estimates.push({ model, input: structuredClone(input) });
      if (state.estimateError) throw state.estimateError;
      return state.price;
    } },
    "@/lib/videoMetadata.server": { ...metadata, inspectOriginalVideo: async (ref: Reference, bytes: number) => {
      state.inspections.push(structuredClone(ref));
      return state.metadata ?? metadata.inspectOriginalVideo(ref, bytes);
    } },
  });
  const handler = load<{ POST(request: Request): Promise<Response> }>("app/api/generate/route.ts", {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireRender: async () => actor },
    "@/lib/generationAdmission": admission,
    "next/server": { after: forbidDispatch },
  });
  const localFiles: string[] = [];
  async function video(origin: "upload" | "generation" = "upload", bytes = readFileSync("tests/fixtures/astra-source.mp4")): Promise<VideoSource> {
    const id = `${name}_${origin}`;
    if (origin === "upload") {
      const stored = await storage.storeUpload(id, "mp4", bytes, "video/mp4");
      localFiles.push(path.resolve(".data/uploads", `${id}.mp4`));
      await database.db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,width,height,duration_s,created_at) VALUES(?,?,'video/mp4','mp4',?,? ,?,'video',1,1,0.01,0)", args: [id, `${id}.mp4`, bytes.length, stored.sha256, stored.url] });
    } else {
      const stored = await storage.storeVideoBytes(id, bytes);
      localFiles.push(path.resolve(".data/generations", `${id}.mp4`));
      await database.db().execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,stored_url,kind,bytes,created_at,updated_at) VALUES(?,'other-project','fixture','Original','{\"duration\":0.01,\"ratio\":\"1:1\"}','succeeded',?,'video',?,0,0)", args: [id, stored.url, bytes.length] });
    }
    return origin === "upload" ? { sourceUploadId: id } : { sourceGenId: id };
  }
  async function image(index: number, origin: "upload" | "generation" = "upload", kind = "image"): Promise<ImageReference> {
    const id = `${name}_reference_${index}`;
    if (origin === "upload") {
      await database.db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES(?,? ,?,'png',128,'fixture-sha',?,?,0)", args: [id, `${id}.png`, kind === "image" ? "image/png" : "video/mp4", `/api/uploads/${id}`, kind] });
    } else {
      await database.db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,stored_url,created_at,updated_at) VALUES(?,?,'fixture','Reference','{}','succeeded',?,0,0)", args: [id, kind, `/api/media/${id}`] });
    }
    return { ...(origin === "upload" ? { uploadId: id } : { genId: id }), role: "reference_image" };
  }
  function body(source: VideoSource, patch: Record<string, unknown> = {}) {
    return { model: GENJUTSU_MODELS["motion-transfer"], task: "genjutsu", prompt: "", resolution: "720p", projectId: "project", workbenchProjectId: "draft", references: [], refine: false, ...source, ...patch };
  }
  async function post(body: Record<string, unknown>, key: string) {
    return handler.POST(new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
  }
  async function outputs() { return (await database.db().execute({ sql: "SELECT * FROM generations WHERE model IN (?,?)", args: Object.values(GENJUTSU_MODELS) })).rows; }
  async function meters() {
    const { platformDb } = await import("../../lib/platform");
    return (await platformDb().execute({ sql: "SELECT * FROM meter_events WHERE workspace_id=?", args: [name] })).rows;
  }
  return { state, admission, database, video, image, body, post, outputs, meters, localFiles };
}
function prepared(result: PrepareAdmissionResult): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
const approved = (body: Record<string, unknown>, quote: PreparedAdmission) => ({ ...body, maxCredits: quote.quote.estimatedCredits, quoteFingerprint: quote.quote.fingerprint });

test("Genjutsu quote measures retained upload and generated originals instead of trusting claimed duration", async () => fixture("genjutsu_originals", async f => {
  for (const origin of ["upload", "generation"] as const) {
    const source = await f.video(origin);
    const body = f.body(source, { duration: 0.01, ratio: "1:1", sourceSeconds: 0.01, genjutsuSource: { width: 1, height: 1, seconds: 0.01 }, higgsfieldVendorCostUsd: 0, higgsfieldCredentialFingerprint: "client-spoof" });
    const quote = prepared(await f.admission.prepareGeneration(body, actor));
    expect(quote.compiled.params).toMatchObject({ ...source, sourceSeconds: 1.5, duration: 1.5, higgsfieldVendorCostUsd: 0.75, higgsfieldCredentialFingerprint: f.state.credential });
    expect(quote.compiled.source).toMatchObject({ id: Object.values(source)[0], kind: "video", fromGeneration: origin === "generation" });
    expect(quote.compiled.projectId).toBe("project");
    expect(quote.request.workbenchProjectId).toBe("draft");
    expect(quote.quote.estimatedCredits).toBeGreaterThan(0);
    expect(f.state.estimates.at(-1)!.input).toMatchObject({ prompt: "", resolution: "720p", image_urls: [] });
    expect(f.state.estimates.at(-1)!.input.video_url).toContain(Object.values(source)[0]);
  }
  expect(f.state.inspections).toHaveLength(2);
  expect(await f.outputs()).toEqual([]);
  expect(await f.meters()).toEqual([]);
  expect(f.state.dispatches).toEqual([]);
}));

test("Genjutsu uses inspected 1–30 second boundaries and refuses an unreadable original before pricing", async () => fixture("genjutsu_duration", async f => {
  const source = await f.video(), body = f.body(source);
  for (const seconds of [1, 30]) {
    f.state.metadata = { width: 640, height: 360, seconds, firstTimestamp: 0 };
    const quote = prepared(await f.admission.prepareGeneration(body, actor));
    expect(quote.compiled.params).toMatchObject({ sourceSeconds: seconds, duration: seconds });
  }
  for (const seconds of [0, 0.999, 30.001, Infinity, NaN]) {
    f.state.metadata = { width: 640, height: 360, seconds, firstTimestamp: 0 };
    expect(await f.admission.prepareGeneration(body, actor)).toMatchObject({ ok: false, status: 400 });
  }
  f.state.metadata = null;
  const broken = await f.video("generation", Buffer.alloc(128));
  expect(await f.admission.prepareGeneration(f.body(broken), actor)).toMatchObject({ ok: false, status: 400 });
  expect(f.state.estimates).toHaveLength(2);
  expect(await f.outputs()).toEqual([]);
  expect(await f.meters()).toEqual([]);
  expect(f.state.dispatches).toEqual([]);
}));

test("Genjutsu admits zero, one or eight ordered still references and refuses unsupported inputs before estimation", async () => fixture("genjutsu_references", async f => {
  const source = await f.video();
  const refs = await Promise.all(Array.from({ length: 9 }, (_, index) => f.image(index, index % 2 ? "generation" : "upload")));
  for (const count of [0, 1, 8]) {
    const selected = refs.slice(0, count);
    const quote = prepared(await f.admission.prepareGeneration(f.body(source, { references: selected, model: GENJUTSU_MODELS["object-swap"] }), actor));
    expect((quote.compiled.references as Reference[]).map(ref => ref.id)).toEqual([source.sourceUploadId, ...selected.map(ref => ref.uploadId ?? ref.genId)]);
    expect((quote.compiled.references as Reference[])[0]).toMatchObject({ kind: "video", role: "reference_video" });
    expect(f.state.estimates.at(-1)!.model).toBe(GENJUTSU_MODELS["object-swap"]);
    expect(f.state.estimates.at(-1)!.input.image_urls).toHaveLength(count);
  }
  const videoReference = await f.image(20, "upload", "video");
  for (const patch of [
    { references: refs }, { references: [videoReference] }, { references: [{ ...refs[0], role: "first_frame" }] },
    { references: [{ image_url: "https://attacker.invalid/private.png" }] },
    { references: [{ uploadId: refs[0].uploadId, genId: refs[1].genId, role: "reference_image" }] },
    { sourceGenId: "ambiguous-second-source" }, { sourceUploadId: undefined }, { resolution: "1080p" },
    { task: "generate" }, { prompt: "x".repeat(5001) },
  ]) expect(await f.admission.prepareGeneration(f.body(source, patch), actor), JSON.stringify(patch)).toMatchObject({ ok: false });
  expect(f.state.estimates).toHaveLength(3);
  expect(await f.outputs()).toEqual([]);
  expect(f.state.dispatches).toEqual([]);
}));

test("Genjutsu source IDs, saved draft ownership and production mapping are checked in the current tenant", async () => {
  let foreignSource: VideoSource, foreignReference: ImageReference;
  await fixture("genjutsu_tenant_a", async f => { foreignSource = await f.video(); foreignReference = await f.image(1); });
  await fixture("genjutsu_tenant_b", async f => {
    expect(await f.admission.prepareGeneration(f.body(foreignSource!), actor)).toMatchObject({ ok: false });
    const source = await f.video();
    expect(await f.admission.prepareGeneration(f.body(source, { references: [foreignReference!] }), actor)).toMatchObject({ ok: false });
    for (const patch of [{ workbenchProjectId: "missing-draft" }, { workbenchProjectId: undefined }, { projectId: "other-project" }])
      expect(await f.admission.prepareGeneration(f.body(source, patch), actor)).toMatchObject({ ok: false });
    await f.database.db().execute("UPDATE workbench_projects SET owner='another-member' WHERE project_id='draft'");
    expect(await f.admission.prepareGeneration(f.body(source), actor)).toMatchObject({ ok: false });
    expect(f.state.estimates).toEqual([]);
    expect(await f.outputs()).toEqual([]);
    expect(await f.meters()).toEqual([]);
    expect(f.state.dispatches).toEqual([]);
  });
});

test("Genjutsu requires an immutable quote and credit ceiling, then reserves and dispatches once with original source bindings", async () => fixture("genjutsu_admission", async f => {
  const source = await f.video(), refs = [await f.image(1, "generation"), await f.image(2)];
  const body = f.body(source, { prompt: "Replace only the bottle", references: refs });
  const quote = prepared(await f.admission.prepareGeneration(body, actor));
  for (const [patch, status] of [[{}, 400], [{ quoteFingerprint: quote.quote.fingerprint }, 400], [{ maxCredits: quote.quote.estimatedCredits }, 400], [{ quoteFingerprint: quote.quote.fingerprint, maxCredits: 0 }, 409]] as const) {
    const response = await f.post({ ...body, ...patch }, `missing-approval-${Object.keys(patch).join("-") || "both"}`);
    expect(response.status, await response.text()).toBe(status);
  }
  for (const patch of [{ prompt: "Replace the entire room" }, { resolution: "480p" }, { references: [...refs].reverse() }, { model: GENJUTSU_MODELS["object-swap"] }]) {
    const response = await f.post({ ...approved(body, quote), ...patch }, `changed-input-${Object.keys(patch)[0]}`);
    expect(response.status, await response.text()).toBe(409);
  }
  expect(await f.outputs()).toEqual([]);
  expect(await f.meters()).toEqual([]);
  const accepted = await f.post(approved(body, quote), "genjutsu-approved-once");
  const result = await accepted.json();
  expect(accepted.status, JSON.stringify(result)).toBe(202);
  const replay = await f.post(approved(body, quote), "genjutsu-approved-once");
  expect((await replay.json()).id).toBe(result.id);
  expect(f.state.dispatches).toEqual([{ id: result.id, kind: "video" }]);
  const rows = await f.outputs();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ project_id: "project", model: body.model, task: "genjutsu", provider: "higgsfield", prompt: body.prompt });
  expect(JSON.parse(String(rows[0].params))).toMatchObject({ ...source, workbenchProjectId: "draft", sourceSeconds: 1.5, higgsfieldVendorCostUsd: 0.75, higgsfieldCredentialFingerprint: f.state.credential, references: [{ uploadId: source.sourceUploadId, kind: "video", role: "reference_video" }, ...refs.map(ref => ({ ...ref, kind: "image" }))] });
  const meters = await f.meters();
  expect(meters).toHaveLength(1);
  expect(Number(meters[0].engine_cost_usd)).toBe(0.75);
}));

test("Genjutsu refuses failed estimates and revalidates live price and credentials before a quoted admission", async () => fixture("genjutsu_drift", async f => {
  const source = await f.video(), body = f.body(source);
  const quote = prepared(await f.admission.prepareGeneration(body, actor));
  const { MarketingError } = await import("../../lib/higgsfieldMarketing");
  f.state.estimateError = new MarketingError("Price unavailable", 503, "price_unavailable");
  expect(await f.admission.prepareGeneration(body, actor)).toMatchObject({ ok: false, status: 503, body: { code: "price_unavailable" } });
  f.state.estimateError = null;
  f.state.price = 0.74;
  expect((await f.post(approved(body, quote), "genjutsu-lower-price")).status).toBe(409);
  f.state.price = 0.75;
  f.state.credential = "b".repeat(64);
  expect((await f.post(approved(body, quote), "genjutsu-new-credential")).status).toBe(409);
  expect(await f.outputs()).toEqual([]);
  expect(await f.meters()).toEqual([]);
  expect(f.state.dispatches).toEqual([]);
}));
