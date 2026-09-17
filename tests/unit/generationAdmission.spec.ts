import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type {
  AdmissionActor,
  PreparedAdmission,
} from "../../lib/admissionTypes";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-admission-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const actor: AdmissionActor = {
  user: {
    id: "owner",
    email: "owner@example.invalid",
    name: "Owner",
    role: "admin",
    owner: true,
    disabled: false,
    createdAt: 0,
    lastSeen: null,
  },
};
const nodeRequire = createRequire(path.resolve("package.json"));
let dispatched: { genId: string; kind: string }[] = [];
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/")
        ? nodeRequire(path.resolve(name.slice(2) + ".ts"))
        : name.startsWith(".")
          ? nodeRequire(path.resolve(path.dirname(file), name + ".ts"))
          : nodeRequire(name);
    },
    target,
    target.exports,
  );
  return target.exports as T;
}
function services() {
  const queue = {
    enqueueRender: async (genId: string, kind: string) => {
      dispatched.push({ genId, kind });
      return true;
    },
  };
  return {
    gen: load<typeof import("../../lib/generationAdmission")>(
      "lib/generationAdmission.ts",
      { "@/lib/inngest": queue },
    ),
    audio: load<typeof import("../../lib/audioAdmission")>(
      "lib/audioAdmission.ts",
      { "@/lib/inngest": queue },
    ),
  };
}
async function scope(
  name: string,
  fn: (loaded: ReturnType<typeof services>) => Promise<void>,
) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } =
    await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`],
  });
  await grantCredits(name, 10000, "Test", "owner", "manual");
  const ws = rowToWorkspace(
    (
      await platformDb().execute({
        sql: "SELECT * FROM workspaces WHERE id=?",
        args: [name],
      })
    ).rows[0],
  );
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network forbidden in admission parity test");
  };
  dispatched = [];
  try {
    await runInTenant(
      ws,
      async () => {
        await ready();
        await db().execute(
          "INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)",
        );
        await db().execute(
          "INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'",
        );
        await fn(services());
      },
      actor,
    );
  } finally {
    globalThis.fetch = fetch;
  }
}
const noInline = () => {
  throw new Error("Durable dispatch acknowledged; inline work must not run");
};

test("Soul admission pins a scoped ready identity and confirmed price without trusting client provider handles", async () => scope("soul-admission", async service => {
  const { db } = await import("../../lib/db");
  const { soulIdentitiesReady } = await import("../../lib/soulIdentities");
  const { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
  const { SOUL_CHARACTER_MODEL_ID } = await import("../../lib/models");
  const { workbenchGenerationModels } = await import("../../lib/workbench/media-quote");
  const env = ["HF_SOUL_CHARACTER_ENABLED", "HF_SOUL_CHARACTER_USD_720P", "HF_SOUL_CHARACTER_USD_1080P"] as const;
  const before = env.map(key => process.env[key]);
  try {
    delete process.env.HF_SOUL_CHARACTER_ENABLED;
    expect(workbenchGenerationModels().some(model => model.id === SOUL_CHARACTER_MODEL_ID)).toBe(false);
    const body = { model: SOUL_CHARACTER_MODEL_ID, prompt: "Portrait in evening light", resolution: "720p", ratio: "3:4", projectId: "project", soulIdentityId: "soul_test", soulStrength: 0.65, refine: false };
    expect((await service.gen.prepareGeneration(body, actor)).ok).toBe(false);
    process.env.HF_SOUL_CHARACTER_ENABLED = "1";
    process.env.HF_SOUL_CHARACTER_USD_720P = "0.12";
    process.env.HF_SOUL_CHARACTER_USD_1080P = "0.24";
    expect(workbenchGenerationModels().some(model => model.id === SOUL_CHARACTER_MODEL_ID)).toBe(true);
    await soulIdentitiesReady();
    const providerId = "067e9e94-0bea-4acd-b82a-071a264d8e26";
    await db().execute({ sql: `INSERT INTO soul_identities(id,owner,production_project_id,name,description,subject_type,references_json,status,provider_reference_id,credential_fingerprint,settled_at,created_at,updated_at,consent_at) VALUES('soul_test','owner','project','Mira','','character','[]','ready',?,?,1,1,1,1)`, args: [providerId, higgsfieldCredentialFingerprint()] });
    const prepared = value(await service.gen.prepareGeneration({ ...body, soulReferenceId: "attacker-uuid", soulVendorCostUsd: 0, soulCredentialFingerprint: "attacker" }, actor));
    expect(prepared.compiled.params).toMatchObject({ soulIdentityId: "soul_test", soulReferenceId: providerId, soulStrength: 0.65, soulVendorCostUsd: 0.12, soulCredentialFingerprint: higgsfieldCredentialFingerprint() });
    const handler = route("generation", service);
    const response = await handler.POST(request("generate", body, "soul-same-request"));
    expect(response.status).toBe(200);
    const accepted = await response.json();
    const replay = await handler.POST(request("generate", body, "soul-same-request"));
    expect((await replay.json()).id).toBe(accepted.id);
    expect(dispatched).toHaveLength(1);
    expect((await meters()).filter(row => row.id === accepted.id)).toHaveLength(1);
    expect(JSON.parse(String((await rows())[0].params))).toMatchObject({ soulReferenceId: providerId, soulVendorCostUsd: 0.12 });
    for (const patch of [{ soulIdentityId: "other_workspace" }, { soulStrength: 5 }, { model: "gemini-3.1-flash-image", resolution: "1K" }]) {
      expect((await service.gen.prepareGeneration({ ...body, ...patch }, actor)).ok).toBe(false);
    }
    await db().execute("UPDATE soul_identities SET production_project_id='another-project' WHERE id='soul_test'");
    expect((await service.gen.prepareGeneration(body, actor)).ok).toBe(false);
  } finally { env.forEach((key, i) => { if (before[i] == null) delete process.env[key]; else process.env[key] = before[i]; }); }
}));
async function rows() {
  const { db } = await import("../../lib/db");
  return (await db().execute("SELECT * FROM generations ORDER BY id")).rows;
}
async function meters() {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  return (
    await platformDb().execute({
      sql: "SELECT * FROM meter_events WHERE workspace_id=?",
      args: [requireTenant().id],
    })
  ).rows;
}
function value(
  result: Awaited<
    ReturnType<typeof import("../../lib/generationAdmission").prepareGeneration>
  >,
): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
function route(
  kind: "generation" | "audio",
  service: ReturnType<typeof services>,
) {
  const file =
    kind === "generation"
      ? "app/api/generate/route.ts"
      : "app/api/audio/route.ts";
  return load<{ POST(req: Request): Promise<Response> }>(file, {
    "@/lib/auth": {
      withTenant: (handler: unknown) => handler,
      requireRender: async () => actor,
    },
    "@/lib/generationAdmission": service.gen,
    "@/lib/audioAdmission": service.audio,
    "next/server": { NextResponse: Response, after: noInline },
  });
}
function request(kind: string, body: unknown, key: string) {
  return new Request(`http://localhost/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

