import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";
import type { TenantToken, TenantWorkspace } from "../../lib/tenant";

/**
 * Owner, 21 Oct 2026, 22:15 IST: "a person's audio or dubbing press carries the figure that was on its button, like the Director
 * press (#860)." Every job is approved on its quote by the person pressing it (lib/pressFigure.ts).
 *
 *  - A person's sound or dub press without the figure is refused (409, figure_required) before its key is claimed, and again in
 *    admission on any other path, with nothing filed, held, reserved or sent.
 *  - With the figure that was on its button it runs, reserved and billed at no more than that figure.
 *  - A figure under today's price is a moved price: refused (409, price_moved) with the new figure, nothing filed; pressed again
 *    at the new figure, it runs.
 *  - A token or an MCP client is held as #854 holds it, unchanged.
 *  - Every client that presses a sound or a dub sends the figure that was on its button.
 *
 * No paid call: ENGINE_MOCK, a queue that only records, a fake dubbing vendor and the network refused. Every figure is the server's
 * own quote, or a synthetic one made up here and named as such.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-audio-press-figure-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const person: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const tokenActor = (token: Partial<TenantToken>): AdmissionActor => ({ ...person, token: { id: "tok_agent", name: "Agent", scope: "render", capUsd: null, capCredits: null, ...token } });
/** A synthetic token ceiling, far above any one take. */
const ROOMY = 100_000;
const SFX = { task: "sound", text: "Rain on a tin roof, distant thunder.", durationSeconds: 4, projectId: "project" };
/** Not a figure: absent, empty, a string, a fraction, a negative. */
const NOT_A_FIGURE: unknown[] = [undefined, null, "12", 1.5, -1];

const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/")
        ? nodeRequire(path.resolve(name.slice(2)))
        : name.startsWith(".")
          ? nodeRequire(path.resolve(path.dirname(file), name))
          : nodeRequire(name);
    },
    target,
    target.exports,
  );
  return target.exports as T;
}

/** Every hand-off to a vendor's worker: a sound to the render queue, a dub to its own. */
let dispatched: string[] = [];
const noInline = () => { throw new Error("Durable dispatch acknowledged; inline work must not run"); };
type Handler = { POST(req: Request): Promise<Response> };
type Doors = {
  ws: TenantWorkspace;
  audio: Handler;
  dub: Handler;
  audioAdmission: typeof import("../../lib/audioAdmission");
  dubbing: typeof import("../../lib/dubbing");
  /** A stored audio original with a measured length (150 s), for a dub. */
  source: string;
};

const UPLOADS = path.join(process.cwd(), ".data", "uploads");
const GENERATIONS = path.join(process.cwd(), ".data", "generations");
const stamp = `figure${Date.now().toString(36)}`;
const written: string[] = [];
test.afterAll(() => { for (const file of written) rmSync(file, { force: true }); });

