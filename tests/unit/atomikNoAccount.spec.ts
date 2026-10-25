import { test, expect } from "@playwright/test";
import { AUDIO_ENGINE, STILL_ENGINE, VIDEO_ENGINE } from "../helpers/runtimeIds";
import { GEMINI_IDS, GROK_IDS, HIGH, LOW, MEDIUM, OPENAI_IDS, OTHER_CLAUDE } from "../helpers/thinkingSlots";
import { vendorRatesIn } from "../helpers/vendorFigures";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Atomik without a signed-in account (owner, 28 September 2026: API-key and
 * loginless offerings only; the provider's own agent is not sold as an API, so Atomik's
 * agentic workflow runs on Claude, OpenAI and Grok):
 *  - the planner never proposes an account tool (a connected model, its
 *    settings, a motion preset, a batch, a 3D step) and offers only
 *    Particl's own engines;
 *  - no Atomik code calls the connected step route, the recipes route or the
 *    account's workflow reads;
 *  - planner and agent models are the Claude, OpenAI and Grok families, with
 *    a default among them; a chat saved on a model Atomik no longer offers
 *    plans with Auto and says so, and a new request naming one is refused;
 *  - steps planned on the account before this stay readable, read-only.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-atomik-no-account-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const SEEDANCE = VIDEO_ENGINE;
const STILL = STILL_ENGINE;
const GEMINI = GEMINI_IDS[0];
const accountMeta = { model: "account-video", type: "video", modelName: "Account video", jobId: "11111111-1111-4111-8111-000000000001", draftId: "draft", credits: 42, workspaceId: "wallet", workspaceName: "Studio wallet", quoteExpiresAt: 1, input: { type: "video", model: "account-video", prompt: "A push in.", parameters: {}, medias: [] } };

let n = 0;
function workspace(): TenantWorkspace {
  const id = `ws${++n}_${Date.now().toString(36)}`;
  return { id, name: id, slug: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false } as TenantWorkspace;
}
async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(workspace(), fn);
}
async function chat(id: string, model = "auto", effort: string | null = null) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({
    sql: `INSERT INTO atomik_chats (id, project_id, title, model, effort, agent_mode, status, text_cost_usd, created_by, created_at, updated_at, deleted) VALUES (?,NULL,'Chat',?,?,'ask','waiting',0,'owner',1,1,0)`,
    args: [id, model, effort],
  });
}
async function step(fields: { id: string; chat: string; model?: string; params?: Record<string, unknown>; status?: string; genId?: string | null }) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({
    sql: `INSERT INTO atomik_steps (id, chat_id, message_id, position, kind, title, prompt, model, params, refs, status, gen_id, est_cost_usd, created_at, updated_at)
          VALUES (?,?,'m',0,'video',?,'A slow push-in on a bottle.',?,?,'[]',?,?,NULL,1,1)`,
    args: [fields.id, fields.chat, fields.id, fields.model ?? SEEDANCE, JSON.stringify(fields.params ?? {}), fields.status ?? "proposed", fields.genId ?? null],
  });
}

/* ── The planner proposes Particl's own engines only ─────────────────── */

test("the planner never proposes an account tool: a connected model, its settings, a preset, a batch or a 3D step never reach a step", async () => {
  const { extractTurn } = await import("../../lib/atomik");
  const reply = JSON.stringify({
    say: "Four shots.",
    propose: [
      { kind: "video", title: "Push in", prompt: "A slow push in on a bottle.", model: "connected:account-video", settings: { duration: 5, mode: "pro" }, preset: "preset-1", batch: "variants", seconds: 5, ratio: "16:9" },
      { kind: "image", title: "Still", prompt: "The bottle on white.", model: "connected:nano_banana_2", settings: { resolution: "2k" }, batch: true },
      { kind: "audio", title: "Hum", prompt: "A soft hum.", model: "connected:mmaudio" },
      { kind: "3d", title: "Bottle model", prompt: "A bottle, as a 3D model.", model: "connected:hunyuan_3d" },
    ],
  });
  const allowed = [{ id: SEEDANCE, kind: "video" as const }, { id: STILL, kind: "image" as const }, { id: AUDIO_ENGINE, kind: "audio" as const }];
  for (const turn of [extractTurn(reply, allowed)!, extractTurn(reply)!]) {
    expect(turn.propose.map((p) => p.kind)).toEqual(["video", "image", "audio"]);
    for (const proposal of turn.propose) {
      expect(proposal.model.startsWith("connected:"), proposal.title).toBe(false);
      expect(Object.keys(proposal).sort(), proposal.title).toEqual(["attachments", "kind", "model", "params", "prompt", "title"]);
      for (const key of ["connected", "settings", "preset", "batch", "mode"]) expect(proposal.params, `${proposal.title}: ${key}`).not.toHaveProperty(key);
    }
    expect(turn.propose[2].model).toBe(AUDIO_ENGINE);
    /* No engine here makes 3D: it is named as not proposed, never made as something else. */
    expect(turn.say).toContain("Not proposed");
    expect(turn.say).toContain("Bottle model");
  }
  expect(extractTurn(reply, allowed)!.propose.map((p) => p.model)).toEqual([SEEDANCE, STILL, AUDIO_ENGINE]);
});

