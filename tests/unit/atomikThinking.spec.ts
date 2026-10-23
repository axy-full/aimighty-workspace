import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import type { CatalogModel } from "../../lib/catalog";
import { HIGH, LOW, MEDIUM, SLOTS, withSlotEnv } from "../helpers/thinkingSlots";
import { pickThinkingSlots, slotCandidates, thinkingSlotEnv } from "../helpers/thinking-slots.mjs";
import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
import { loadRouteModule } from "../helpers/vendorCostScan";
import {
  ATOMIK_THINKING, ATOMIK_TURNS, CLAUDE_MODEL_IDS, DEFAULT_THINKING, THINKING_SETTINGS, THINKING_UNAVAILABLE, TREATMENT_WRITER_OFF, VERIFIED_TEXT_MODEL_IDS,
  atomikModelIds, atomikThinkingSlots, isAtomikModel, offersEffort, selectAtomikThinking, thinkingFor, thinkingModelEnv, treatmentWriter, type AtomikTurn, type Thinking,
} from "../../lib/atomikModelPolicy";
import { DIRECT_MODEL_IDS } from "../../lib/textRoute";
import { THINKING_OPTIONS, settingProblem } from "../../lib/settingValues";

/*
 * Atomik's thinking: three settings (owner, 22 Oct 2026; Amendment (iii) §E), each a slot whose model the deployment's env names (owner,
 * 23 Oct 2026, option A: no slot is mapped to a model in code). The slots read from the env, the turn rules, the Treatment writer, the
 * workspace's setting and the routes that read it. The slots here are tests/helpers/thinkingSlots.ts's, picked by catalogue price; every
 * other id is read from the verified catalogue, never written down. Real temporary databases and the mocked engines (ENGINE_MOCK=1):
 * nothing is sent anywhere, and nothing is billed for real.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-atomik-thinking-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
/* The checked-in catalogue snapshot, never the gateway's live list: nothing here reaches the network. Put back for the specs after this one. */
const priorCatalog = process.env.MODEL_CATALOG;
test.beforeAll(() => { process.env.MODEL_CATALOG = "static"; });
test.afterAll(() => { if (priorCatalog === undefined) delete process.env.MODEL_CATALOG; else process.env.MODEL_CATALOG = priorCatalog; });

/* Ids by family, from the verified catalogue: the Claude models that are no slot's, and the other families' (never Atomik's thinking). */
const family = (owner: string) => VERIFIED_TEXT_MODEL_IDS.filter((id) => id.startsWith(`${owner}/`));
const OPENAI = family("openai"), GROK = family("spacexai"), GEMINI = family("google");
const GPT = OPENAI.find((id) => id.startsWith("openai/gpt-"))!;
const OTHER_CLAUDE = CLAUDE_MODEL_IDS.filter((id) => !Object.values(SLOTS).includes(id));
/** Not a verified catalogue id (nor any vendor's). */
const NOT_VERIFIED = "anthropic/not-a-verified-model";
/** The slot env variables, each set to the helper's slot: a test changes one of them with withSlotEnv. */
const SLOT_ENV = Object.fromEntries(THINKING_SETTINGS.map((setting) => [thinkingModelEnv(setting), SLOTS[setting]]));

test("the three settings: each slot's model is the env's, at high effort, and three distinct verified Claude ids; Medium is the default", () => {
  expect([...THINKING_SETTINGS]).toEqual(["high", "medium", "low"]);
  expect(DEFAULT_THINKING).toBe("medium");
  expect(atomikThinkingSlots()).toEqual({ high: { model: HIGH, effort: "high" }, medium: { model: MEDIUM, effort: "high" }, low: { model: LOW, effort: "high" } });
  expect({ ...ATOMIK_THINKING }).toEqual(atomikThinkingSlots());
  expect(new Set([HIGH, MEDIUM, LOW]).size).toBe(3);
  for (const id of [HIGH, MEDIUM, LOW]) expect(CLAUDE_MODEL_IDS, id).toContain(id);
  /* The words a person is shown are the three settings, never a model or an effort; the settings list holds the same values. */
  expect(THINKING_OPTIONS).toEqual([["high", "High"], ["medium", "Medium"], ["low", "Low"]]);
  expect(THINKING_OPTIONS.map(([value]) => value)).toEqual([...THINKING_SETTINGS]);
  for (const { model } of Object.values(ATOMIK_THINKING)) expect(isAtomikModel(model!), String(model)).toBe(true);
});

test("each setting's model is in the catalogue and offers its effort, so the effort is sent", async () => {
  const { staticCatalog } = await import("../../lib/catalog");
  const served = staticCatalog();
  for (const setting of THINKING_SETTINGS) {
    const { model, effort } = ATOMIK_THINKING[setting];
    const entry = served.find((m) => m.id === model);
    expect(entry, String(model)).toBeTruthy();
    expect(offersEffort(entry!, effort), `${model} ${effort}`).toBe(true);
    expect(selectAtomikThinking(setting, "plan", served)).toMatchObject({ thinking: setting, model, effort });
  }
});