async function newWorkspace(name: string): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { alignLedgerUnit } = await import("../helpers/ledgerUnit");
  await platformReady();
  await alignLedgerUnit();
  const id = `apf-${name}-${randomUUID().slice(0, 8)}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  await grantCredits(id, 10_000, "Test", "owner", "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
}

async function doors(name: string, who: AdmissionActor, fn: (d: Doors) => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  const ws = await newWorkspace(name);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the press figure test"); };
  dispatched = [];
  try {
    await runInTenant(ws, async () => {
      await ready();
      await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
      await db().execute("DELETE FROM settings WHERE key='sampleProduction'");
      if (who.token) await db().execute("INSERT INTO users(id,email,name,password_hash,created_at) VALUES('owner','owner@example.invalid','Owner','x',0) ON CONFLICT(id) DO NOTHING");
      /* The source a dub is made from: the fixture tone on disk, its length recorded. */
      const source = `${stamp}-${name}`;
      const tone = readFileSync(path.resolve("public/fixtures/tone.mp3"));
      mkdirSync(UPLOADS, { recursive: true });
      const file = path.join(UPLOADS, `${source}.mp3`);
      writeFileSync(file, tone);
      written.push(file);
      await db().execute({
        sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        args: [source, "Interview.mp3", "audio/mpeg", "mp3", tone.length, "x", `/api/uploads/${source}`, "audio", 150, Date.now()],
      });
      const audioAdmission = load<typeof import("../../lib/audioAdmission")>("lib/audioAdmission.ts", {
        "@/lib/inngest": { enqueueRender: async (genId: string) => { dispatched.push(genId); return true; } },
      });
      const dubbing = load<typeof import("../../lib/dubbing")>("lib/dubbing.ts", {
        "./inngest": { EVENTS: { dubbing: "audio/dubbing.requested" }, queueSender: () => async (event: { data: { jobId: string } }) => { dispatched.push(event.data.jobId); } },
      });
      const auth = { withTenant: (handler: unknown) => handler, requireRender: async () => who };
      const server = { NextResponse: Response, after: noInline };
      await fn({
        ws, source, audioAdmission, dubbing,
        audio: load<Handler>("app/api/audio/route.ts", { "@/lib/auth": auth, "@/lib/audioAdmission": audioAdmission, "next/server": server }),
        dub: load<Handler>("app/api/audio/dub/route.ts", { "@/lib/auth": auth, "@/lib/dubbing": dubbing, "next/server": server }),
      });
    }, { user: who.user, ...(who.token ? { token: who.token } : {}) });
  } finally {
    globalThis.fetch = fetch;
  }
}

const post = (route: string, body: unknown, key?: string) => new Request(`http://localhost${route}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body),
});
const dubBody = (d: Doors) => ({ sourceUploadId: d.source, sourceLang: "en", targetLang: "es", mode: "v1", projectId: "project" });
/** The two presses: a sound effect (POST /api/audio) and a dub (POST /api/audio/dub), each with its route and body. */
const presses = (d: Doors) => [
  { label: "a sound", door: d.audio, route: "/api/audio", body: SFX as Record<string, unknown> },
  { label: "a dub", door: d.dub, route: "/api/audio/dub", body: dubBody(d) as Record<string, unknown> },
];
async function quoted(door: Handler, route: string, body: Record<string, unknown>) {
  const res = await door.POST(post(route, { ...body, quoteOnly: true }));
  const answer = await res.json();
  expect(res.status, `the quote answers: ${JSON.stringify(answer)}`).toBe(200);
  expect(answer.unit).toBe("cr");
  expect(answer.price).toBe(answer.estimatedCredits);
  return answer.estimatedCredits as number;
}