test("the engines Atomik offers the planner are Particl's own; none is on a signed-in account", async () => {
  await inTenant(async () => {
    const { engines } = await import("../../lib/atomik");
    const list = await engines();
    expect(list.length).toBeGreaterThan(1);
    for (const engine of list) {
      expect(engine.own, engine.id).toBe(true);
      expect(engine.id.startsWith("connected:"), engine.id).toBe(false);
      expect(engine, engine.id).not.toHaveProperty("connected");
      expect(engine.note, engine.id).not.toMatch(/connected/i);
    }
  });
});

test("an API-key engine is offered where it exists: Cinema Studio 4.0 is on the planner's list, and off with its deploy switch", async () => {
  const { CINEMA_STUDIO_MODEL_ID } = await import("../../lib/cinemaStudioTypes");
  const { ownGenerateEngines } = await import("../../lib/atomik");
  const before = process.env.HF_CINEMA_STUDIO_ENABLED;
  try {
    delete process.env.HF_CINEMA_STUDIO_ENABLED;
    expect(ownGenerateEngines().map((m) => m.id)).toContain(CINEMA_STUDIO_MODEL_ID);
    process.env.HF_CINEMA_STUDIO_ENABLED = "0";
    expect(ownGenerateEngines().map((m) => m.id)).not.toContain(CINEMA_STUDIO_MODEL_ID);
  } finally {
    if (before === undefined) delete process.env.HF_CINEMA_STUDIO_ENABLED; else process.env.HF_CINEMA_STUDIO_ENABLED = before;
  }
});

/* ── Nothing in Atomik reaches the account ───────────────────────────── */

const walk = (root: string): string[] =>
  !existsSync(root) ? [] : statSync(root).isFile() ? [root] : readdirSync(root).flatMap((name) => walk(path.join(root, name)));

test("no Atomik code calls the connected step route, the recipes route or the account's workflow reads", () => {
  for (const gone of [
    "app/api/atomik/steps/[id]/connected/route.ts",
    "app/api/atomik/recipes/route.ts",
    "lib/higgsfield-consumer/planner-service.ts",
    "lib/higgsfield-consumer/planner-proposals.ts",
    "lib/higgsfield-consumer/recipes-service.ts",
    "lib/higgsfield-consumer/workflows.ts",
    "components/suites/AtomikGenerate.tsx",
  ]) expect(existsSync(gone), gone).toBe(false);

  const atomik = [
    ...walk("app/api/atomik"), ...walk("components/atomik"), ...walk("components/graphite/atomik"),
    "components/graphite/AtomikGate.tsx", "components/graphite/AtomikSheet.tsx",
    "lib/workspace/atomik-host.tsx",
    ...readdirSync("lib").filter((name) => /^atomik.*\.tsx?$/.test(name)).map((name) => path.join("lib", name)),
  ].filter((file) => /\.(ts|tsx)$/.test(file));
  expect(atomik.length).toBeGreaterThan(20);
  for (const file of atomik) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/\/api\/atomik\/steps\/[^"'`\s]*\/connected|\/connected[`'"]/);
    expect(source, file).not.toContain("/api/atomik/recipes");
    expect(source, file).not.toContain("higgsfield-consumer");
    expect(source, file).not.toMatch(/get_workflow_instructions|get_workflow_bundle_file|presets_show|approve-batch/);
  }
  /* The planner's prompt carries no account section, recipe section or connected-model rules. */
  const planner = readFileSync("lib/atomik.ts", "utf8");
  expect(planner).not.toMatch(/CONNECTED ACCOUNT|CONNECTED_SYSTEM|RECIPE_SYSTEM|recipeSection|"connected:\.\.\."/);
  /* The account's workflow reads are gone from the account client itself. */
  const client = readFileSync("lib/higgsfield-consumer/mcp.ts", "utf8");
  expect(client).not.toMatch(/readConnectedWorkflow|workflowRead|get_workflow_bundle_file/);
});