test("the slots come from the env alone: a verified Claude id and a named effort apply; unset, or any other id, the slot is empty; never thrown", () => {
  /* Nothing set: every slot is empty (no model is mapped in code), each still at high effort. */
  expect(atomikThinkingSlots({})).toEqual({ high: { model: null, effort: "high" }, medium: { model: null, effort: "high" }, low: { model: null, effort: "high" } });
  const other = OTHER_CLAUDE[0];
  expect(atomikThinkingSlots({ ...SLOT_ENV, ATOMIK_THINKING_HIGH_MODEL: other, ATOMIK_THINKING_HIGH_EFFORT: "max", ATOMIK_THINKING_LOW_EFFORT: "medium" })).toEqual({
    high: { model: other, effort: "max" }, medium: { model: MEDIUM, effort: "high" }, low: { model: LOW, effort: "medium" },
  });
  /* Grok, OpenAI and Gemini are not Atomik's thinking; a vendor's own spelling, an id outside the catalogue and garbage are not verified ids. */
  for (const model of [GROK[0], GROK[0].replace(/^spacexai\//, "xai/"), ...OPENAI.slice(0, 2), GEMINI[0], DIRECT_MODEL_IDS[MEDIUM], NOT_VERIFIED, "", "  ", "{}"])
    expect(atomikThinkingSlots({ ...SLOT_ENV, ATOMIK_THINKING_MEDIUM_MODEL: model }).medium, JSON.stringify(model)).toEqual({ model: null, effort: "high" });
  /* "none", token budgets, "auto" and anything unknown are not thinking efforts. */
  for (const effort of ["none", "auto", "budget:4096", "ultra", "HIGH ", "", "0"])
    expect(atomikThinkingSlots({ ...SLOT_ENV, ATOMIK_THINKING_LOW_EFFORT: effort }).low, JSON.stringify(effort)).toEqual({ model: LOW, effort: "high" });
  /* Surrounding space is trimmed; case is not folded. */
  expect(atomikThinkingSlots({ ATOMIK_THINKING_LOW_MODEL: ` ${other} `, ATOMIK_THINKING_LOW_EFFORT: " low " }).low).toEqual({ model: other, effort: "low" });
  expect(atomikThinkingSlots({ ATOMIK_THINKING_LOW_MODEL: other.toUpperCase() }).low.model).toBeNull();
  expect(atomikThinkingSlots({ ...SLOT_ENV, ATOMIK_THINKING_LOW_EFFORT: "LOW" }).low.effort).toBe("high");
  /* Read when asked: ATOMIK_THINKING and the allowlist follow the env as it is now. */
  expect(atomikModelIds()).toEqual([HIGH, MEDIUM, LOW]);
  expect(atomikModelIds({ ...SLOT_ENV, ATOMIK_THINKING_HIGH_MODEL: undefined })).toEqual([MEDIUM, LOW]);
});

test("thinkingFor: the interview, the plan, writing and design run at the setting; the judge, digests and routine turns at Low unless the setting is High", () => {
  const atSetting: AtomikTurn[] = ["interview", "plan", "writing", "design"];
  const atLow: AtomikTurn[] = ["judge", "digest", "routine"];
  expect([...ATOMIK_TURNS].sort()).toEqual([...atSetting, ...atLow].sort());
  for (const setting of THINKING_SETTINGS) {
    for (const turn of atSetting) expect(thinkingFor(setting, turn), `${setting} ${turn}`).toEqual({ thinking: setting, ...ATOMIK_THINKING[setting] });
    for (const turn of atLow) {
      const expected: Thinking = setting === "high" ? "high" : "low";
      expect(thinkingFor(setting, turn), `${setting} ${turn}`).toEqual({ thinking: expected, ...ATOMIK_THINKING[expected] });
    }
  }
  /* A value that is not a setting reads as the default. */
  expect(thinkingFor("ultra" as Thinking, "plan")).toEqual({ thinking: "medium", ...ATOMIK_THINKING.medium });
  expect(thinkingFor("ultra" as Thinking, "judge")).toEqual({ thinking: "low", ...ATOMIK_THINKING.low });
});

test("Grok and OpenAI are never Atomik's thinking: refused as slots, never picked when served, and only the slots are on the allowlist", async () => {
  expect(new Set(atomikModelIds().map((id) => id.split("/")[0]))).toEqual(new Set(["anthropic"]));
  const priced = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, name: id, owner: id.split("/")[0], type: "language", description: "", contextWindow: 200_000, maxTokens: 32_000, pricing: { input: "0.000001", output: "0.000002" }, ...extra });
  const others = [...GROK.slice(0, 2), ...OPENAI.slice(0, 2), GEMINI[0]].map((id) => priced(id));
  for (const setting of THINKING_SETTINGS) for (const turn of ATOMIK_TURNS) expect(selectAtomikThinking(setting, turn, others), `${setting} ${turn}`).toBeNull();
  /* Served beside them, the setting's own model is picked, and nothing else. A catalogue entry that offers no effort control sends none. */
  const withClaude = [...others, priced(MEDIUM), priced(LOW, { reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }] })];
  expect(selectAtomikThinking("medium", "plan", withClaude)).toMatchObject({ thinking: "medium", model: MEDIUM });
  expect(selectAtomikThinking("medium", "plan", withClaude)?.effort).toBeUndefined();
  expect(selectAtomikThinking("medium", "routine", withClaude)).toMatchObject({ thinking: "low", model: LOW, effort: "high" });
  /* A fallback is never dearer than the setting's own model (its catalogue rates, read here from the snapshot, never written down), and only
     another of the three settings' models qualifies (owner, 23 Oct 2026, item 14). */
  const { staticCatalog } = await import("../../lib/catalog");
  const own = (id: string) => staticCatalog().find((m) => m.id === id)!.pricing as unknown as Record<string, string | number>;
  const KEYS = ["input", "output", "input_cache_read", "input_cache_write"] as const;
  const at = (id: string, factor: number) => Object.fromEntries(KEYS.map((key) => [key, Number(own(id)[key]) * factor]));
  const [OUTSIDE, OUTSIDE_2] = OTHER_CLAUDE;
  /* High's model not served: Medium's model at its own rates is no dearer than High's on any rate, the closest below: it runs, at High's
     effort where offered. */
  expect(selectAtomikThinking("high", "plan", [...others, priced(MEDIUM, { pricing: at(MEDIUM, 1) }), priced(LOW, { pricing: at(LOW, 1) })])).toMatchObject({ thinking: "high", model: MEDIUM });
  /* The judge at Low, Low's model not served and only Medium's (dearer) served: refused, never upward. */
  expect(selectAtomikThinking("medium", "judge", [...others, priced(MEDIUM, { pricing: at(MEDIUM, 1) })])).toBeNull();
  /* Medium not served: Low's model at its own rates (below Medium's) runs. */
  expect(selectAtomikThinking("medium", "plan", [...others, priced(LOW, { pricing: at(LOW, 1) })])?.model).toBe(LOW);
  /* A Claude model outside the three never qualifies, however cheap. */
  expect(selectAtomikThinking("low", "routine", [...others, priced(OUTSIDE, { pricing: at(LOW, 0.5) })])).toBeNull();
  expect(selectAtomikThinking("medium", "plan", [...others, priced(OUTSIDE, { pricing: at(MEDIUM, 0.5) }), priced(OUTSIDE_2, { pricing: at(MEDIUM, 0.9) })])).toBeNull();
  /* It must dominate, not just blend lower: the review's example, a quarter of the input rate at one and a half times the output rate (an
     output-heavy, high-effort turn costs more), is refused; so is any cache rate above the setting's own, and a cache rate not stated. */
  const rates = own(MEDIUM);
  expect(selectAtomikThinking("medium", "plan", [...others, priced(LOW, { pricing: { ...at(LOW, 1), input: Number(rates.input) / 4, output: Number(rates.output) * 1.5 } })])).toBeNull();
  expect(selectAtomikThinking("medium", "plan", [...others, priced(LOW, { pricing: { ...at(LOW, 1), input_cache_read: Number(rates.input_cache_read) * 2 } })])).toBeNull();
  expect(selectAtomikThinking("medium", "plan", [...others, priced(LOW, { pricing: { input: Number(own(LOW).input), output: Number(own(LOW).output) } })])).toBeNull();
  /* A model with no catalogue price is never a fallback. */
  expect(selectAtomikThinking("medium", "plan", [...others, { ...priced(LOW), pricing: null }])).toBeNull();
  expect(THINKING_UNAVAILABLE).not.toMatch(/claude|fable|opus|sonnet|haiku|effort|high|medium|low/i);
});

