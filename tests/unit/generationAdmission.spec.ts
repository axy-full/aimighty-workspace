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