test("the plans Atomik runs on a page never read, quote, submit or poll on the account", async () => {
  const { PLANS, PLAN_PAGES } = await import("../../lib/workspace/plans");
  for (const page of PLAN_PAGES)
    for (const item of PLANS[page].steps)
      expect(item.executor.backend.path, `${page}: ${item.label}`).not.toContain("/api/higgsfield/consumer/");
  /* Compare reads the takes kept in the project's Library, the account's past runs among them, with a GET. */
  expect(PLANS.compare.steps[0].executor.backend).toEqual({ method: "GET", path: "/api/workbench/library?source=generations" });
  /* Motion Transfer and Object Swap run on the API-key transform engines through /api/generate. */
  for (const page of ["motion", "swap"] as const) {
    const paths = PLANS[page].steps.map((item) => item.executor.backend.path);
    expect(paths, page).toEqual(["request." + page, "/api/generate/quote", "/api/generate", "/api/jobs/[id]"]);
  }
});

/* ── Claude only, at the Thinking setting (owner, 22 Oct 2026) ──────────── */

test("Atomik's planner and agent think only with Claude, at the workspace's Thinking setting; Medium is the default", async () => {
  const policy = await import("../../lib/atomikModelPolicy");
  const { FEATURED } = await import("../../lib/catalog");
  const family = (id: string) => id.split("/")[0];
  expect(new Set(policy.atomikModelIds().map(family))).toEqual(new Set(["anthropic"]));
  expect(policy.ATOMIK_FAMILIES).toEqual(["anthropic"]);
  expect(policy.DEFAULT_THINKING).toBe("medium");
  expect(policy.ATOMIK_THINKING[policy.DEFAULT_THINKING].model).toBe(MEDIUM);
  for (const { model } of Object.values(policy.ATOMIK_THINKING)) expect(policy.isAtomikModel(model!), String(model)).toBe(true);
  expect([...FEATURED.planner]).toEqual(policy.atomikModelIds());
  /* Only the three settings' models are Atomik's thinking (owner, 23 Oct 2026); the verified list itself is unchanged. */
  for (const id of policy.VERIFIED_TEXT_MODEL_IDS) expect(policy.isAtomikModel(id), id).toBe([HIGH, MEDIUM, LOW].includes(id));
  expect(policy.atomikModelIds()).toEqual([HIGH, MEDIUM, LOW]);
  expect(policy.VERIFIED_TEXT_MODEL_IDS.filter((id) => family(id) === "google").length).toBeGreaterThan(0);

  /* The setting picks among the three only: a Gemini, Grok or OpenAI catalogue never plans, nor a Claude model outside the three; without the
     setting's model, a cheaper one of the three on every rate does (lib/atomikModelPolicy.ts, cheaperFallback). */
  const entry = (id: string) => ({ id, name: id, owner: family(id), type: "language" as const, description: "", contextWindow: 200000, maxTokens: 8000, pricing: { input: "0.00000449", output: "0.0000173" } });
  expect(vendorRatesIn(entry(MEDIUM).pricing), "made-up rates").toEqual([]);
  const served = [GEMINI, GEMINI_IDS[1], GROK_IDS[0], OPENAI_IDS[0]].map(entry);
  expect(policy.selectAtomikThinking("medium", "plan", served)).toBeNull();
  expect(policy.selectAtomikThinking("medium", "plan", [...served, entry(OTHER_CLAUDE[0])])).toBeNull();
  expect(policy.selectAtomikThinking("medium", "plan", [...served, entry(OTHER_CLAUDE[0]), entry(MEDIUM)])?.model).toBe(MEDIUM);

  /* The workbench agent's priced menu drops what is outside the three. */
  const { atomikModels } = await import("../../lib/workbench/atomik-server");
  const menu = atomikModels([entry(GEMINI), entry(OTHER_CLAUDE[0]), entry(LOW), entry(GROK_IDS[0]), entry(OPENAI_IDS[0])] as never);
  expect(menu.map((model) => model.id)).toEqual([LOW]);

  /* The picker is gone (3b-2): a person picks Thinking (High · Medium · Low), never a model, so no screen groups or lists them. */
  expect(existsSync("components/atomik/ModelPicker.tsx")).toBe(false);
});