test("image, video and all audio tasks use the same route and pipeline price, compiled payload, reservation and dispatch", async () =>
  scope("parity", async (service) => {
    const inputs = [
      {
        kind: "generation",
        body: {
          model: "gemini-3.1-flash-image",
          prompt: "raw: A tree",
          projectId: "project",
          ratio: "16:9",
          resolution: "1K",
        },
      },
      {
        kind: "generation",
        body: {
          model: "dreamina-seedance-2-0-260128",
          prompt: "A tree in rain",
          projectId: "project",
          ratio: "16:9",
          resolution: "720p",
          duration: 5,
        },
      },
      {
        kind: "audio",
        body: {
          task: "speech",
          text: "Hello there",
          voiceId: "Abcdef1234",
          stability: 10,
          speed: 9,
          projectId: "project",
        },
      },
      {
        kind: "audio",
        body: {
          task: "sound",
          text: "Soft rain",
          durationSeconds: 60,
          loop: true,
          projectId: "project",
        },
      },
      {
        kind: "audio",
        body: {
          task: "music",
          text: "A quiet piano",
          lengthMs: 30000,
          instrumental: true,
          projectId: "project",
        },
      },
    ] as const;
    for (const [index, item] of inputs.entries()) {
      const prepare =
        item.kind === "audio"
          ? service.audio.prepareAudio
          : service.gen.prepareGeneration;
      const admit =
        item.kind === "audio"
          ? service.audio.admitAudio
          : service.gen.admitGeneration;
      const before = (await rows()).length;
      const prepared = value(await prepare(item.body, actor));
      expect((await rows()).length).toBe(before);
      expect((await meters()).length).toBe(before);
      expect(prepared.quote.unit).toBe("cr");
      expect(prepared.quote.estimatedCredits).toBeGreaterThan(0);
      const api = await route(item.kind, service).POST(
        request(item.kind, prepared.request, `api-parity-${index}`),
      );
      const apiBody = await api.json();
      expect(api.ok, JSON.stringify(apiBody)).toBe(true);
      const pipeline = await admit(prepared, actor, {
        requestKey: `pipeline-parity-${index}`,
        defer: noInline,
      });
      expect(pipeline.status, JSON.stringify(pipeline)).toBeLessThan(300);
      const both = (await rows()).filter((row) =>
        [apiBody.id, pipeline.body.id].includes(row.id),
      );
      expect(both).toHaveLength(2);
      const comparable = (row: (typeof both)[number]) => ({
        kind: row.kind,
        model: row.model,
        prompt: row.prompt,
        params: JSON.parse(String(row.params)),
        project: row.project_id,
        provider: row.provider,
        token: row.token_id,
        task: row.task,
      });
      expect(comparable(both[0])).toEqual(comparable(both[1]));
      const charges = (await meters()).filter((row) =>
        [apiBody.id, pipeline.body.id].includes(row.id),
      );
      expect(charges).toHaveLength(2);
      expect(charges.map((row) => Number(row.billed_credits))).toEqual([
        prepared.quote.estimatedCredits,
        prepared.quote.estimatedCredits,
      ]);
      const replay = await admit(prepared, actor, {
        requestKey: `pipeline-parity-${index}`,
        defer: noInline,
      });
      expect(replay.body.id).toBe(pipeline.body.id);
      expect(replay.headers?.["idempotency-replayed"]).toBe("true");
      expect((await rows()).length).toBe(before + 2);
    }
    expect(dispatched).toHaveLength(10);
    expect(dispatched.filter((item) => item.kind === "video")).toHaveLength(2);
  }));