test("TREATMENT_WRITER: an OpenAI id, read when asked; unset or outside OpenAI is null; its effort defaults to high", () => {
  expect(treatmentWriter({})).toBeNull();
  expect(treatmentWriter({ TREATMENT_WRITER_MODEL: "" })).toBeNull();
  const bare = GPT.slice("openai/".length);
  expect(treatmentWriter({ TREATMENT_WRITER_MODEL: bare })).toEqual({ model: GPT, effort: "high" });
  expect(treatmentWriter({ TREATMENT_WRITER_MODEL: ` ${GPT} `, TREATMENT_WRITER_EFFORT: "medium" })).toEqual({ model: GPT, effort: "medium" });
  expect(treatmentWriter({ TREATMENT_WRITER_MODEL: GPT, TREATMENT_WRITER_EFFORT: "budget:4096" })).toEqual({ model: GPT, effort: "high" });
  for (const model of [MEDIUM, GROK[0], GEMINI[0], "o3", "openai/", "openai/gpt 6", "openai/../x", "sol"])
    expect(treatmentWriter({ TREATMENT_WRITER_MODEL: model }), model).toBeNull();
  /* Lazily: the env as it is when asked. */
  const prior = process.env.TREATMENT_WRITER_MODEL;
  try {
    delete process.env.TREATMENT_WRITER_MODEL;
    expect(treatmentWriter()).toBeNull();
    process.env.TREATMENT_WRITER_MODEL = bare;
    expect(treatmentWriter()?.model).toBe(GPT);
  } finally { if (prior === undefined) delete process.env.TREATMENT_WRITER_MODEL; else process.env.TREATMENT_WRITER_MODEL = prior; }
  expect(TREATMENT_WRITER_OFF).toBe("The Treatment writer is not set up. Nothing billed.");
});

/* ── The workspace's setting, and the routes that read it ─────────────── */