/** Everything a press could leave behind: its claim, its take, its dub job, its meter row (the reservation), a hand-off to a vendor. */
async function traces() {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  const count = async (sql: string, args: unknown[] = []) => Number((await db().execute({ sql, args: args as never })).rows[0]?.n ?? 0);
  const rows = async (table: string) => (await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?", [table])) ? count(`SELECT COUNT(*) AS n FROM ${table}`) : 0;
  return {
    claims: await rows("generation_requests"),
    generations: await count("SELECT COUNT(*) AS n FROM generations"),
    dubs: await rows("dubbing_jobs"),
    meters: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows[0].n),
    dispatched: dispatched.length,
  };
}
const NOTHING = { claims: 0, generations: 0, dubs: 0, meters: 0, dispatched: 0 };
async function meterRow(id: string) {
  const { platformDb } = await import("../../lib/platform");
  const row = (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows[0];
  return row ? { status: String(row.status), credits: Number(row.billed_credits) } : null;
}
async function balance(id: string) {
  const { billingStateFor } = await import("../../lib/billingLedger");
  return (await billingStateFor(id)).credits.balance;
}

test("the rule in one place: a whole number of credits is a figure; without one a press is refused in plain words, nothing charged; a moved price names the new figure", async () => {
  const { pressFigure, pressFigureProblem, pressFigureRefusal, movedPriceBody, PRESS_WITHOUT_FIGURE, FIGURE_REQUIRED, PRICE_MOVED } = await import("../../lib/pressFigure");
  for (const figure of [0, 7, 43]) {
    expect(pressFigure(figure)).toBe(figure);
    expect(pressFigureProblem(figure)).toBeNull();
    expect(pressFigureRefusal(figure)).toBeNull();
  }
  for (const figure of NOT_A_FIGURE) {
    expect(pressFigure(figure), String(figure)).toBeNull();
    expect(pressFigureProblem(figure), String(figure)).toEqual({ status: 409, body: { error: PRESS_WITHOUT_FIGURE, code: FIGURE_REQUIRED, charged: 0 } });
    const refused = pressFigureRefusal(figure)!;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: PRESS_WITHOUT_FIGURE, code: FIGURE_REQUIRED, charged: 0 });
  }
  expect(PRESS_WITHOUT_FIGURE).toBe("Press again at the price shown. This press did not carry the price on its button, so nothing was started or charged.");
  expect(movedPriceBody({ estimatedCredits: 1234, price: 1234, unit: "cr" })).toEqual({
    error: "The price is now 1,234 cr. Press again to approve it.", code: PRICE_MOVED, quoteChanged: true, estimatedCredits: 1234, price: 1234, unit: "cr", charged: 0,
  });
  /* A workspace on its own keys is quoted in its own vendors' dollars, and told the new figure in them. */
  expect(movedPriceBody({ estimatedCredits: 3, price: 0.25, unit: "usd" }).error).toBe("The price is now US$0.25. Press again to approve it.");
});

test("a person's sound or dub press without the figure on its button is refused before its key is claimed: nothing filed, held, reserved or sent", async () =>
  doors("missing", person, async (d) => {
    for (const { label, door, route, body } of presses(d)) {
      /* Asking the price is free, and still answers. */
      expect(await quoted(door, route, body), label).toBeGreaterThan(0);
      for (const figure of NOT_A_FIGURE) {
        const res = await door.POST(post(route, { ...body, maxCredits: figure }, `missing-${randomUUID()}`));
        const answer = await res.json();
        expect(res.status, `${label}, ${String(figure)}: ${JSON.stringify(answer)}`).toBe(409);
        expect(answer, `${label}, ${String(figure)}`).toMatchObject({ code: "figure_required", charged: 0, error: expect.stringMatching(/^Press again at the price shown\./) });
      }
    }
    expect(await traces()).toEqual(NOTHING);
  }));

test("whatever path reaches admission, a press without the figure is refused there before anything is filed, held, reserved or sent", async () =>
  doors("backstop", person, async (d) => {
    const execs = [
      { label: "a sound", run: d.audioAdmission.executeAudioAdmission, body: SFX as Record<string, unknown> },
      { label: "a dub", run: d.dubbing.executeDubbingAdmission, body: dubBody(d) as Record<string, unknown> },
    ];
    for (const { label, run, body } of execs)
      for (const figure of NOT_A_FIGURE)
        for (const claimed of [true, false]) {
          const reply = await run({ ...body, maxCredits: figure }, person, { defer: noInline, ...(claimed ? { requestClaim: { userId: "owner", key: `backstop-${randomUUID()}` } } : {}) });
          expect(reply.status, `${label}, ${String(figure)}, ${claimed ? "claimed" : "direct"}: ${JSON.stringify(reply.body)}`).toBe(409);
          expect(reply.body, label).toMatchObject({ code: "figure_required", charged: 0 });
        }
    expect(await traces()).toEqual(NOTHING);
  }));