test("cross-workspace sources, reference modes, shot ownership and approved credit ceilings are rejected before spending", async () =>
  scope("refusals", async (service) => {
    const cases: Record<string, unknown>[] = [
      { model: "unknown", prompt: "A scene" },
      {
        model: "dreamina-seedance-2-0-260128",
        prompt: "Scene",
        references: [{ uploadId: "other-workspace" }],
      },
      {
        model: "gemini-3.1-flash-image",
        prompt: "Scene",
        references: [{ genId: "missing" }],
      },
      {
        model: "dreamina-seedance-2-0-260128",
        prompt: "Scene",
        projectId: "elsewhere",
      },
      {
        model: "dreamina-seedance-2-0-260128",
        prompt: "Scene",
        shotId: "missing-shot",
      },
    ];
    for (const [index, body] of cases.entries()) {
      const prepared = await service.gen.prepareGeneration(body, actor);
      expect(prepared.ok).toBe(false);
      const api = await route("generation", service).POST(
        request("generate", body, `refused-request-${index}`),
      );
      if (!prepared.ok) expect(api.status).toBe(prepared.status);
    }
    const prepared = value(
      await service.gen.prepareGeneration(
        { model: "gemini-3.1-flash-image", prompt: "raw: Tree" },
        actor,
      ),
    );
    const over = await route("generation", service).POST(
      request(
        "generate",
        { ...prepared.request, maxCredits: 0 },
        "refused-max-credits",
      ),
    );
    expect(over.status).toBe(409);
    expect(await rows()).toHaveLength(0);
    expect(await meters()).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  }));