const admin = { id: "u_think_admin", email: "u_think_admin@example.test", name: "Ada", role: "admin", owner: true, disabled: false, lastSeen: null, createdAt: 0 } as TenantUser;
const member = { ...admin, id: "u_think_member", email: "u_think_member@example.test", name: "Mo", role: "member", owner: false } as TenantUser;
function workspace(name: string): TenantWorkspace {
  const id = `ws_think_${name}_${randomUUID().slice(0, 8)}`;
  return { id, slug: id, name, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: admin.id, createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}
async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>, user: TenantUser = admin): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, { user });
}
async function funded(name: string): Promise<TenantWorkspace> {
  const ws = workspace(name);
  const { ready } = await import("../../lib/db");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  for (const who of [admin, member]) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES(?,?,?,?,0)", args: [who.id, who.email, who.name, "x"] });
    await platformDb().execute({ sql: "INSERT OR REPLACE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [ws.id, who.id, who.role] });
  }
  await inTenant(ws, async () => { await ready(); await fundFixtureWorkspace(); });
  return ws;
}
type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function route(file: string, extra: Record<string, unknown> = {}, who: TenantUser = admin) {
  const auth = await import("../../lib/auth");
  return loadRouteModule<{ POST?: Handler; PATCH?: Handler }>(file, {
    "@/lib/auth": { ...auth, withTenant: (fn: Handler) => fn, requireUser: async () => ({ user: who }), requireRender: async () => ({ user: who }) },
    ...extra,
  });
}
const post = (url: string, body: unknown, method = "POST") => new Request(url, { method, headers: { "Content-Type": "application/json", "Idempotency-Key": `think-${randomUUID()}` }, body: JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });

test("the workspace's setting: Medium by default, set by an admin only, and only to High, Medium or Low", async () => {
  const ws = await funded("setting");
  const { workspaceThinking } = await import("../../lib/atomikThinking");
  const { DEFAULTS } = await import("../../lib/settings");
  expect(DEFAULTS.atomikThinking).toBe("medium");
  expect(await inTenant(ws, workspaceThinking)).toBe("medium");
  /* Outside any workspace, or with nothing readable, it is the default. */
  expect(await workspaceThinking()).toBe("medium");
  for (const value of ["high", "medium", "low"]) expect(settingProblem("atomikThinking", value), value).toBeNull();
  for (const value of ["High", "ultra", "", MEDIUM, 3, null]) expect(settingProblem("atomikThinking", value), String(value)).toBe("Choose High, Medium or Low.");

  const settings = await route("app/api/settings/route.ts");
  const patch = (who: TenantUser, body: unknown) => inTenant(ws, async () => answer(await settings.PATCH!(post("https://particl.test/api/settings", body, "PATCH"))), who);
  /* A member is refused (requireAdmin, as for every workspace setting), and nothing changes. */
  expect((await patch(member, { atomikThinking: "high" })).status).toBe(403);
  expect(await inTenant(ws, workspaceThinking)).toBe("medium");
  /* An admin's unknown value is refused whole, before anything is written. */
  expect(await patch(admin, { atomikThinking: "ultra" })).toMatchObject({ status: 400, body: { error: "Choose High, Medium or Low." } });
  expect(await inTenant(ws, workspaceThinking)).toBe("medium");
  expect((await patch(admin, { atomikThinking: "low" })).status).toBe(200);
  expect(await inTenant(ws, workspaceThinking)).toBe("low");
  /* A stored value that is not a setting (written behind the route) reads as the default. */
  const { setSetting } = await import("../../lib/settings");
  await inTenant(ws, () => setSetting("atomikThinking", OTHER_CLAUDE[0], admin.id));
  expect(await inTenant(ws, workspaceThinking)).toBe("medium");
});

test("a sent model or effort is ignored, never refused: every route runs the setting's model, at its effort", async () => {
  const ws = await funded("routes");
  const { setSetting } = await import("../../lib/settings");
  const atomik = await import("../../lib/atomik"), paidText = await import("../../lib/paidText"), read = await import("../../lib/atomikMemoryRead");
  /* What each route quotes with, read on the server side of the route (a member is sent the price only: tests/unit/atomikNoModelDisclosure.spec.ts). */
  const picked: { model: string; effort?: string }[] = [];
  const turn = await route("app/api/atomik/[id]/route.ts", { "@/lib/atomik": { ...atomik, runTurn: async (id: string, opts: { quoteOnly?: boolean }) => {
    const result = await atomik.runTurn(id, opts as never);
    if (opts.quoteOnly) picked.push({ model: (result as { model: string }).model, effort: (result as { effort: string }).effort });
    return result;
  } } });
  const ideas = await route("app/api/atomik/ideas/draft/route.ts", { "@/lib/paidText": { ...paidText, quotePaidText: async (input: { model: string; effort?: string }, model?: CatalogModel) => {
    picked.push({ model: input.model, effort: input.effort });
    return paidText.quotePaidText(input as never, model);
  } } });
  const memory = await route("app/api/atomik/memory/read/route.ts", { "@/lib/atomikMemoryRead": { ...read, quoteMemoryRead: (input: { text: string; model: string; effort?: string }, model?: CatalogModel) => {
    picked.push({ model: input.model, effort: input.effort });
    return read.quoteMemoryRead(input, model);
  } } });
  const last = () => picked.at(-1);
  const SENT = [{}, { model: GROK[0], effort: "low" }, { model: GPT, effort: "max" }, { model: GEMINI[0] }, { model: OTHER_CLAUDE[0], effort: "none" }, { model: 7, effort: "not an effort!" }];
  for (const [setting, plan, routine] of [["medium", MEDIUM, LOW], ["low", LOW, LOW], ["high", HIGH, HIGH]] as const) {
    await inTenant(ws, () => setSetting("atomikThinking", setting, admin.id));
    for (const sent of SENT) {
      const label = `${setting} ${JSON.stringify(sent)}`;
      const chat = await inTenant(ws, async () => {
        const id = await atomik.createChat({ userId: admin.id, projectId: null, model: GPT, agentMode: "ask" });
        return answer(await turn.POST!(post(`https://particl.test/api/atomik/${id}`, { quoteOnly: true, text: "Plan two shots at the market.", ...sent }), { params: Promise.resolve({ id }) }));
      });
      expect(chat.status, `chat turn: ${label}`).toBe(200);
      expect(last(), `chat turn: ${label}`).toEqual({ model: plan, effort: "high" });
      const idea = await inTenant(ws, async () => answer(await ideas.POST!(post("https://particl.test/api/atomik/ideas/draft", { quoteOnly: true, brief: "A lighthouse keeper's last night.", ...sent }))));
      expect(idea.status, `ideas: ${label}`).toBe(200);
      expect(last(), `ideas: ${label}`).toEqual({ model: plan, effort: "high" });
      const readQuote = await inTenant(ws, async () => answer(await memory.POST!(post("https://particl.test/api/atomik/memory/read", { quoteOnly: true, text: "Our tone is warm and quiet.", ...sent }))));
      expect(readQuote.status, `memory read: ${label}`).toBe(200);
      expect(last(), `memory read: ${label}`).toEqual({ model: routine, effort: "high" });
    }
  }
  /* A paid run: the quote's ceiling approved, the setting's model run (the mocked engine), whatever the body named. */
  await inTenant(ws, () => setSetting("atomikThinking", "medium", admin.id));
  const quote = await inTenant(ws, async () => answer(await ideas.POST!(post("https://particl.test/api/atomik/ideas/draft", { quoteOnly: true, brief: "A lighthouse keeper's last night." }))));
  const ran = await inTenant(ws, async () => answer(await ideas.POST!(post("https://particl.test/api/atomik/ideas/draft", { brief: "A lighthouse keeper's last night.", model: GPT, effort: "low", maxCredits: quote.body.estimateCredits }))));
  expect(ran.status, JSON.stringify(ran.body)).toBe(200);
  const { db } = await import("../../lib/db");
  const job = await inTenant(ws, async () => (await db().execute("SELECT model, effort FROM paid_text_jobs ORDER BY created_at DESC LIMIT 1")).rows[0]);
  expect({ model: job.model, effort: job.effort }).toEqual({ model: MEDIUM, effort: "high" });
  /* Every run of Atomik's thinking needs the ceiling its person approved, whatever the caller sent: without one it is refused before anything is claimed. */
  for (const body of [{ brief: "Another night." }, { brief: "Another night.", effort: "auto" }]) {
    const unapproved = await inTenant(ws, async () => answer(await ideas.POST!(post("https://particl.test/api/atomik/ideas/draft", body))));
    expect(unapproved.status, JSON.stringify(body)).toBe(409);
  }
});

test("the setting's effort makes the estimate, and without an approved ceiling a run keeps the older $1 safety cap", async () => {
  const ws = await funded("cap");
  const { quotePaidText, runPaidText } = await import("../../lib/paidText");
  /* A fixture writer at the setting's model and effort, priced (a made-up rate) so its estimate sits between the two caps. */
  const writer: CatalogModel = { id: MEDIUM, name: "Fixture", owner: "anthropic", type: "language", description: "", contextWindow: 1_000_000, maxTokens: 128_000,
    pricing: { input: "0.0000001", output: "0.0002" }, tags: ["reasoning"], reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }] };
  const call = { model: MEDIUM, effort: "high", maxTokens: 900, kind: "idea", mock: "idea" as const, messages: [{ role: "user", content: "A lighthouse." }] };
  await inTenant(ws, async () => {
    const quote = await quotePaidText(call, writer);
    expect(quote.estimateUsd).toBeGreaterThan(1);
    expect(quote.estimateUsd).toBeLessThan(10);
    let sent = 0;
    const submit = async () => { sent++; return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"logline":"A film"}' } }], usage: { cost: 0.01 } }) }; };
    /* No approved ceiling, none required (the caller sent no effort): the older cap refuses it before anything is claimed or sent. */
    await expect(runPaidText({ ...call, id: `cap_none_${randomUUID()}`, ceilingRequired: false }, { model: writer, submit })).rejects.toThrow("request budget");
    /* A ceiling required and missing: refused the same way, before anything is claimed. */
    await expect(runPaidText({ ...call, id: `cap_req_${randomUUID()}` }, { model: writer, submit })).rejects.toThrow("Review a writing quote");
    expect(sent).toBe(0);
    /* Under the ceiling its person approved on the quote, it runs. */
    await runPaidText({ ...call, id: `cap_ok_${randomUUID()}`, maxCredits: quote.estimateCredits }, { model: writer, submit });
    expect(sent).toBe(1);
  });
});