test("a sound pressed with the figure on its button is reserved at it (under the mock, where the report equals the quote, settled at no more); a higher figure is held to the quote", async () =>
  doors("sound", person, async (d) => {
    const { loadJob, produce, seal } = await import("../../lib/renderWork");
    const shown = await quoted(d.audio, "/api/audio", SFX);
    const before = await balance(d.ws.id);
    const res = await d.audio.POST(post("/api/audio", { ...SFX, maxCredits: shown }, `sound-${randomUUID()}`));
    const made = await res.json();
    expect(res.status, JSON.stringify(made)).toBe(200);
    expect(made).toMatchObject({ status: "running", estimatedCredits: shown });
    expect(dispatched).toEqual([made.id]);
    expect(await meterRow(made.id), "reserved at the figure shown").toEqual({ status: "running", credits: shown });
    /* The take records what it was quoted at and the figure approved. */
    const { db } = await import("../../lib/db");
    const params = JSON.parse(String((await db().execute({ sql: "SELECT params FROM generations WHERE id=?", args: [made.id] })).rows[0].params));
    expect(params.quote).toEqual({ credits: shown, maxCredits: shown });
    /* The mocked engine renders it; settled, it is billed no more than the figure shown. This holds under the mock only, where the vendor's report
       equals the quote: a sound still settles at what the vendor reports, and capping it at the figure is a separate PR (owner, 22 Oct 2026). */
    const job = (await loadJob(made.id))!;
    const out = (await produce(job))!;
    written.push(path.join(GENERATIONS, `${made.id}.mp3`));
    await seal(job, out);
    const settled = (await meterRow(made.id))!;
    expect(settled.status).toBe("succeeded");
    expect(settled.credits).toBeLessThanOrEqual(shown);
    expect(before - (await balance(d.ws.id))).toBeLessThanOrEqual(shown);

    /* A figure above the price is the person's ceiling: the take is still reserved at its quote, never at the higher figure. */
    const roomy = await d.audio.POST(post("/api/audio", { ...SFX, text: "Wind over dunes.", maxCredits: shown + 5 }, `sound-roomy-${randomUUID()}`));
    const roomyMade = await roomy.json();
    expect(roomy.status, JSON.stringify(roomyMade)).toBe(200);
    expect(await meterRow(roomyMade.id)).toEqual({ status: "running", credits: shown });
  }));

test("a dub pressed with the figure on its button runs at it and is settled at no more than it", async () =>
  doors("dub", person, async (d) => {
    const body = dubBody(d);
    const shown = await quoted(d.dub, "/api/audio/dub", body);
    const before = await balance(d.ws.id);
    const res = await d.dub.POST(post("/api/audio/dub", { ...body, maxCredits: shown }, `dub-${randomUUID()}`));
    const made = await res.json();
    expect(res.status, JSON.stringify(made)).toBe(200);
    expect(made).toMatchObject({ status: "running", estimatedCredits: shown });
    expect(dispatched).toEqual([made.jobId]);
    expect(await meterRow(made.id)).toEqual({ status: "running", credits: shown });
    /* A fake vendor: submitted once, dubbed, downloaded and stored; the job settles on its reservation. */
    const deps = {
      submit: async () => ({ dubbingId: "dub-vendor-figure", expectedDurationSec: 150 }),
      status: async () => ({ status: "dubbed" as const, error: null, targetLanguages: ["es"] }),
      download: async () => ({ bytes: Buffer.from("ID3dubbed"), mime: "audio/mpeg" }),
      store: async (id: string, bytes: Buffer) => ({ url: `/api/media/${id}`, bytes: bytes.length }),
    };
    await d.dubbing.advanceDubbingJob(made.jobId, deps);
    expect((await d.dubbing.dubbingJob(made.jobId))?.status).toBe("dubbed");
    const settled = (await meterRow(made.id))!;
    expect(settled.status).toBe("succeeded");
    expect(settled.credits).toBeLessThanOrEqual(shown);
    expect(before - (await balance(d.ws.id))).toBeLessThanOrEqual(shown);
  }));

