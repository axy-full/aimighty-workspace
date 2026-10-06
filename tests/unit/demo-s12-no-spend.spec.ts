import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";
import { SAMPLE_LINE, SAMPLE_SETTING_KEY } from "../../lib/demo/sample";

/**
 * S12.4 (money path, for the owner's review): nothing paid is reachable on the sample production.
 *
 * A job filed under the production the workspace marked as the sample is refused by the server, whoever asks (a
 * person, Atomik's `agent:` identity, a render token) and by whichever door: the generate and audio routes, the
 * pipeline's own admission, and the reservation every platform-paid job passes (so a door that skips admission still
 * stops there). Nothing is held, reserved, written or dispatched. A quote still answers, a production that is not the
 * sample is untouched, another workspace is untouched, and an undone mark spends as before.
 */
const dir = mkdtempSync(path.join(tmpdir(), "demo-s12-no-spend-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const person = (id: string, over: Partial<AdmissionActor["user"]> = {}): AdmissionActor["user"] =>
  ({ id, email: `${id}@example.invalid`, name: id, role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null, ...over });
const OWNER: AdmissionActor = { user: person("owner") };
const TOKEN: AdmissionActor = { user: person("owner"), token: { id: "tok_render", name: "an agent", scope: "render", capUsd: null } };
const AGENT: AdmissionActor = { user: person("agent:run_1") };

const nodeRequire = createRequire(path.resolve("package.json"));
let dispatched: { genId: string; kind: string }[] = [];
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/") ? nodeRequire(path.resolve(name.slice(2) + ".ts")) : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), name + ".ts")) : nodeRequire(name);
    },
    target, target.exports,
  );
  return target.exports as T;
}
function services() {
  const queue = { enqueueRender: async (genId: string, kind: string) => { dispatched.push({ genId, kind }); return true; } };
  return {
    gen: load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", { "@/lib/inngest": queue }),
    audio: load<typeof import("../../lib/audioAdmission")>("lib/audioAdmission.ts", { "@/lib/inngest": queue }),
  };
}
const noInline = () => { throw new Error("Durable dispatch acknowledged; inline work must not run"); };

/** A workspace of its own database, with `credits` (0 means none: the wall that parks a render as held) and a sample or not. */
async function scope(name: string, opts: { credits?: number; sample?: boolean | "hidden"; rawMark?: string }, fn: (loaded: ReturnType<typeof services>) => Promise<void>, actor: AdmissionActor = OWNER) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`],
  });
  const credits = opts.credits ?? 10000;
  if (credits > 0) await grantCredits(name, credits, "Test", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the no-spend test"); };
  dispatched = [];
  try {
    await runInTenant(ws, async () => {
      await ready();
      for (const [id, title] of [["film", "Film"], ["other", "Other"]]) await db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, title] });
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      for (const [id, project] of [["shot_film", "film"], ["shot_other", "other"]])
        await db().execute({ sql: `INSERT INTO shots (id,project_id,scene,code,title,description,status,position,created_by,created_at,updated_at,planned,setup,cast,kind,dirty) VALUES (?,?,?,?,?,?,'open',0,'owner',0,0,5,'{}','[]','render',1)`, args: [id, project, "", id, id, ""] });
      if (opts.sample) {
        const mark = { version: 1, projectId: "film", name: "Film", draftOwner: "owner", draftId: "d1", markedBy: "owner", markedAt: 1, ...(opts.sample === "hidden" ? { hiddenAt: 2 } : {}) };
        await db().execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)", args: [SAMPLE_SETTING_KEY, JSON.stringify(mark), "owner", 1] });
      }
      /* A stored mark exactly as given, readable or not. */
      if (opts.rawMark !== undefined)
        await db().execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)", args: [SAMPLE_SETTING_KEY, opts.rawMark, "owner", 1] });
      await fn(services());
    }, actor);
  } finally { globalThis.fetch = original; }
}

async function rows() { const { db } = await import("../../lib/db"); return (await db().execute("SELECT * FROM generations ORDER BY id")).rows; }
async function meters() {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  return (await platformDb().execute({ sql: "SELECT * FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows;
}
function route(kind: "generation" | "audio", service: ReturnType<typeof services>, actor: AdmissionActor) {
  return load<{ POST(req: Request): Promise<Response> }>(kind === "generation" ? "app/api/generate/route.ts" : "app/api/audio/route.ts", {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireRender: async () => actor },
    "@/lib/generationAdmission": service.gen, "@/lib/audioAdmission": service.audio,
    "next/server": { NextResponse: Response, after: noInline },
  });
}
const request = (kind: string, body: unknown, key: string) => new Request(`http://localhost/api/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });

const video = (extra: Record<string, unknown>) => ({ model: "dreamina-seedance-2-0-260128", prompt: "A tree in rain", ratio: "16:9", resolution: "720p", duration: 5, ...extra });
const sound = (extra: Record<string, unknown>) => ({ task: "sound", text: "Soft rain", durationSeconds: 5, ...extra });
const still = (extra: Record<string, unknown>) => ({ model: "gemini-3.1-flash-image", prompt: "raw: A tree", ratio: "16:9", resolution: "1K", ...extra });

let n = 0;
const name = (what: string) => `no-spend-${what}-${++n}`;

test("a render, a still and a sound filed under the sample are refused with its line; the same on another production are accepted", async () => {
  await scope(name("doors"), { sample: true }, async (service) => {
    let key = 0;
    for (const [kind, make] of [["generation", video], ["generation", still], ["audio", sound]] as const) {
      const before = { rows: (await rows()).length, meters: (await meters()).length, sent: dispatched.length };
      const refused = await route(kind, service, OWNER).POST(request(kind, make({ projectId: "film" }), `request-film-${key++}`));
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toBe(SAMPLE_LINE);
      /* Nothing was written, reserved or sent. */
      expect({ rows: (await rows()).length, meters: (await meters()).length, sent: dispatched.length }).toEqual(before);
      const accepted = await route(kind, service, OWNER).POST(request(kind, make({ projectId: "other" }), `request-other-${key++}`));
      expect(accepted.status, await accepted.clone().text()).toBeLessThan(300);
    }
    expect(dispatched).toHaveLength(3);
  });
});

test("by a shot alone, by a shot under the sample that names another project, and for a person, Atomik's identity and a token alike", async () => {
  for (const [who, actor] of [["person", OWNER], ["token", TOKEN], ["agent", AGENT]] as const)
    await scope(name(who), { sample: true }, async (service) => {
      const body = video({ shotId: "shot_film" });
      const refused = await route("generation", service, actor).POST(request("generation", body, "request-by-shot"));
      expect(refused.status, who).toBe(409);
      expect((await refused.json()).error).toBe(SAMPLE_LINE);
      const mixed = await route("generation", service, actor).POST(request("generation", video({ projectId: "other", shotId: "shot_film" }), "request-mixed"));
      expect([mixed.status, (await mixed.json()).error]).toEqual([409, SAMPLE_LINE]);
      const audio = await route("audio", service, actor).POST(request("audio", sound({ shotId: "shot_film" }), "request-audio-shot"));
      expect(audio.status).toBe(409);
      expect((await audio.json()).error).toBe(SAMPLE_LINE);
      expect(await rows()).toHaveLength(0);
      expect(await meters()).toHaveLength(0);
      expect(dispatched).toEqual([]);
    }, actor);
});

test("a quote on the sample still answers, but the pipeline's admission of that quote is refused", async () => {
  await scope(name("quote"), { sample: true }, async (service) => {
    for (const [prepare, admit, body] of [
      [service.gen.prepareGeneration, service.gen.admitGeneration, video({ projectId: "film" })],
      [service.audio.prepareAudio, service.audio.admitAudio, sound({ projectId: "film" })],
    ] as const) {
      const prepared = await prepare(body, OWNER);
      expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.value.quote.estimatedCredits).toBeGreaterThan(0);
      const admitted = await admit(prepared.value, OWNER, { requestKey: `pipeline-${prepared.value.kind}`, defer: noInline });
      expect(admitted.status).toBe(409);
      expect(admitted.body.error).toBe(SAMPLE_LINE);
    }
    expect(await rows()).toHaveLength(0);
    expect(await meters()).toHaveLength(0);
  });
});

test("with no credits a render on the sample is refused, never parked as held to start when credits arrive", async () => {
  await scope(name("held"), { sample: true, credits: 0 }, async (service) => {
    const refused = await route("generation", service, OWNER).POST(request("generation", video({ projectId: "film" }), "request-no-credits"));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe(SAMPLE_LINE);
    expect(await rows()).toHaveLength(0);
    /* Another production, same wallet: parked as held, as before (nothing here changed that). */
    const parked = await route("generation", service, OWNER).POST(request("generation", video({ projectId: "other" }), "request-no-credits-other"));
    expect(parked.status).toBe(202);
    expect((await rows()).map((r) => r.status)).toEqual(["held"]);
  });
});