test("a chat saved on any model still answers: its stored model is not asked, never refused, and the turn's row keeps what ran", async () => {
  const ws = await funded("chats");
  const atomik = await import("../../lib/atomik");
  for (const stored of [GEMINI[0], GROK[0], OPENAI.at(-1)!, OTHER_CLAUDE[0], "auto", "nonsense/model"]) {
    const loaded = await inTenant(ws, async () => {
      const id = await atomik.createChat({ userId: admin.id, projectId: null, model: stored, effort: "xhigh", agentMode: "ask" });
      /* A PATCH naming a model saves nothing and refuses nothing. */
      await atomik.patchChat(id, { title: "Renamed" });
      return atomik.getChat(id);
    });
    expect(loaded?.chat.modelNote, stored).toBeUndefined();
    /* Only the slots' models are Atomik's (owner, 23 Oct 2026): any other stored id, Claude or not, reads as auto. */
    expect(loaded?.chat.model, stored).toBe("auto");
  }
  /* A turn in a chat stored on Grok, sent with an OpenAI id: it runs the setting's model, and the chat row and the turn keep what ran. */
  const turn = await route("app/api/atomik/[id]/route.ts");
  const { db } = await import("../../lib/db");
  const after = await inTenant(ws, async () => {
    const id = await atomik.createChat({ userId: admin.id, projectId: null, model: GROK[0], agentMode: "ask" });
    const quoted = await answer(await turn.POST!(post(`https://particl.test/api/atomik/${id}`, { quoteOnly: true, text: "Plan one shot." }), { params: Promise.resolve({ id }) }));
    const sent = await answer(await turn.POST!(post(`https://particl.test/api/atomik/${id}`, { text: "Plan one shot.", model: GPT, effort: "low", maxCredits: quoted.body.estimateCredits }), { params: Promise.resolve({ id }) }));
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const row = (await db().execute({ sql: "SELECT model, effort FROM atomik_chats WHERE id=?", args: [id] })).rows[0];
    const message = (await db().execute({ sql: "SELECT model, effort FROM atomik_messages WHERE chat_id=? AND role='assistant'", args: [id] })).rows[0];
    /* A turn that sends an effort (as the page does) without the approved ceiling is refused before anything is claimed. */
    const unapproved = await answer(await turn.POST!(post(`https://particl.test/api/atomik/${id}`, { text: "And another.", effort: "auto" }), { params: Promise.resolve({ id }) }));
    return { row: { ...row }, message: { ...message }, unapproved: unapproved.status };
  });
  expect(after).toEqual({ row: { model: MEDIUM, effort: "high" }, message: { model: MEDIUM, effort: "high" }, unapproved: 409 });
});

test("the Treatment writer: unset, a scene rewrite is refused before anything is quoted or charged, naming no model; set, it writes the prose", async () => {
  const ws = await funded("treatment");
  const prior = process.env.TREATMENT_WRITER_MODEL;
  const { platformDb } = await import("../../lib/platform");
  const money = async () => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [ws.id] })).rows[0].n);
  try {
    delete process.env.TREATMENT_WRITER_MODEL;
    const scene = await route("app/api/atomik/treatment/scene/route.ts");
    for (const body of [{ projectId: "p1", n: 1, quoteOnly: true }, { projectId: "p1", n: 1, maxCredits: 50 }, { projectId: "p1", n: 1, maxCredits: 50, model: GPT }]) {
      const refused = await inTenant(ws, async () => answer(await scene.POST!(post("https://particl.test/api/atomik/treatment/scene", body))));
      expect(refused, JSON.stringify(body)).toEqual({ status: 503, body: { error: "The Treatment writer is not set up. Nothing billed.", code: "treatment_writer_off", charged: 0, nothingBilled: true } });
    }
    expect(await money()).toBe(0);
    const { db } = await import("../../lib/db");
    expect(await inTenant(ws, async () => (await db().execute("SELECT COUNT(*) AS n FROM generation_requests").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n)).toBe(0);
    /* Set (an OpenAI id from the owner's console; a catalogue one here), the scene's prose runs on it: the policy's model, not Atomik's thinking. */
    const { staticCatalog } = await import("../../lib/catalog");
    const served = staticCatalog().find((m) => (OPENAI as readonly string[]).includes(m.id) && m.id.startsWith("openai/gpt-") && m.type === "language")!.id;
    process.env.TREATMENT_WRITER_MODEL = served.slice("openai/".length);
    const { textJobPick } = await import("../../lib/atomikThinking");
    expect(await inTenant(ws, () => textJobPick("treatment"))).toMatchObject({ model: served });
    /* An id the catalogue does not serve is refused the same way, in its own plain words. */
    process.env.TREATMENT_WRITER_MODEL = "gpt-not-a-served-model";
    await expect(inTenant(ws, () => textJobPick("treatment"))).rejects.toThrow("The Treatment writer isn't connected right now. Nothing billed.");
  } finally { if (prior === undefined) delete process.env.TREATMENT_WRITER_MODEL; else process.env.TREATMENT_WRITER_MODEL = prior; }
});

test("ideas, shot lists and a scene need the approved ceiling even when the second read of the setting or the catalogue throws, or the setting changed between the reads", async () => {
  const ws = await funded("closed");
  const atomik = await import("../../lib/atomik");
  const { setSetting } = await import("../../lib/settings");
  const { forgetCatalogCache } = await import("../../lib/catalog");
  const { thinkingRun } = await import("../../lib/atomikThinking");
  /* The first read gave the setting's model; the second disagrees (an admin changed the setting meanwhile): still ours, still ceilinged. */
  await inTenant(ws, () => setSetting("atomikThinking", "low", admin.id));
  expect(await inTenant(ws, () => thinkingRun("writing", MEDIUM))).toMatchObject({ ours: true });
  /* Every run of Atomik's thinking is ours, whatever model a caller names (owner, 23 Oct 2026): a stand-in is never an exemption from the ceiling. */
  expect(await inTenant(ws, () => thinkingRun("writing", "test/stand-in"))).toMatchObject({ ours: true });
  await inTenant(ws, () => setSetting("atomikThinking", "medium", admin.id));
  const ideas = await route("app/api/atomik/ideas/draft/route.ts", { "@/lib/atomik": { ...atomik, resolveModel: async () => MEDIUM } });
  const saved = { catalog: process.env.MODEL_CATALOG, fetch: globalThis.fetch };
  try {
    /* The catalogue read fails (the live list, unreachable): the second read throws, and the run fails closed. */
    process.env.MODEL_CATALOG = "gateway"; forgetCatalogCache();
    globalThis.fetch = (async () => { throw new Error("No network in this test."); }) as typeof fetch;
    expect(await inTenant(ws, () => thinkingRun("writing", MEDIUM))).toEqual({ ours: true });
    const refused = await inTenant(ws, async () => answer(await ideas.POST!(post("https://particl.test/api/atomik/ideas/draft", { brief: "A lighthouse keeper's last night." }))));
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toBe("Review a writing quote before running with reasoning effort.");
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.catalog === undefined) delete process.env.MODEL_CATALOG; else process.env.MODEL_CATALOG = saved.catalog;
    forgetCatalogCache();
  }
});