test("changed cast or concrete storage identity invalidates approval; actor changes cannot claim it", async () =>
  scope("frozen", async (service) => {
    const { db } = await import("../../lib/db");
    const { currentTenant, runInTenant } = await import("../../lib/tenant");
    await db().execute(
      "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('face','face','image/png','png',1,'hash','original-image','image',0)",
    );
    await db().execute(
      "INSERT INTO cast_members(id,project_id,name,kind,description,upload_id,created_at) VALUES('maya','project','Maya','character','Original description','face',0)",
    );
    const prepared = value(
      await service.gen.prepareGeneration(
        {
          model: "gemini-3.1-flash-image",
          prompt: "@Maya sits",
          projectId: "project",
        },
        actor,
      ),
    );
    await db().execute(
      "UPDATE cast_members SET description='Changed description' WHERE id='maya'",
    );
    const changed = await service.gen.admitGeneration(prepared, actor, {
      requestKey: "changed-cast-request",
      defer: noInline,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.quoteChanged).toBe(true);
    const refreshed = value(
      await service.gen.prepareGeneration(prepared.request, actor),
    );
    await db().execute(
      "UPDATE uploads SET stored_url='different-image' WHERE id='face'",
    );
    const changedSource = await service.gen.admitGeneration(refreshed, actor, {
      requestKey: "changed-source-request",
      defer: noInline,
    });
    expect(changedSource.status).toBe(409);
    expect(changedSource.body.quoteChanged).toBe(true);
    const other = { user: { ...actor.user, id: "other" } };
    const wrong = await runInTenant(
      currentTenant()!.workspace as TenantWorkspace,
      () =>
        service.gen.admitGeneration(prepared, other, {
          requestKey: "other-actor-request",
          defer: noInline,
        }),
      other,
    );
    expect(wrong.status).toBe(409);
    expect(await rows()).toHaveLength(0);
    expect(await meters()).toHaveLength(0);
  }));

test("audio free quote and read-only actors never create claims or jobs; uncertain admission retains its exact request identity", async () =>
  scope("audioquote", async (service) => {
    const { db } = await import("../../lib/db");
    const { runInTenant, currentTenant } = await import("../../lib/tenant");
    const body = { task: "sound", text: "Rain", quoteOnly: true };
    const quoted = await route("audio", service).POST(
      request("audio", body, "audio-quote-only"),
    );
    expect(quoted.status).toBe(200);
    expect((await quoted.json()).estimatedCredits).toBeGreaterThan(0);
    const readonly = {
      ...actor,
      token: { id: "read", name: "Read", scope: "read" as const, capUsd: null },
    };
    const rejected = await runInTenant(
      currentTenant()!.workspace!,
      () => service.audio.prepareAudio(body, readonly),
      readonly,
    );
    expect(rejected).toMatchObject({ ok: false, status: 403 });
    expect(await rows()).toHaveLength(0);
    expect(await meters()).toHaveLength(0);
    const { generationRequestsReady, withGenerationRequestData } =
      await import("../../lib/generationRequests");
    await generationRequestsReady();
    expect(
      (await db().execute("SELECT * FROM generation_requests")).rows,
    ).toHaveLength(0);
    let calls = 0;
    const input = {
      userId: actor.user.id,
      key: "uncertain-admission",
      fingerprint: "same",
    };
    const failure = await withGenerationRequestData(input, async () => {
      calls++;
      throw new Error("fixture interruption before job linkage");
    });
    expect(failure.status).toBe(503);
    const replay = await withGenerationRequestData(input, async () => {
      calls++;
      return Response.json({});
    });
    expect(replay.status).toBe(409);
    expect((await replay.json()).pending).toBe(true);
    expect(calls).toBe(1);
  }));

test("video-reference quotes use measured generated/upload durations and current server pricing; unknown or implausible source durations never submit", async () =>
  scope("video-prices", async (service) => {
    const { db } = await import("../../lib/db");
    const { estimateCostUsd } = await import("../../lib/vendorPricing");
    const { billCredits } = await import("../../lib/creditTerms");
    await db().batch(
      [
        "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES('clip','clip','video/mp4','mp4',1000,'hash','clip','video',3,0)",
        "INSERT INTO generations(id,kind,model,prompt,params,status,stored_url,created_at,updated_at) VALUES('prior','video','dreamina-seedance-2-5-260628','prior','{\"duration\":4}','succeeded','prior-clip',0,0)",
      ],
      "write",
    );
    const input = {
      model: "dreamina-seedance-2-5-260628",
      prompt: "raw: Same place",
      ratio: "16:9",
      resolution: "720p",
      duration: 5,
      generateAudio: true,
      references: [
        { uploadId: "clip", role: "reference_video" },
        { genId: "prior", role: "reference_video" },
      ],
    };
    const prepared = value(await service.gen.prepareGeneration(input, actor));
    const cost = estimateCostUsd(
      input.model,
      input.resolution,
      input.ratio,
      5,
      7,
      true,
      { audio: true, task: "generate", fps60: false },
    )!.net;
    expect(prepared.quote.estimatedCredits).toBe(
      billCredits(cost, input.model),
    );
    const accepted = await service.gen.admitGeneration(prepared, actor, {
      requestKey: "priced-video-input",
      defer: noInline,
    });
    expect(accepted.status).toBe(202);
    const row = (await rows()).find((row) => row.id === accepted.body.id)!;
    expect(JSON.parse(String(row.params))).toMatchObject({
      inputSeconds: 7,
      hasVideoInput: true,
      generateAudio: true,
    });
    const event = (await meters()).find(
      (event) => event.id === accepted.body.id,
    )!;
    expect(Number(event.engine_cost_usd)).toBe(cost);
    await db().execute("UPDATE uploads SET duration_s=NULL WHERE id='clip'");
    expect(await service.gen.prepareGeneration(input, actor)).toMatchObject({
      ok: false,
      status: 400,
    });
    await db().execute(
      "UPDATE uploads SET duration_s=1,bytes=200000000 WHERE id='clip'",
    );
    const impossible = await service.gen.prepareGeneration(
      {
        model: input.model,
        task: "edit",
        prompt: "Edit the source",
        sourceUploadId: "clip",
      },
      actor,
    );
    expect(impossible).toMatchObject({ ok: false, status: 400 });
    if (!impossible.ok)
      expect(impossible.body.error).toMatch(/length does not match/);
    expect(dispatched).toHaveLength(1);
  }));

test("Seedance edits price the actual source shape and length and reject stale quotes before admission", async () =>
  scope("edit-source-quote", async (service) => {
    const { db } = await import("../../lib/db");
    const { estimateCostUsd } = await import("../../lib/vendorPricing");
    const { billCredits } = await import("../../lib/creditTerms");
    await db().execute(
      "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,width,height,duration_s,created_at) VALUES('source','source.mp4','video/mp4','mp4',1000,'hash','source','video',1280,720,12.5,0)",
    );
    const body = {
      model: "dreamina-seedance-2-5-260628",
      task: "edit",
      prompt: "Edit @Video1: change the lighting",
      sourceUploadId: "source",
      resolution: "720p",
      duration: 4,
      ratio: "1:1",
      refine: false,
    };
    const prepared = value(await service.gen.prepareGeneration(body, actor));
    expect(prepared.compiled.params as Record<string, unknown>).toMatchObject({
      duration: 12.5,
      ratio: "1280:720",
      sourceSeconds: 12.5,
    });
    const cost = estimateCostUsd(
      body.model,
      "720p",
      "1280:720",
      12.5,
      12.5,
      true,
      { task: "edit", audio: false },
    )!.net;
    expect(prepared.quote.estimatedCredits).toBe(billCredits(cost, body.model));
    expect(await rows()).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    const quoted = {
      ...body,
      maxCredits: prepared.quote.estimatedCredits,
      quoteFingerprint: prepared.quote.fingerprint,
    };
    const changed = await route("generation", service).POST(
      request(
        "generate",
        { ...quoted, prompt: "Edit @Video1: replace the actor" },
        "changed-edit-quote",
      ),
    );
    expect(changed.status).toBe(409);
    expect(await rows()).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    const accepted = await route("generation", service).POST(
      request("generate", quoted, "approved-edit-quote"),
    );
    expect(accepted.status).toBe(202);
    const result = await accepted.json();
    const replay = await route("generation", service).POST(
      request("generate", quoted, "approved-edit-quote"),
    );
    expect((await replay.json()).id).toBe(result.id);
    expect(dispatched).toHaveLength(1);
    expect((await rows()).filter((row) => row.id === result.id)).toHaveLength(
      1,
    );
    await db().execute("UPDATE uploads SET width=NULL WHERE id='source'");
    expect(await service.gen.prepareGeneration(body, actor)).toMatchObject({
      ok: false,
      status: 400,
    });
  }));

test("Topaz prices the original image, retains settings for its worker and rejects oversized or changed work before spending", async () => scope("topaz-originals", async service => {
  const { db } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  const { DEFAULT_TOPAZ_IMAGE, TOPAZ_IMAGE_MODEL } = await import("../../lib/topaz");
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#456789" } }).png().toBuffer();
  const stored = await storeUpload("topaz-original", "png", bytes, "image/png");
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,kind,ext,bytes,sha256,width,height,stored_url,derivative_url,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)", args: ["topaz-original", "Original.png", "image/png", "image", "png", bytes.length, stored.sha256, 100, 100, stored.url, "/not-the-original.jpg"] });
  const body = { model: TOPAZ_IMAGE_MODEL, prompt: "", references: [{ uploadId: "topaz-original" }], topaz: { ...DEFAULT_TOPAZ_IMAGE, factor: 4 }, resolution: "24MP", projectId: "project" };
  const prepared = value(await service.gen.prepareGeneration(body, actor));
  expect(prepared.compiled).toMatchObject({ params: { resolution: "48MP", topazOutput: { width: 8000, height: 4000 }, topaz: { factor: 4, model: "High Fidelity V2", faceEnhancement: false } } });
  expect(prepared.quote.estimatedCredits).toBe(3);
  expect(await rows()).toHaveLength(0); expect(await meters()).toHaveLength(0);
  const rejected = await route("generation", service).POST(request("generate", { ...body, maxCredits: 2 }, "topaz-too-low"));
  expect(rejected.status).toBe(409); expect(dispatched).toHaveLength(0);
  const changed = await route("generation", service).POST(request("generate", { ...body, topaz: { ...body.topaz, model: "Standard V2" }, quoteFingerprint: prepared.quote.fingerprint }, "topaz-changed"));
  expect(changed.status).toBe(409); expect(dispatched).toHaveLength(0);
  for (const topaz of [{ ...body.topaz, factor: 8 }, { ...body.topaz, faceStrength: 2 }, { ...body.topaz, model: "Invented model" }]) {
    expect((await service.gen.prepareGeneration({ ...body, topaz }, actor)).ok).toBe(false);
  }
  const accepted = await route("generation", service).POST(request("generate", { ...body, maxCredits: 3, quoteFingerprint: prepared.quote.fingerprint }, "topaz-accepted"));
  expect(accepted.status, await accepted.text()).toBe(200);
  const saved = JSON.parse(String((await rows())[0].params));
  expect(saved.topaz).toEqual(body.topaz); expect(saved.resolution).toBe("48MP");
  expect(saved.references).toEqual([{ uploadId: "topaz-original", role: "reference_image", kind: "image" }]);
  expect(dispatched).toHaveLength(1);
}));