test("the reservation itself refuses the sample, for any caller that skips admission, and reserves nothing", async () => {
  await scope(name("reserve"), { sample: true }, async () => {
    const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
    const event = (id: string, extra: Record<string, unknown>) => ({ id, kind: "text" as const, engine: "vercel", model: "m", status: "running" as const, engineCostUsd: 0.01, createdBy: "owner", ...extra });
    for (const [id, extra, opts] of [
      ["by-project", { projectId: "film" }, {}],
      ["request-by-shot", { shotId: "shot_film" }, {}],
      ["by-option", {}, { projectId: "film" }],
    ] as const) {
      const error = await reserveGenerationSpend(event(id, extra), opts).then(() => null, (e) => e);
      expect(error, id).toBeInstanceOf(SpendReservationError);
      expect(error).toMatchObject({ status: 409, message: SAMPLE_LINE, perJob: true });
    }
    expect(await meters()).toHaveLength(0);
    /* Another production reserves. */
    await reserveGenerationSpend(event("elsewhere", { projectId: "other" }));
    expect((await meters()).map((m) => String(m.id))).toEqual(["elsewhere"]);
  });
});

test("nothing is refused where there is no sample: none marked, the mark undone, another workspace's mark, a job with no production", async () => {
  await scope(name("none"), {}, async (service) => {
    const ok = await route("generation", service, OWNER).POST(request("generation", video({ projectId: "film" }), "request-no-mark"));
    expect(ok.status).toBeLessThan(300);
  });
  await scope(name("hidden"), { sample: "hidden" }, async (service) => {
    const ok = await route("generation", service, OWNER).POST(request("generation", video({ projectId: "film" }), "request-hidden"));
    expect(ok.status).toBeLessThan(300);
  });
  /* A workspace has its own database: another workspace's mark of a production of the same id changes nothing here. */
  await scope(name("marked-elsewhere"), { sample: true }, async () => {});
  await scope(name("request-neighbour"), {}, async (service) => {
    const ok = await route("generation", service, OWNER).POST(request("generation", video({ projectId: "film" }), "request-neighbour"));
    expect(ok.status).toBeLessThan(300);
  });
  await scope(name("request-unfiled"), { sample: true }, async (service) => {
    const ok = await route("generation", service, OWNER).POST(request("generation", video({}), "request-unfiled"));
    expect(ok.status).toBeLessThan(300);
  });
});

test("a mark that is present but cannot be read fails closed: never read as no sample", async () => {
  const { sampleSpendRefusal } = await import("../../lib/demo/spend-guard.server");
  const { reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
  const event = (id: string, extra: Record<string, unknown>) => ({ id, kind: "text" as const, engine: "vercel", model: "m", status: "running" as const, engineCostUsd: 0.01, createdBy: "owner", ...extra });
  /* Unreadable, or naming no production: nobody can tell which production is the sample, so no paid job is admitted, filed or not. */
  for (const raw of ["{not json", "null", "[]", "\"film\"", JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, projectId: 7, draftOwner: "owner", draftId: "d1" })])
    await scope(name("unreadable"), { rawMark: raw }, async (service) => {
      for (const [projectId, shotId] of [["film", null], ["other", null], [null, "shot_other"], [null, null]] as const)
        expect(await sampleSpendRefusal(projectId, shotId), `${raw} ${projectId} ${shotId}`).toBe(SAMPLE_LINE);
      for (const projectId of ["film", "other"]) {
        const refused = await route("generation", service, OWNER).POST(request("generation", video({ projectId }), `request-unreadable-${projectId}`));
        expect(refused.status, raw).toBe(409);
        expect((await refused.json()).error).toBe(SAMPLE_LINE);
      }
      const error = await reserveGenerationSpend(event("unreadable", { projectId: "other" })).then(() => null, (e) => e);
      expect(error, raw).toBeInstanceOf(SpendReservationError);
      expect(error).toMatchObject({ status: 409, message: SAMPLE_LINE });
      expect(await rows()).toHaveLength(0);
      expect(await meters()).toHaveLength(0);
      expect(dispatched).toEqual([]);
    });
  /* The wrong shape (another version, fields missing) that still names its production: that production is the sample. */
  for (const mark of [
    { version: 2, projectId: "film", name: "Film", draftOwner: "owner", draftId: "d1", markedBy: "owner", markedAt: 1 },
    { version: 1, projectId: "film" },
  ])
    await scope(name("misshapen"), { rawMark: JSON.stringify(mark) }, async (service) => {
      expect(await sampleSpendRefusal("film")).toBe(SAMPLE_LINE);
      expect(await sampleSpendRefusal(null, "shot_film")).toBe(SAMPLE_LINE);
      const refused = await route("generation", service, OWNER).POST(request("generation", video({ projectId: "film" }), "request-misshapen"));
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toBe(SAMPLE_LINE);
      expect(await rows()).toHaveLength(0);
      const other = await route("generation", service, OWNER).POST(request("generation", video({ projectId: "other" }), "request-misshapen-other"));
      expect(other.status, await other.clone().text()).toBeLessThan(300);
    });
  /* An undone mark, whatever else its shape, is no sample: it spends as before. */
  await scope(name("misshapen-hidden"), { rawMark: JSON.stringify({ version: 2, projectId: "film", hiddenAt: 5 }) }, async (service) => {
    expect(await sampleSpendRefusal("film")).toBeNull();
    const ok = await route("generation", service, OWNER).POST(request("generation", video({ projectId: "film" }), "request-misshapen-hidden"));
    expect(ok.status).toBeLessThan(300);
  });
});