test("gateway settlement never bills past the estimate: usage.cost at twice the estimate bills the estimate, and the raw cost stays for the admin", async () => {
  const ws = await funded("gateway-cap");
  const { quotePaidText, runPaidText } = await import("../../lib/paidText");
  const { platformDb } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  const writer: CatalogModel = { id: MEDIUM, name: "Fixture", owner: "anthropic", type: "language", description: "", contextWindow: 1_000_000, maxTokens: 128_000,
    pricing: { input: "0.000001", output: "0.000005" }, tags: ["reasoning"], reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }] };
  const call = { model: MEDIUM, effort: "high", maxTokens: 900, kind: "idea", mock: "idea" as const, messages: [{ role: "user", content: "A lighthouse." }] };
  const priorMock = process.env.ENGINE_MOCK, priorDirect = process.env.TEXT_DIRECT;
  /* The gateway door: no direct vendor for Claude, and the provider's reply (mocked here, never sent) reports its own usage.cost. */
  delete process.env.TEXT_DIRECT;
  try {
    await inTenant(ws, async () => {
      const quote = await quotePaidText(call, writer);
      const usd = quote.estimateUsd!;
      const id = `gw_cap_${randomUUID()}`;
      delete process.env.ENGINE_MOCK;
      const result = await runPaidText({ ...call, id, maxCredits: quote.estimateCredits }, { model: writer,
        submit: async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"logline":"A film"}' } }], usage: { cost: usd * 2 } }) }) });
      process.env.ENGINE_MOCK = "1";
      const billed = (await platformDb().execute({ sql: "SELECT billed_credits, engine_cost_usd FROM meter_events WHERE workspace_id=? AND id=?", args: [ws.id, id] })).rows[0];
      const { billCredits } = await import("../../lib/creditTerms");
      expect(billCredits(usd * 2, "text"), "uncapped, it would have billed more").toBeGreaterThan(quote.estimateCredits);
      expect(Number(billed.billed_credits)).toBe(quote.estimateCredits);
      expect(Number(billed.engine_cost_usd)).toBeCloseTo(usd, 12);
      expect(result.credits).toBe(quote.estimateCredits);
      /* What it really cost, for the platform admin. */
      expect(Number((await db().execute({ sql: "SELECT cost_usd FROM paid_text_jobs WHERE id=?", args: [id] })).rows[0].cost_usd)).toBeCloseTo(usd * 2, 12);
    });
  } finally {
    if (priorMock === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = priorMock;
    if (priorDirect === undefined) delete process.env.TEXT_DIRECT; else process.env.TEXT_DIRECT = priorDirect;
  }
});

/** lib/atomik.ts compiled as it ships, its paid-text door's provider answered here (never sent): every other module the real one. */
async function atomikWithReply(usageCost: (estimateUsd: number) => number) {
  const ts = (await import("typescript")).default;
  const { readFileSync, existsSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const nodeRequire = createRequire(path.resolve("package.json"));
  const paidText = await import("../../lib/paidText");
  const file = path.resolve("lib/atomik.ts");
  const resolve = (name: string) => {
    const base = name.startsWith("@/") ? path.resolve(name.slice(2)) : path.resolve(path.dirname(file), name);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) if (existsSync(candidate)) return candidate;
    return base;
  };
  const wrapped = { ...paidText, runPaidText: async (input: Parameters<typeof paidText.runPaidText>[0], overrides: Parameters<typeof paidText.runPaidText>[1] = {}) => {
    const quote = await paidText.quotePaidText(input);
    return paidText.runPaidText(input, { ...overrides, submit: async () => ({ ok: true, status: 200, text: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ say: "Two shots at the market.", activity: [], propose: [] }) } }], usage: { cost: usageCost(quote.estimateUsd!) } }) }) });
  } };
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} as typeof import("../../lib/atomik") };
  new Function("require", "module", "exports", source)((name: string) => (name === "./paidText" ? wrapped : name.startsWith("@/") || name.startsWith(".") ? nodeRequire(resolve(name)) : nodeRequire(name)), mod, mod.exports);
  return mod.exports;
}

test("a chat turn through the route never bills past its estimate: usage.cost at twice the estimate debits exactly the estimate's credits", async () => {
  const ws = await funded("turn-cap");
  const { platformDb } = await import("../../lib/platform");
  const { billCredits } = await import("../../lib/creditTerms");
  let estimate = 0;
  const atomik = await atomikWithReply((usd) => { estimate = usd; return usd * 2; });
  const turn = await route("app/api/atomik/[id]/route.ts", { "@/lib/atomik": atomik });
  const priorDirect = process.env.TEXT_DIRECT;
  delete process.env.TEXT_DIRECT;
  try {
    await inTenant(ws, async () => {
      const id = await atomik.createChat({ userId: admin.id, projectId: null, model: "auto", agentMode: "ask" });
      const quote = await answer(await turn.POST!(post(`https://particl.test/api/atomik/${id}`, { quoteOnly: true, text: "Plan two shots." }), { params: Promise.resolve({ id }) }));
      const sent = await answer(await turn.POST!(post(`https://particl.test/api/atomik/${id}`, { text: "Plan two shots.", maxCredits: quote.body.estimateCredits }), { params: Promise.resolve({ id }) }));
      expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
      const { db } = await import("../../lib/db");
      const messageId = String((await db().execute({ sql: "SELECT id FROM atomik_messages WHERE chat_id=? AND role='assistant'", args: [id] })).rows[0].id);
      const line = (await platformDb().execute({ sql: "SELECT billed_credits, engine_cost_usd, overrun_usd FROM meter_events WHERE workspace_id=? AND id=?", args: [ws.id, messageId] })).rows[0];
      const debit = (await platformDb().execute({ sql: "SELECT credits FROM billing_debits WHERE workspace_id=? AND event_id=?", args: [ws.id, messageId] })).rows[0];
      expect(billCredits(estimate * 2, "text"), "uncapped, it would have billed more").toBeGreaterThan(Number(quote.body.estimateCredits));
      expect(Number(line.billed_credits)).toBe(quote.body.estimateCredits);
      expect(Number(debit.credits)).toBe(quote.body.estimateCredits);
      expect(Number(line.engine_cost_usd)).toBeCloseTo(estimate, 12);
      expect(Number(line.overrun_usd)).toBeCloseTo(estimate, 12);
    });
  } finally { if (priorDirect === undefined) delete process.env.TEXT_DIRECT; else process.env.TEXT_DIRECT = priorDirect; }
});