test("a figure under today's price is a moved price: refused with the new figure, nothing filed, held, reserved or sent; pressed again at it, it runs", async () =>
  doors("moved", person, async (d) => {
    for (const { label, door, route, body } of presses(d)) {
      const now = await quoted(door, route, body);
      const before = await traces();
      /* The button showed a figure a credit under today's price (synthetic: the price moved by one). */
      const res = await door.POST(post(route, { ...body, maxCredits: now - 1 }, `moved-${randomUUID()}`));
      const answer = await res.json();
      expect(res.status, `${label}: ${JSON.stringify(answer)}`).toBe(409);
      expect(answer, label).toEqual({
        error: `The price is now ${now.toLocaleString("en-US")} cr. Press again to approve it.`,
        code: "price_moved", quoteChanged: true, estimatedCredits: now, price: now, unit: "cr", charged: 0,
      });
      /* Refused inside its own claim (so asking again says it was refused), with no take, dub job, reservation or hand-off. */
      const after = await traces();
      expect({ ...after, claims: after.claims - before.claims }, label).toEqual({ ...before, claims: 1 });
      /* Pressed again at the figure it was told: it runs, reserved at that figure. */
      const again = await door.POST(post(route, { ...body, maxCredits: answer.estimatedCredits }, `moved-again-${randomUUID()}`));
      const made = await again.json();
      expect(again.status, `${label}: ${JSON.stringify(made)}`).toBe(200);
      expect(await meterRow(made.id), label).toEqual({ status: "running", credits: now });
    }
  }));

test("a token or an MCP client is held as before (#854): no ceiling only prices, a ceiling without its quote is refused, with its quote it runs", async () => {
  await doors("token-none", tokenActor({}), async (d) => {
    for (const { label, door, route, body } of presses(d)) {
      const shown = await quoted(door, route, body);
      const res = await door.POST(post(route, { ...body, maxCredits: shown }, `tok-none-${randomUUID()}`));
      expect(res.status, label).toBe(403);
      expect(await res.json(), label).toMatchObject({ code: "token_no_ceiling", charged: 0 });
    }
    expect(await traces()).toEqual(NOTHING);
  });
  await doors("token-capped", tokenActor({ capCredits: ROOMY }), async (d) => {
    for (const { label, door, route, body } of presses(d)) {
      const shown = await quoted(door, route, body);
      const before = await traces();
      for (const figure of NOT_A_FIGURE) {
        const res = await door.POST(post(route, { ...body, maxCredits: figure }, `tok-noquote-${randomUUID()}`));
        expect(res.status, `${label}, ${String(figure)}`).toBe(400);
        expect(await res.json(), label).toMatchObject({ code: "quote_required", charged: 0 });
      }
      expect(await traces(), `${label}: nothing claimed, filed, reserved or sent`).toEqual(before);
      const res = await door.POST(post(route, { ...body, maxCredits: shown }, `tok-paid-${randomUUID()}`));
      const made = await res.json();
      expect(res.status, `${label}: ${JSON.stringify(made)}`).toBe(200);
      expect(await meterRow(made.id), label).toEqual({ status: "running", credits: shown });
    }
  });
});

test("a prepared request (a pipeline stage, an Atomik run) carries its quoted figure and is admitted at it", async () =>
  doors("prepared", person, async (d) => {
    const prepared = await d.audioAdmission.prepareAudio(SFX, person);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.request.maxCredits).toBe(prepared.value.quote.estimatedCredits);
    const reply = await d.audioAdmission.admitAudio(prepared.value, person, { requestKey: `prepared-${randomUUID()}`, defer: noInline });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(await meterRow(String(reply.body.id))).toEqual({ status: "running", credits: prepared.value.quote.estimatedCredits });
  }));

/* ── Every client that presses a sound or a dub sends the figure that was on its button ── */

type Call = { path: string; key: string | null; body: Record<string, unknown> };
function memory() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) } as unknown as Storage;
}
async function withServer(routes: Record<string, (body: Record<string, unknown>) => unknown>, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: at, key: new Headers(init?.headers).get("Idempotency-Key"), body });
    const answer = routes[at]?.(body);
    if (answer === undefined) throw new Error(`Unexpected request: ${at}`);
    return Response.json(answer);
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = original; }
}
/** A synthetic price, made up for the stub server. */
const PRICE = 9;
const audioServer = { "/api/audio": (body: Record<string, unknown>) => (body.quoteOnly ? { estimatedCredits: PRICE, price: PRICE, unit: "cr" } : { id: "gen_sound", status: "running" }) };