test("Topaz persists its queue handle, resumes after a lost polling attempt, and settles once under concurrent reconciliation", async () => scope("topaz-queue", async service => {
  const { db } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  const { DEFAULT_TOPAZ_IMAGE, TOPAZ_IMAGE_MODEL } = await import("../../lib/topaz");
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#254567" } }).png().toBuffer();
  const stored = await storeUpload("topaz-queued-original", "png", bytes, "image/png");
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,kind,ext,bytes,sha256,width,height,stored_url,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,0)", args: ["topaz-queued-original", "Source.png", "image/png", "image", "png", bytes.length, stored.sha256, 300, 300, stored.url] });
  const body = { model: TOPAZ_IMAGE_MODEL, prompt: "", references: [{ uploadId: "topaz-queued-original" }], topaz: DEFAULT_TOPAZ_IMAGE };
  const prepared = value(await service.gen.prepareGeneration(body, actor));
  const accepted = await route("generation", service).POST(request("generate", prepared.request, "topaz-queue-once"));
  expect(accepted.ok).toBe(true); const id = (await accepted.json()).id;
  const engineModule = await import("../../lib/engines");
  const fal = await import("../../lib/fal");
  const work = load<typeof import("../../lib/renderWork")>("lib/renderWork.ts", { "./engines": engineModule, "./fal": { ...fal, falAwait: async () => { throw new Error("Worker interrupted after queue acknowledgment"); } } });
  const job = await work.loadJob(id); expect(job?.kind).toBe("image");
  await expect(work.produce(job!)).resolves.toBeNull();
  const queued = JSON.parse(String((await rows())[0].params));
  expect(queued.falStillRequestId).toMatch(/^mock_fal_/);
  await expect(work.produce(job!)).resolves.toBeNull();
  expect(JSON.parse(String((await rows())[0].params)).falStillRequestId).toBe(queued.falStillRequestId);
  const polling = load<typeof work>("lib/renderWork.ts", { "./engines": engineModule, "./fal": { ...fal, falStatus: async () => { throw new Error("Interrupted poll"); } } });
  await expect(polling.reconcileTopazImage(id)).rejects.toThrow("Interrupted poll");
  expect((await rows())[0].status).toBe("running");
  expect((await meters())[0].status).toBe("running");
  const completed = load<typeof work>("lib/renderWork.ts", { "./engines": engineModule, "./fal": { ...fal, falStatus: async () => ({ status: "COMPLETED" }) } });
  await Promise.all([completed.reconcileTopazImage(id), completed.reconcileTopazImage(id), completed.reconcileTopazImage(id)]);
  const terminal = (await rows())[0]; expect(terminal.status).toBe("succeeded"); expect(Number(terminal.bytes)).toBeGreaterThan(0);
  expect((await meters()).filter(row => row.id === id)).toHaveLength(1);
  expect((await meters())[0].status).toBe("succeeded");
  const events = await db().execute("SELECT * FROM generation_settlements"); expect(events.rows).toHaveLength(1);
  await completed.reconcileTopazImage(id);
  expect(JSON.parse(String((await rows())[0].params)).falStillRequestId).toBe(queued.falStillRequestId);
}));