test("the paid-text recovery path never bills past the estimate: an answer that settled, then could not be returned, bills the estimate", async () => {
  const ws = await funded("recovery-cap");
  const { quotePaidText, runPaidText } = await import("../../lib/paidText");
  const { platformDb } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  const writer: CatalogModel = { id: MEDIUM, name: "Fixture", owner: "anthropic", type: "language", description: "", contextWindow: 1_000_000, maxTokens: 128_000,
    pricing: { input: "0.000001", output: "0.000005" }, tags: ["reasoning"], reasoningOptions: [{ type: "effort", values: ["low", "medium", "high"] }] };
  const call = { model: MEDIUM, effort: "high", maxTokens: 900, kind: "idea", mock: "idea" as const, messages: [{ role: "user", content: "A lighthouse." }], recordSpend: false };
  const priorDirect = process.env.TEXT_DIRECT;
  delete process.env.TEXT_DIRECT;
  try {
    await inTenant(ws, async () => {
      const quote = await quotePaidText(call, writer);
      const usd = quote.estimateUsd!, id = `rec_cap_${randomUUID()}`;
      /* The job row settles, then the spend line cannot be written (its table is gone): the recovery path meters it. */
      await db().execute("DROP TABLE IF EXISTS atomik_spend");
      await expect(runPaidText({ ...call, id, maxCredits: quote.estimateCredits }, { model: writer,
        submit: async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: '{"logline":"A film"}' } }], usage: { cost: usd * 2 } }) }) }))
        .rejects.toThrow("could not be returned");
      const line = (await platformDb().execute({ sql: "SELECT billed_credits, engine_cost_usd, overrun_usd FROM meter_events WHERE workspace_id=? AND id=?", args: [ws.id, id] })).rows[0];
      expect(Number(line.billed_credits)).toBe(quote.estimateCredits);
      expect(Number(line.engine_cost_usd)).toBeCloseTo(usd, 12);
      expect(Number(line.overrun_usd)).toBeCloseTo(usd, 12);
      expect(Number((await db().execute({ sql: "SELECT cost_usd FROM paid_text_jobs WHERE id=?", args: [id] })).rows[0].cost_usd)).toBeCloseTo(usd * 2, 12);
    });
  } finally { if (priorDirect === undefined) delete process.env.TEXT_DIRECT; else process.env.TEXT_DIRECT = priorDirect; }
});

test("three Claude models only: every Atomik entry point resolves to one of the slots' models, and nothing else is ever picked (owner, 23 Oct 2026)", async () => {
  const { staticCatalog } = await import("../../lib/catalog");
  const { atomikModels } = await import("../../lib/workbench/atomik-server");
  const { developmentModels } = await import("../../lib/workbench/development-server");
  const { selectPlannerModel } = await import("../../lib/workbench/rig-agent-planner");
  const { resolveModel } = await import("../../lib/atomik");
  const three = [HIGH, MEDIUM, LOW];
  expect(atomikModelIds()).toEqual(three);
  const served = staticCatalog();
  /* Every Claude id the catalogue serves is there, the older and the cheaper ones among them; only the three are ever chosen. */
  expect(served.filter((m) => m.id.startsWith("anthropic/")).length).toBeGreaterThan(3);
  for (const setting of THINKING_SETTINGS) for (const turn of ATOMIK_TURNS) {
    expect(three, `${setting} ${turn}`).toContain(thinkingFor(setting, turn).model);
    expect(three, `${setting} ${turn}`).toContain(selectAtomikThinking(setting, turn, served)?.model);
  }
  /* The menus Studio Atomik, development and the board planner choose from are the three. */
  expect(atomikModels(served).map((m) => m.id).sort()).toEqual([...three].sort());
  expect(developmentModels(served).map((m) => m.id).sort()).toEqual([...three].sort());
  for (const id of OTHER_CLAUDE) expect(() => selectPlannerModel(id, served), id).toThrow(THINKING_UNAVAILABLE);
  /* Only cheaper Claude models outside the three served (at half the Low slot's catalogue rates): nothing qualifies, and the turn is refused. */
  const lowRates = served.find((m) => m.id === LOW)!.pricing as unknown as Record<string, string>;
  const half = Object.fromEntries(["input", "output", "input_cache_read", "input_cache_write"].map((key) => [key, String(Number(lowRates[key]) / 2)]));
  const cheap = (id: string): CatalogModel => ({ id, name: id, owner: "anthropic", type: "language", description: "", contextWindow: 200_000, maxTokens: 8_000, pricing: half as never });
  const others = OTHER_CLAUDE.map(cheap);
  for (const setting of THINKING_SETTINGS) for (const turn of ATOMIK_TURNS) expect(selectAtomikThinking(setting, turn, others), `${setting} ${turn}`).toBeNull();
  /* The text routes' resolver, for every Atomik turn. */
  for (const turn of [...ATOMIK_TURNS, "idea", "shot"] as const) expect(three, turn).toContain(await resolveModel("auto", turn));
});

test("an unset slot is refused before anything is quoted, claimed or saved, and nothing stands in for it: nothing billed", async () => {
  const ws = await funded("unset");
  const { staticCatalog } = await import("../../lib/catalog");
  const { textJobPick } = await import("../../lib/atomikThinking");
  const { platformDb } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  const served = staticCatalog();
  const money = async () => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [ws.id] })).rows[0].n);
  const ideas = await route("app/api/atomik/ideas/draft/route.ts");
  const ask = (body: Record<string, unknown>) => inTenant(ws, async () => answer(await ideas.POST!(post("https://particl.test/api/atomik/ideas/draft", { brief: "A lighthouse keeper's last night.", ...body }))));
  const shots = await route("app/api/atomik/shots/draft/route.ts"), memory = await route("app/api/atomik/memory/read/route.ts"), turn = await route("app/api/atomik/[id]/route.ts");
  const atomik = await import("../../lib/atomik");
  const chatId = await inTenant(ws, () => atomik.createChat({ userId: admin.id, projectId: null, model: "auto", agentMode: "ask" }));
  const rows = (sql: string) => inTenant(ws, async () => Number((await db().execute(sql).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n));
  await withSlotEnv({ [thinkingModelEnv("medium")]: undefined }, async () => {
    expect(atomikThinkingSlots().medium).toEqual({ model: null, effort: "high" });
    /* Medium's turns are refused even though High's and Low's models are served: no other slot stands in for an empty one. */
    expect(selectAtomikThinking("medium", "plan", served)).toBeNull();
    await expect(inTenant(ws, () => textJobPick("writing"))).rejects.toMatchObject({ message: THINKING_UNAVAILABLE, status: 503 });
    expect((await ask({ quoteOnly: true })).status).toBe(503);
    expect(await ask({ maxCredits: 50 })).toMatchObject({ status: 503, body: { error: THINKING_UNAVAILABLE } });
    /* The run paths refuse before the request is claimed and before a chat saves the message: a shot list, a chat turn. */
    expect(await inTenant(ws, async () => answer(await shots.POST!(post("https://particl.test/api/atomik/shots/draft", { projectId: "p1", scene: 1, maxCredits: 50 }))))).toMatchObject({ status: 503, body: { error: THINKING_UNAVAILABLE } });
    const sent = await inTenant(ws, async () => answer(await turn.POST!(post(`https://particl.test/api/atomik/${chatId}`, { text: "Plan one shot.", maxCredits: 50 }), { params: Promise.resolve({ id: chatId }) })));
    expect(sent).toMatchObject({ status: 503, body: { error: THINKING_UNAVAILABLE } });
    /* A turn that runs at Low under Medium (the judge, a routine turn) still runs: only the empty slot is refused. */
    expect(selectAtomikThinking("medium", "judge", served)?.model).toBe(LOW);
  });
  /* Low's slot unset: the memory read (a routine turn) is refused the same way. */
  await withSlotEnv({ [thinkingModelEnv("low")]: undefined }, async () => {
    expect(await inTenant(ws, async () => answer(await memory.POST!(post("https://particl.test/api/atomik/memory/read", { text: "Our tone is warm.", maxCredits: 50 }))))).toMatchObject({ status: 503, body: { error: THINKING_UNAVAILABLE } });
  });
  /* Nothing was claimed, metered or written: no request claim, no paid job, no saved message. */
  expect(await money()).toBe(0);
  expect(await rows("SELECT COUNT(*) AS n FROM paid_text_jobs")).toBe(0);
  expect(await rows("SELECT COUNT(*) AS n FROM generation_requests")).toBe(0);
  expect(await rows(`SELECT COUNT(*) AS n FROM atomik_messages WHERE chat_id='${chatId}'`)).toBe(0);
  /* The same run with the slot set is claimed once, so the counts above are not empty for want of a table. */
  const quote = await ask({ quoteOnly: true });
  expect((await ask({ maxCredits: quote.body.estimateCredits })).status).toBe(200);
  expect(await rows("SELECT COUNT(*) AS n FROM generation_requests")).toBe(1);
  /* Every slot unset: every turn at every setting is refused. */
  await withSlotEnv(Object.fromEntries(THINKING_SETTINGS.map((setting) => [thinkingModelEnv(setting), undefined])), () => {
    for (const setting of THINKING_SETTINGS) for (const turn of ATOMIK_TURNS) expect(selectAtomikThinking(setting, turn, served), `${setting} ${turn}`).toBeNull();
  });
});