test("Transcribe on the sample is refused as a conflict (409) in the sample's words, never 402; the press shows that line, with nothing to top up", async () => {
  let answer: { status: number; body: string; complete: string | null } | null = null;
  await scope(name("transcribe"), { sample: true }, async () => {
    const { db } = await import("../../lib/db");
    await db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,?,?,?,0)",
      args: ["up_line", "line.wav", "audio/wav", "wav", 1000, "sha", "/api/uploads/up_line", "audio", 30],
    });
    const { withGenerationRequest } = await import("../../lib/generationRequests");
    const { transcribe } = await import("../../lib/transcription");
    let calls = 0;
    const deps = { readSource: async () => Buffer.from("audio"), provider: async (): Promise<never> => { calls++; throw new Error("The provider must not be reached"); } };
    /* The quote still answers. */
    const quote = await transcribe({ sourceUploadId: "up_line", projectId: "film", diarize: true, quoteOnly: true }, "owner");
    expect(quote.status).toBe(200);
    /* As the route composes it: the claim, then the transcription inside it. */
    const body = { sourceUploadId: "up_line", projectId: "film", diarize: true, maxCredits: 100000 };
    const req = new Request("http://localhost/api/audio/transcribe", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "request-transcribe-sample" }, body: JSON.stringify(body) });
    const refused = await withGenerationRequest(req, "owner", async (claim) => {
      const reply = await transcribe(body, "owner", { claim, deps });
      return Response.json(reply.body, { status: reply.status });
    });
    expect(refused.status).toBe(409);
    expect(await refused.clone().json()).toEqual({ error: SAMPLE_LINE, charged: 0 });
    expect(calls).toBe(0);
    expect(await meters()).toHaveLength(0);
    answer = { status: refused.status, body: await refused.text(), complete: refused.headers.get("Idempotency-Status") };
  });
  /* The browser's press, answered exactly so: the sample's line, final, with no new price to approve. */
  const { sendTranscription } = await import("../../lib/workbench/transcription-request");
  const items = new Map<string, string>();
  const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(answer!.body, {
    status: answer!.status, headers: { "Content-Type": "application/json", ...(answer!.complete ? { "Idempotency-Status": answer!.complete } : {}) },
  })) as typeof fetch;
  try {
    const outcome = await sendTranscription({ scope: "particl-active-ws_unit-owner", slot: "transcribe-sample", body: { sourceUploadId: "up_line", projectId: "film", diarize: true, maxCredits: 3 }, credits: 3, storage, locks: null });
    expect(outcome).toEqual({ state: "released", reason: SAMPLE_LINE, failed: true });
  } finally { globalThis.fetch = original; }
  /* The Transcribe panel shows a released press's reason as its alert, and offers no top-up. */
  expect(readFileSync("components/graphite/production/TranscribePanel.tsx", "utf8")).not.toMatch(/top.?up/i);
});