test("Astra quotes measured original bytes and explicit FPS, persists controls and refuses changed approvals", async () => scope("astra-original",async service=>{
  const {db}=await import("../../lib/db"),{storeUpload}=await import("../../lib/storage");
  const {ASTRA_MODEL,DEFAULT_ASTRA}=await import("../../lib/astra");
  const bytes=readFileSync("tests/fixtures/astra-source.mp4"),stored=await storeUpload("astra-clip","mp4",bytes,"video/mp4");
  await db().execute({sql:"INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,width,height,duration_s,created_at) VALUES('astra-clip','clip.mp4','video/mp4','mp4',?,'hash',?,'video',1,1,0.01,0)",args:[bytes.length,stored.url]});
  const body={model:ASTRA_MODEL,task:"upscale",sourceUploadId:"astra-clip",prompt:"",refine:false,resolution:"1080p",duration:.01,fps60:false,astra:{...DEFAULT_ASTRA,fps:60},astraSource:{seconds:.01,width:1,height:1}};
  const prepared=value(await service.gen.prepareGeneration(body,actor));
  expect(prepared.compiled.params).toMatchObject({resolution:"4k",duration:1.5,fps60:true,astra:{...DEFAULT_ASTRA,fps:60},astraSource:{width:720,height:1280,seconds:1.5}});
  expect(prepared.quote.estimatedCredits).toBe(23);
  const quoted={...body,maxCredits:prepared.quote.estimatedCredits,quoteFingerprint:prepared.quote.fingerprint};
  const changed=await route("generation",service).POST(request("generate",{...quoted,astra:{...body.astra,creativity:.8}},"changed-astra"));
  expect(changed.status).toBe(409);expect(await rows()).toHaveLength(0);
  const capped=await route("generation",service).POST(request("generate",{...body,maxCredits:1},"capped-astra"));
  expect(capped.status).toBe(409);expect(await rows()).toHaveLength(0);
  const accepted=await route("generation",service).POST(request("generate",quoted,"approved-astra"));
  const result=await accepted.json();expect(accepted.status,JSON.stringify(result)).toBe(202);
  const replay=await route("generation",service).POST(request("generate",quoted,"approved-astra"));
  expect((await replay.json()).id).toBe(result.id);expect(dispatched).toHaveLength(1);
  expect(JSON.parse(String((await rows())[0].params))).toMatchObject({astra:{...DEFAULT_ASTRA,fps:60},astraSource:{seconds:1.5,width:720,height:1280},sourceUploadId:"astra-clip"});
  expect(await service.gen.prepareGeneration({...body,astra:undefined},actor)).toMatchObject({ok:false,status:400});
  expect(await service.gen.prepareGeneration({...body,prompt:"Change the actor"},actor)).toMatchObject({ok:false,status:400});
}));