test("a retry of a request already answered gets its saved reply when the slot is empty now; only a new request is refused", async () => {
  const ws = await funded("replay");
  const ideas = await route("app/api/atomik/ideas/draft/route.ts");
  const { platformDb } = await import("../../lib/platform");
  const money = async () => Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [ws.id] })).rows[0].n);
  const send = (body: Record<string, unknown>, key: string) => inTenant(ws, async () => {
    const res = await ideas.POST!(new Request("https://particl.test/api/atomik/ideas/draft", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }));
    return { status: res.status, replayed: res.headers.get("Idempotency-Replayed"), body: await res.json() as Record<string, unknown> };
  });
  const brief = { brief: "A lighthouse keeper's last night." };
  const quote = await send({ ...brief, quoteOnly: true }, `think-${randomUUID()}`);
  const key = `think-${randomUUID()}`, body = { ...brief, maxCredits: quote.body.estimateCredits };
  const first = await send(body, key);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  const billed = await money();
  await withSlotEnv({ [thinkingModelEnv("medium")]: undefined }, async () => {
    /* The same key: its saved reply, replayed, not "isn't connected", and nothing billed again. */
    expect(await send(body, key)).toEqual({ status: 200, replayed: "true", body: first.body });
    /* A new key: refused before anything is claimed. */
    expect(await send(body, `think-${randomUUID()}`)).toMatchObject({ status: 503, body: { error: THINKING_UNAVAILABLE } });
  });
  expect(await money()).toBe(billed);
});

test("a slot naming an id outside the verified Claude catalogue is refused the same way, whatever the catalogue serves", async () => {
  const ws = await funded("outside");
  const { staticCatalog } = await import("../../lib/catalog");
  const { textJobPick } = await import("../../lib/atomikThinking");
  const { platformDb } = await import("../../lib/platform");
  const served = staticCatalog();
  const ideas = await route("app/api/atomik/ideas/draft/route.ts");
  for (const id of [NOT_VERIFIED, GROK[0], GPT, GEMINI[0], DIRECT_MODEL_IDS[MEDIUM]]) {
    /* Served beside the real slots, priced and even cheaper: an id that is not a verified Claude id is never a slot. */
    const offered: CatalogModel = { id, name: id, owner: id.split("/")[0], type: "language", description: "", contextWindow: 200_000, maxTokens: 8_000, pricing: { input: "0", output: "0" } };
    await withSlotEnv({ [thinkingModelEnv("medium")]: id }, async () => {
      expect(atomikThinkingSlots().medium.model, id).toBeNull();
      expect(isAtomikModel(id), id).toBe(false);
      expect(selectAtomikThinking("medium", "plan", [...served, offered]), id).toBeNull();
      await expect(inTenant(ws, () => textJobPick("plan")), id).rejects.toMatchObject({ message: THINKING_UNAVAILABLE });
      const refused = await inTenant(ws, async () => answer(await ideas.POST!(post("https://particl.test/api/atomik/ideas/draft", { quoteOnly: true, brief: "A night." }))));
      expect(refused.status, id).toBe(503);
    });
  }
  expect(Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [ws.id] })).rows[0].n)).toBe(0);
});

test("the test slot picker tries every ordered triple, gives none (never a throw) when there is none, and reads the whole verified list", () => {
  const at = (input: number, cache: number) => ({ input, output: input, input_cache_read: cache, input_cache_write: cache });
  const entry = (id: string, pricing: Record<string, number>) => ({ id, pricing, reasoningOptions: [{ type: "effort", values: ["high"] }] });
  /* The dearest entry has nothing under it on every rate, so a greedy pick from it finds no three; another triple exists, and is kept. */
  const entries = [entry("t/top", at(100, 0.5)), entry("t/a", at(10, 10)), entry("t/b", at(5, 5)), entry("t/c", at(1, 1))];
  expect(pickThinkingSlots(entries, entries.map((e) => e.id))).toEqual({ high: "t/a", medium: "t/b", low: "t/c" });
  /* No three: none, and nothing thrown. */
  expect(pickThinkingSlots(entries.slice(0, 2), entries.map((e) => e.id))).toBeNull();
  expect(thinkingSlotEnv(path.join(dir, "no-such-checkout"))).toEqual({});
  /* Every verified Claude id with a direct door is a candidate: the list is read from its own declaration, not cut short. */
  const candidates = slotCandidates();
  expect(candidates.length).toBeGreaterThan(3);
  for (const id of candidates) expect(CLAUDE_MODEL_IDS, id).toContain(id);
  expect(candidates).toEqual(CLAUDE_MODEL_IDS.filter((id) => id in DIRECT_MODEL_IDS));
});