test("a chat saved on a model Atomik no longer thinks with reads as Auto with nothing to say; its stored row is kept, and nothing is refused", async () => {
  const policy = await import("../../lib/atomikModelPolicy");
  for (const id of [GEMINI, GROK_IDS[0], OPENAI_IDS[0], "auto", null]) expect(policy.savedAtomikChoice(id), String(id)).toEqual({ model: "auto", note: null });
  /* A Claude model outside the three reads as Auto too (owner, 23 Oct 2026); one of the three reads as itself. */
  expect(policy.savedAtomikChoice(OTHER_CLAUDE[1])).toEqual({ model: "auto", note: null });
  expect(policy.savedAtomikChoice(LOW)).toEqual({ model: LOW, note: null });

  await inTenant(async () => {
    const { getChat, listChats, patchChat } = await import("../../lib/atomik");
    const { db } = await import("../../lib/db");
    await chat("gem", GEMINI, "high");
    const loaded = (await getChat("gem"))!;
    expect(loaded.chat).toMatchObject({ model: "auto" });
    expect(loaded.chat.modelNote).toBeUndefined();
    expect(loaded.chat.effort).toBeUndefined();
    expect((await listChats("owner")).find((c) => c.id === "gem")).toMatchObject({ model: "auto" });
    /* The stored row is left as it was: nothing a team made is rewritten. */
    expect((await db().execute({ sql: "SELECT model, effort FROM atomik_chats WHERE id = ?", args: ["gem"] })).rows[0]).toMatchObject({ model: GEMINI, effort: "high" });
    /* A stored model is what a turn ran, never a refused choice: saving one is not refused. */
    await patchChat("gem", { model: GEMINI });
    await patchChat("gem", { model: GROK_IDS[0] });
    expect((await getChat("gem"))!.chat).toMatchObject({ model: "auto" });
    expect((await getChat("gem"))!.chat.modelNote).toBeUndefined();
  });
});

/* ── Older steps on the account: readable, read-only ──────────────────── */

test("steps planned on the account before stay readable and read-only: never approved, edited, settled or waited on", async () => {
  const { ACCOUNT_STEP_NOTE, accountStep, isAccountStep } = await import("../../lib/atomikAccountStep");
  expect(accountStep({ model: "connected:account-video", params: { connected: accountMeta } })).toEqual({ modelName: "Account video", credits: 42 });
  expect(accountStep({ model: "connected:account-video", params: {} })).toEqual({ modelName: null, credits: null });
  expect(isAccountStep({ model: SEEDANCE, params: { connected: { credits: 3 } } })).toBe(true);
  expect(isAccountStep({ model: SEEDANCE, params: { seconds: 5 } })).toBe(false);
  expect(isAccountStep(null)).toBe(false);

  await inTenant(async () => {
    const { getChat, listChats, patchStep, reconcileRunningSteps, estimateStepUsd, StepEditError } = await import("../../lib/atomik");
    const { db } = await import("../../lib/db");
    await chat("old");
    await step({ id: "acct-proposed", chat: "old", model: "connected:account-video", params: { connected: accountMeta } });
    await step({ id: "acct-running", chat: "old", model: "connected:account-video", params: { connected: accountMeta }, status: "running" });
    await step({ id: "acct-done", chat: "old", model: "connected:account-video", params: { connected: accountMeta }, status: "done", genId: "gen_kept" });
    await chat("own");
    await step({ id: "own-proposed", chat: "own" });

    /* Readable: every row is there as it was stored. */
    const loaded = (await getChat("old"))!;
    expect(loaded.steps.map((s) => [s.id, s.status, s.model])).toEqual([
      ["acct-proposed", "proposed", "connected:account-video"], ["acct-running", "running", "connected:account-video"], ["acct-done", "done", "connected:account-video"],
    ]);
    expect(loaded.steps.every((s) => isAccountStep(s) && s.estCostUsd === null)).toBe(true);
    expect(loaded.steps.find((s) => s.id === "acct-done")?.genId).toBe("gen_kept");
    expect(await estimateStepUsd("video", "connected:account-video", { connected: accountMeta })).toBeNull();

    /* Never waited on: an account step does not make its chat need an approval. */
    const chats = await listChats("owner");
    expect(chats.find((c) => c.id === "old")?.needsApproval).toBe(false);
    expect(chats.find((c) => c.id === "own")?.needsApproval).toBe(true);

    /* Never edited or moved, not even a status. */
    for (const patch of [{ status: "rejected" as const }, { prompt: "Another" }, { model: SEEDANCE }, { status: "done" as const, genId: "gen_x" }]) {
      await expect(patchStep("acct-proposed", patch), JSON.stringify(patch)).rejects.toBeInstanceOf(StepEditError);
      await expect(patchStep("acct-proposed", patch)).rejects.toThrow(ACCOUNT_STEP_NOTE);
    }
    /* Never settled from here: nothing reads the account, so a running one stays as it is. */
    expect(await reconcileRunningSteps("old", Date.now() + 60 * 60_000)).toBe(0);
    const rows = (await db().execute({ sql: "SELECT id, status, gen_id, params FROM atomik_steps WHERE chat_id = 'old' ORDER BY id" })).rows;
    expect(rows.map((r) => [String(r.id), String(r.status), r.gen_id == null ? null : String(r.gen_id)])).toEqual([
      ["acct-done", "done", "gen_kept"], ["acct-proposed", "proposed", null], ["acct-running", "running", null],
    ]);
    for (const r of rows) expect(JSON.parse(String(r.params)).connected).toMatchObject({ credits: 42, modelName: "Account video" });
  });
});