test("Astra reconciles measured output below its quote, leases collection and retains uncertain delivery without a second provider call",async()=>scope("astra-settle",async service=>{
  const {db}=await import("../../lib/db"),{storeUpload}=await import("../../lib/storage"),{ASTRA_MODEL,DEFAULT_ASTRA}=await import("../../lib/astra");
  const {getGeneration}=await import("../../lib/jobs"),{syncFalVideo}=await import("../../lib/falVideo"),{engineFor}=await import("../../lib/engines");
  const bytes=readFileSync("tests/fixtures/astra-source.mp4"),stored=await storeUpload("astra-result-source","mp4",bytes,"video/mp4");
  await db().execute({sql:"INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,created_at) VALUES('astra-result-source','clip.mp4','video/mp4','mp4',?,'hash',?,'video',0)",args:[bytes.length,stored.url]});
  const prepared=value(await service.gen.prepareGeneration({model:ASTRA_MODEL,task:"upscale",sourceUploadId:"astra-result-source",prompt:"",refine:false,astra:{...DEFAULT_ASTRA,fps:60}},actor));
  const response=await route("generation",service).POST(request("generate",prepared.request,"astra-settlement"));expect(response.status).toBe(202);const {id}=await response.json();
  await db().execute({sql:"UPDATE generations SET status='running',params=json_set(params,'$.falRequestId','known-astra','$.falModel',?,'$.paidClaim',1) WHERE id=?",args:[ASTRA_MODEL,id]});
  const engine=engineFor("fal"),original=engine.poll;let calls=0,release!:()=>void,entered!:()=>void;
  try{
    engine.poll=async()=>{calls++;throw new Error("Connection interrupted");};
    const gen=(await getGeneration(id))!;
    await expect(syncFalVideo(gen,{strict:true})).rejects.toThrow("Connection interrupted");
    expect((await rows())[0].status).toBe("running");expect(Number((await meters())[0].engine_cost_usd)).toBe(1.5);
    // A real, larger fixture would cost more than the approved 1.5-second request.
    engine.poll=async()=>{calls++;return {status:"succeeded",videoUrl:"fixture:clip.mp4",totalTokens:null,error:null,vendorStartedAt:null,vendorEndedAt:null,raw:{}};};
    await expect(syncFalVideo(gen,{strict:true})).rejects.toThrow(/exceeds the reviewed budget/);
    expect((await rows())[0].status).toBe("running");expect(Number((await meters())[0].engine_cost_usd)).toBe(1.5);
    const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
    engine.poll=async()=>{calls++;entered();await wait;return {status:"succeeded",videoUrl:"fixture:astra-clip.mp4",totalTokens:null,error:null,vendorStartedAt:null,vendorEndedAt:null,raw:{}};};
    const first=syncFalVideo(gen,{strict:true});await started;
    await syncFalVideo(gen,{strict:true});expect(calls).toBe(3);release();expect((await first).status).toBe("succeeded");
    const result=(await getGeneration(id))!;expect(result.params.astraOutput).toMatchObject({width:720,height:1280,seconds:1.5,fps:24});
    expect(result.params).toMatchObject({resolution:"720p",ratio:"720:1280",duration:1.5,astraQuotedOutput:{resolution:"4k",fps60:true}});
    const edit=await service.gen.prepareGeneration({model:"dreamina-seedance-2-5-260628",task:"edit",sourceGenId:id,prompt:"Edit the sky",refine:false},actor);
    expect(edit).toMatchObject({ok:false,status:400});if(!edit.ok)expect(edit.body.error).toMatch(/at least 4 seconds/);
    const reuse=value(await service.gen.prepareGeneration({model:ASTRA_MODEL,task:"upscale",sourceGenId:id,prompt:"",refine:false,astra:DEFAULT_ASTRA},actor));
    expect(reuse.compiled.params).toMatchObject({astraSource:{width:720,height:1280,seconds:1.5}});
    expect(Number((await meters())[0].engine_cost_usd)).toBeCloseTo(.45,8);expect((await meters())[0].billed_credits).toBe(7);
    await syncFalVideo(gen,{strict:true});expect(calls).toBe(3);expect((await db().execute("SELECT * FROM generation_settlements")).rows).toHaveLength(1);
  }finally{release?.();engine.poll=original;}
}));