test("Make, the board's sound cards and the phone (the shared dispatch) send a sound at the figure on its button, and nothing when it moved", async () => {
  const { dispatchGeneration } = await import("../../lib/workspace/generate-submit");
  const { pendingGenerationKey } = await import("../../lib/workbench/pending-generation");
  const request = { endpoint: "/api/audio" as const, quoteBody: { task: "sound", text: "Rain" }, body: { task: "sound", text: "Rain", projectId: "prod_1", shotId: "shot_1" } };
  await withServer(audioServer, async (calls) => {
    const outcome = await dispatchGeneration({ scope: "particl-active-ws_unit-u_unit", storageId: pendingGenerationKey("particl-active-ws_unit-u_unit", "draft", "lane"), shown: PRICE, request, storage: memory(), remember: false });
    expect(outcome).toMatchObject({ state: "queued", jobId: "gen_sound", credits: PRICE });
    const sent = calls.filter((c) => !c.body.quoteOnly);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: "/api/audio", body: { task: "sound", text: "Rain", maxCredits: PRICE } });
    expect(sent[0].key).toBeTruthy();
  });
  await withServer(audioServer, async (calls) => {
    const outcome = await dispatchGeneration({ scope: "particl-active-ws_unit-u_unit", storageId: pendingGenerationKey("particl-active-ws_unit-u_unit", "draft", "lane-2"), shown: PRICE - 1, request, storage: memory(), remember: false });
    expect(outcome).toMatchObject({ state: "repriced", credits: PRICE });
    expect(calls.filter((c) => !c.body.quoteOnly)).toEqual([]);
  });
});

test("Make's takes of one sound each go at their own figure, under the total on the button", async () => {
  const { sendWorkspaceBatch } = await import("../../lib/workspace/take-batch");
  await withServer(audioServer, async (calls) => {
    const outcome = await sendWorkspaceBatch({
      scope: "particl-active-ws_unit-u_unit", shown: PRICE * 2, count: 2, storage: memory(),
      storageId: (v) => `take-${v}`,
      request: (v) => ({ endpoint: "/api/audio", quoteBody: { task: "sound", text: "Rain", variation: v }, body: { task: "sound", text: "Rain", variation: v, projectId: "prod_1" } }),
    });
    expect(outcome.state).toBe("sent");
    expect(calls.filter((c) => !c.body.quoteOnly).map((c) => c.body.maxCredits)).toEqual([PRICE, PRICE]);
  });
});

/* Edit & Sound's stems (a sound, a dub) are sent at their approved figures: tests/unit/workspacePlans.spec.ts ("audio stems dispatch with maxCredits equal to each approved quote"). */
test("Atomik's and the control room's step renders send a sound at its approved figure", async () => {
  const { approvedBody } = await import("../../lib/atomikStepRender");
  const step = { url: "/api/audio" as const, quoteUrl: "/api/audio" as const, body: { task: "sound", text: "Rain" } };
  expect(approvedBody(step as never, { estimatedCredits: PRICE } as never)).toEqual({ task: "sound", text: "Rain", maxCredits: PRICE });
});

test("Edit & Sound's own form sends the figure on its button, and takes up a moved price's new figure", () => {
  const source = readFileSync("components/workbench/SoundGenerate.tsx", "utf8");
  /* The press: the body it claims and sends carries the figure the button shows (`cost`, the route's own quote). */
  expect(source).toMatch(/projectId: mapping\.productionProjectId,\s*shotId: mapping\.shotId,\s*maxCredits: cost!,/);
  /* A moved price puts the new figure on the button. */
  expect(source).toMatch(/e\.data\.quoteChanged === true && validAudioQuote\(e\.data\)[\s\S]{0,200}setQuote\(/);
});