/* The step routes, compiled with their collaborators faked: an account step is refused before anything is claimed. */
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
async function route(file: string, fake: Record<string, unknown>): Promise<Record<string, Handler>> {
  const dependencies: Record<string, unknown> = {
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/auth": {
      withTenant: (handler: Handler) => handler,
      requireUser: async () => ({ user: { id: "owner", owner: true } }),
      requireRender: async () => ({ user: { id: "owner", owner: true } }),
    },
    /* Not the sample workspace: the claim route's own check answers null. */
    "@/lib/demo/spend-guard.server": { sampleWorkspaceOff: async () => null },
    "@/lib/atomik": fake,
    "@/lib/atomikAccountStep": await import("../../lib/atomikAccountStep"),
    /* The claim route is people-only (a signed-in person, never a token): the owner here is one. */
    "@/lib/security/people-only": await import("../../lib/security/people-only"),
    /* A step is its chat's person's (lib/atomikAccess.ts); this spec is about the account step's refusal, so the step is the caller's own here. */
    "@/lib/atomikAccess": { STEP_GONE: "That step is gone.", stepIsMine: async () => true },
    /* The claim route also refuses a step of an archived thread (lib/atomikThreads.ts); an account step is refused first. */
    "@/lib/atomikThreads": { ARCHIVED_NOTE: (await import("../../lib/atomikThreadsText")).ARCHIVED_NOTE, threadArchived: (fake.threadArchived as (() => Promise<boolean>) | undefined) ?? (async () => false) },
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const compiledModule = { exports: {} as Record<string, Handler> };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
      return dependencies[name];
    },
    compiledModule,
    compiledModule.exports,
  );
  return compiledModule.exports;
}

test("the claim and step routes refuse an account step with its reason, and claim, patch or settle nothing", async () => {
  const { ACCOUNT_STEP_NOTE } = await import("../../lib/atomikAccountStep");
  const stored = { id: "acct", chatId: "c", messageId: "m", position: 0, kind: "video", title: "Push in", prompt: "A push in.", model: "connected:account-video",
    params: { connected: accountMeta }, refs: [], status: "proposed", genId: null, estCostUsd: null, error: null, createdAt: 1 };
  const touched: string[] = [];
  const fake = {
    getStep: async () => stored,
    claimStep: async () => { touched.push("claim"); return stored; },
    reconcileRunningSteps: async () => { touched.push("reconcile"); return 0; },
    patchStep: async () => { touched.push("patch"); return stored; },
    stepForBrowser: (s: unknown) => s,
    StepEditError: class extends Error {},
    threadArchived: async () => { touched.push("archived?"); return false; },
  };
  const ctx = { params: Promise.resolve({ id: "acct" }) };
  const claim = await route("app/api/atomik/steps/[id]/claim/route.ts", fake);
  const claimed = await claim.POST(new Request("http://localhost/api/atomik/steps/acct/claim", { method: "POST" }), ctx);
  expect(claimed.status).toBe(409);
  expect(await claimed.json()).toMatchObject({ error: ACCOUNT_STEP_NOTE, step: { id: "acct", status: "proposed" } });

  const steps = await route("app/api/atomik/steps/[id]/route.ts", fake);
  for (const body of [{ status: "rejected" }, { prompt: "Another" }, { status: "done", genId: "gen_x" }]) {
    const patched = await steps.PATCH(new Request("http://localhost/api/atomik/steps/acct", { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), ctx);
    expect(patched.status, JSON.stringify(body)).toBe(409);
    expect(await patched.json()).toMatchObject({ error: ACCOUNT_STEP_NOTE });
  }
  /* Reading it is fine. */
  const read = await steps.GET(new Request("http://localhost/api/atomik/steps/acct"), ctx);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ id: "acct", model: "connected:account-video", params: { connected: { credits: 42 } } });
  expect(touched).toEqual([]);
});
