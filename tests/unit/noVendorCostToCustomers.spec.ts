import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import {
  loadRouteModule, marginCreditFindings, secretFindings, vendorCostFindings, vendorFigures,
  type Finding, type ScanOptions,
} from "../helpers/vendorCostScan";

/* Vendor cost figures never reach a customer of a workspace on the
   platform's keys (lib/creditTerms.ts: "margin ... never shown"). Every
   customer-reachable GET route below is called as the workspace's owner, an
   admin and a member, and its JSON is scanned (tests/helpers/vendorCostScan.ts)
   for a vendor-money key, any seeded vendor figure, and any job internal or
   credential. A workspace on its own keys is scanned too: its own dollars are
   allowed, credits beside them are not. To cover a new route, add one line to
   ROUTES. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-no-vendor-cost-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "tenant.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

/** What the vendors charged, each ending in a sixth decimal of 1 so every sum of them is recognisable. */
const COST = {
  take: 1.339101, writer: 0.021701, still: 0.043301, dub: 0.512901, dubRate: 0.238301, voice: 0.183701,
  demo: 0.731301, turn: 0.041901, stepEstimate: 0.871301,
};
const FIGURES = vendorFigures(Object.values(COST));
/** The workspace's own production cap in dollars: a field no credit workspace reads. */
const CAP_USD = 55.55;
/** Job internals a take's params carry for the queue, which no response may repeat. */
const INTERNALS = {
  paidClaim: 1, producedOutcome: { handle: "vendor-job-1" }, higgsfieldCredentialFingerprint: "fp_0123456789abcdef",
  higgsfieldVideoHandle: "hf-handle-1", higgsfieldVideoPollToken: "poll-token-1", storeUntil: 1,
};

const run = randomUUID().slice(0, 8);
function workspace(name: string, credits: boolean): TenantWorkspace {
  return {
    id: `ws_margin_${name}_${run}`, slug: `margin-${name}-${run}`, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: credits,
    allowanceUsd: 250, gatewayKeyId: null, ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: 10, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
  };
}
const person = (id: string, role: "admin" | "member", owner = false): TenantUser => ({
  id, email: `${id}@example.test`, name: id.replace("u_", ""), role, owner, disabled: false, lastSeen: null, createdAt: 0,
});
const ACTORS = { owner: person("u_owner", "admin", true), admin: person("u_admin", "admin"), member: person("u_member", "member") };

async function seed(ws: TenantWorkspace) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { crewReady } = await import("../../lib/crew/store");
  const { DEFAULT_MODEL_ID } = await import("../../lib/models");
  const { billCredits } = await import("../../lib/creditTerms");
  const at = Date.now() - 60_000;
  await runInTenant(ws, async () => {
    await ready();
    await crewReady();
    const take = `INSERT INTO generations(id,project_id,shot_id,kind,model,prompt,params,status,created_by,created_at,updated_at,
                    provider,cost_usd,refine_cost_usd,refine_model,token_id,stored_url,total_tokens)
                  VALUES(?,?,?,?,?,?,?,'succeeded',?,?,?,?,?,?,?,?,?,?)`;
    await db().batch([
      ...Object.values(ACTORS).map((u) => ({
        sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x',?,0)", args: [u.id, u.email, u.name, u.role],
      })),
      { sql: "INSERT INTO productions(id,name,client,status,cap_usd,created_at) VALUES('prod_margin','Harbour spot','',?,?,?)", args: ["active", CAP_USD, at] },
      { sql: "INSERT INTO projects(id,name,created_at,production_id,cap_usd,cap_credits) VALUES('p_margin','Harbour 30s',?,'prod_margin',?,555)", args: [at, CAP_USD] },
      { sql: "INSERT INTO shots(id,project_id,code,created_at,updated_at) VALUES('s_margin','p_margin','SH010',?,?)", args: [at, at] },
      { sql: take, args: ["g_take", "p_margin", "s_margin", "video", DEFAULT_MODEL_ID, "A harbour at dawn", JSON.stringify({ resolution: "1080p", duration: 5, ...INTERNALS }),
        "u_member", at, at, "byteplus", COST.take, COST.writer, "anthropic/claude-test", "tok_margin", "/api/media/g_take", 244800] },
      { sql: take, args: ["g_failed", "p_margin", "s_margin", "video", DEFAULT_MODEL_ID, "Failed harbour", "{}",
        "u_member", at + 10, at + 10, "xai", null, null, null, null, null, null] },
      { sql: take, args: ["g_still", "p_margin", "s_margin", "image", "gemini-3.1-flash-image", "A crane at dusk", "{}",
        "u_owner", at + 1, at + 1, "google", COST.still, null, null, null, "/api/media/g_still", null] },
      { sql: take, args: ["g_dub", "p_margin", null, "audio", "eleven_dubbing_v1", "Dub · harbour → French",
        JSON.stringify({ task: "dub", dubbingStatus: "dubbed", minutes: 2, usdPerMinute: COST.dubRate, rateUsdPerMinute: COST.dubRate, estUsd: COST.dub, estCredits: 0 }),
        "u_member", at + 2, at + 2, "elevenlabs", COST.dub, null, null, null, "/api/media/g_dub", null] },
      { sql: take, args: ["g_voice", "p_margin", null, "audio", "eleven_multilingual_sts_v2", "Voice change",
        JSON.stringify({ task: "voiceChange", estUsd: COST.voice, estCredits: 1234, credits: 1234, tier: "creator" }),
        "u_admin", at + 3, at + 3, "elevenlabs", COST.voice, null, null, null, "/api/media/g_voice", 1234] },
      /* A starter take: nothing was rendered, and its display price is the vendor's. */
      { sql: take, args: ["g_demo", "p_margin", "s_margin", "video", DEFAULT_MODEL_ID, "Demo take",
        JSON.stringify({ demo: true, demoCostUsd: COST.demo, resolution: "1080p", duration: 5 }),
        "u_owner", at + 4, at + 4, "byteplus", 0, null, null, null, "/fixtures/clip.mp4", null] },
      { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_usd,created_at) VALUES('tok_margin','hash_margin','Assistant','u_owner','render',20,?)", args: [at] },
      { sql: "INSERT INTO atomik_chats(id,project_id,title,model,agent_mode,status,text_cost_usd,created_by,created_at,updated_at,deleted) VALUES('ach_margin','p_margin','Harbour plan','auto','ask','waiting',?,'u_member',?,?,0)", args: [COST.turn, at, at] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,cost_usd,model,created_at) VALUES('amsg_margin','ach_margin','assistant','Two shots.',?,'anthropic/claude-test',?)", args: [COST.turn, at] },
      { sql: `INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,params,status,est_cost_usd,created_at,updated_at)
              VALUES('ast_margin','ach_margin','amsg_margin',0,'video','Harbour wide','A harbour at dawn',?,?,'proposed',?,?,?)`,
        args: [DEFAULT_MODEL_ID, JSON.stringify({ seconds: 5, ratio: "16:9", resolution: "1080p" }), COST.stepEstimate, at, at] },
      { sql: `INSERT INTO identities(id,project_id,name,status,provider,steps,cost_usd,created_by,created_at,updated_at,trained_at,lora_url)
              VALUES('id_margin','p_margin','Mara','ready','fal',1500,?,'u_owner',?,?,?,'https://example.invalid/lora.safetensors')`, args: [COST.still, at, at, at] },
      /* A room per person (rooms are their owner's), each with a round the vendor charged for. */
      ...Object.values(ACTORS).map((u) => ({
        sql: `INSERT INTO crew_sessions(id,owner,project_id,goal,context,model,rounds_run,spend_cr,spend_usd,created_by,created_at)
              VALUES(?,?,'wb_margin','Land the harbour open','{}','grok-test',1,?,?,?,?)`,
        args: [`crew_${u.id}`, u.id, ws.usesPlatformKeys ? 1 : null, COST.turn, u.id, at],
      })),
    ], "write");
    await db().execute({ sql: "UPDATE generations SET status='failed',error=?,provider_outcome=? WHERE id='g_failed'", args: [
      `Provider cost $${COST.take}; token=sk-private1234567890abcdefghijklmnop`,
      JSON.stringify({ v: 1, provider: "xai", stage: "run", code: "content_moderated", kind: "content_filter",
        message: `Provider cost $${COST.take}; token=sk-private1234567890abcdefghijklmnop`,
        billing: { state: "billed", amount: COST.take, unit: "usd", basis: "xai-ticks" }, funding: "platform", at }),
    ] });
  });
  /* A workspace skill saved from that plan: a template of its steps, engines and settings, never a figure. */
  const { skillsReady } = await import("../../lib/atomikSkills");
  await runInTenant(ws, async () => {
    await skillsReady();
    const template = { parameters: [{ key: "place", label: "Place", default: "harbour" }],
      steps: [{ kind: "video", title: "Harbour wide", prompt: "A {{place}} at dawn", model: DEFAULT_MODEL_ID, params: { seconds: 5, ratio: "16:9", resolution: "1080p" } }] };
    await db().batch([
      { sql: `INSERT INTO atomik_skills(workspace_id,id,slug,name,description,scope,owner_id,version,status,source_chat_id,created_at,updated_at)
              VALUES(?,'skl_margin01','harbour-plan','Harbour plan','A wide for any place.','workspace','u_member',1,'active','ach_margin',?,?)`, args: [ws.id, at, at] },
      { sql: `INSERT INTO atomik_skill_versions(workspace_id,skill_id,version,name,slug,description,scope,template,note,created_by,created_at)
              VALUES(?,'skl_margin01',1,'Harbour plan','harbour-plan','A wide for any place.','workspace',?,'Saved from a run','u_member',?)`, args: [ws.id, JSON.stringify(template), at] },
    ], "write");
  });
  await platformReady();
  const meter = `INSERT INTO meter_events(id,workspace_id,project_id,shot_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,'succeeded',?,?,?,?,?,?)`;
  const paid = ws.usesPlatformKeys ? 1 : 0;
  await platformDb().batch([
    { sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at) VALUES(?,?,500,'unit','manual',0)", args: [`grant_${ws.id}`, ws.id] },
    { sql: meter, args: [`g_take_${ws.id}`, ws.id, "p_margin", "s_margin", "video", "byteplus", DEFAULT_MODEL_ID, COST.take + COST.writer, paid ? billCredits(COST.take + COST.writer, DEFAULT_MODEL_ID) : 0, paid, "u_member", at, at] },
    { sql: meter, args: [`amsg_margin_${ws.id}`, ws.id, "p_margin", null, "text", "vercel", "anthropic/claude-test", COST.turn, paid ? billCredits(COST.turn, "text") : 0, paid, "u_member", at, at] },
  ], "write");
}

type Actor = TenantUser;
/** Customer-reachable GET routes. `allow` names what a route may carry, and why, at the line that allows it. */
type RouteCase = {
  name: string; file: string; url: string | ((user: Actor) => string);
  params?: Record<string, string> | ((user: Actor) => Record<string, string>);
  /** The workspace-scope header a route requires of a browser caller. */
  scoped?: boolean;
  allow?: ScanOptions;
  /** Also scanned in a workspace on its own keys for credits beside its dollars. */
  ownKeys?: boolean;
};
const ROUTES: RouteCase[] = [
  { name: "GET /api/projects", file: "app/api/projects/route.ts", url: "/api/projects", ownKeys: true },
  { name: "GET /api/shots", file: "app/api/shots/route.ts", url: "/api/shots?projectId=p_margin", ownKeys: true },
  { name: "GET /api/productions", file: "app/api/productions/route.ts", url: "/api/productions", ownKeys: true },
  { name: "GET /api/jobs", file: "app/api/jobs/route.ts", url: "/api/jobs?sync=0", ownKeys: true },
  { name: "GET /api/jobs/[id] (a failed provider job)", file: "app/api/jobs/[id]/route.ts", url: "/api/jobs/g_failed?sync=0", params: { id: "g_failed" } },
  { name: "GET /api/jobs/[id] (a dub)", file: "app/api/jobs/[id]/route.ts", url: "/api/jobs/g_dub?sync=0", params: { id: "g_dub" } },
  { name: "GET /api/jobs/[id] (a voice change)", file: "app/api/jobs/[id]/route.ts", url: "/api/jobs/g_voice?sync=0", params: { id: "g_voice" } },
  { name: "GET /api/jobs/[id] (a starter take)", file: "app/api/jobs/[id]/route.ts", url: "/api/jobs/g_demo?sync=0", params: { id: "g_demo" } },
  { name: "GET /api/atomik", file: "app/api/atomik/route.ts", url: "/api/atomik" },
  { name: "GET /api/atomik/[id]", file: "app/api/atomik/[id]/route.ts", url: "/api/atomik/ach_margin", params: { id: "ach_margin" } },
  { name: "GET /api/atomik/steps/[id]", file: "app/api/atomik/steps/[id]/route.ts", url: "/api/atomik/steps/ast_margin", params: { id: "ast_margin" } },
  { name: "GET /api/atomik/memory", file: "app/api/atomik/memory/route.ts", url: "/api/atomik/memory?projectId=p_margin", scoped: true },
  { name: "GET /api/atomik/skills", file: "app/api/atomik/skills/route.ts", url: "/api/atomik/skills" },
  { name: "GET /api/atomik/skills?runs=1", file: "app/api/atomik/skills/route.ts", url: "/api/atomik/skills?runs=1&projectId=p_margin" },
  { name: "GET /api/atomik/skills/[id]", file: "app/api/atomik/skills/[id]/route.ts", url: "/api/atomik/skills/skl_margin01", params: { id: "skl_margin01" } },
  { name: "GET /api/atomik/skills/[id]?version=1", file: "app/api/atomik/skills/[id]/route.ts", url: "/api/atomik/skills/skl_margin01?version=1", params: { id: "skl_margin01" } },
  { name: "GET /api/analytics", file: "app/api/analytics/route.ts", url: "/api/analytics", ownKeys: true },
  { name: "GET /api/usage", file: "app/api/usage/route.ts", url: "/api/usage" },
  { name: "GET /api/usage?rows=1", file: "app/api/usage/route.ts", url: "/api/usage?rows=1" },
  { name: "GET /api/usage/summary", file: "app/api/usage/summary/route.ts", url: "/api/usage/summary", ownKeys: true },
  /* `capUsd` is the ceiling the customer typed for their own token, in the dollars they pay, not a vendor figure. */
  { name: "GET /api/tokens", file: "app/api/tokens/route.ts", url: "/api/tokens", allow: { allowKeys: ["capUsd"] } },
  { name: "GET /api/workspaces/keys", file: "app/api/workspaces/keys/route.ts", url: "/api/workspaces/keys" },
  { name: "GET /api/me", file: "app/api/me/route.ts", url: "/api/me" },
  { name: "GET /api/identities", file: "app/api/identities/route.ts", url: "/api/identities" },
  { name: "GET /api/identities/[id]", file: "app/api/identities/[id]/route.ts", url: "/api/identities/id_margin", params: { id: "id_margin" } },
  { name: "GET /api/crew/sessions/[id]", file: "app/api/crew/sessions/[id]/route.ts", url: (u) => `/api/crew/sessions/crew_${u.id}`, params: (u) => ({ id: `crew_${u.id}` }), scoped: true },
  { name: "GET /api/audio", file: "app/api/audio/route.ts", url: "/api/audio" },
  { name: "GET /api/workbench/projects", file: "app/api/workbench/projects/route.ts", url: "/api/workbench/projects" },
];

type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function callAs(ws: TenantWorkspace, user: Actor, route: RouteCase): Promise<{ status: number; body: unknown }> {
  const { runInTenant } = await import("../../lib/tenant");
  const { workbenchScopeFor } = await import("../../lib/workbench/request-scope");
  const auth = await import("../../lib/auth");
  const mod = loadRouteModule<{ GET: Handler }>(route.file, {
    "@/lib/auth": {
      ...auth,
      withTenant: (fn: Handler) => (req: Request, ctx?: { params: Promise<Record<string, string>> }) =>
        runInTenant(ws, () => fn(req, ctx), { user, workspaces: [{ id: ws.id, slug: ws.slug, name: ws.name, role: user.owner ? "owner" : user.role }] }),
    },
  });
  const url = typeof route.url === "function" ? route.url(user) : route.url;
  const params = typeof route.params === "function" ? route.params(user) : route.params ?? {};
  const headers = route.scoped ? { "X-Workbench-Scope": workbenchScopeFor(ws.id, user.id) } : undefined;
  const res = await mod.GET(new Request(`https://studio.test${url}`, { headers }), { params: Promise.resolve(params) });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* scanned as text */ }
  return { status: res.status, body };
}

const credit = workspace("credit", true);
const ownKeys = workspace("own", false);
test.beforeAll(async () => {
  await seed(credit);
  await seed(ownKeys);
});

test("the scanner reports a money key, a vendor figure under any key, a dollar in a sentence, and job internals", () => {
  const body = {
    ok: { credits: 21, creditUsd: 0.1, rate: 0.9165, title: "Harbour 30s · 2x speed", fingerprint: "quote-fingerprint", requestKey: "atomik-step:1" },
    leaks: [{ costUsd: null, estCostUsd: 0.5 }, { spend: COST.take + COST.writer }, "Cost $1.36", "(19.87 spent)", "20.00 USD ceiling"],
  };
  expect(vendorCostFindings(body, { figures: FIGURES }).map((f) => f.at)).toEqual([
    "$.leaks[0].estCostUsd", "$.leaks[1].spend", "$.leaks[2]", "$.leaks[3]", "$.leaks[4]",
  ]);
  expect(secretFindings({ ok: body.ok, params: { paidClaim: 1, higgsfieldVideoPollToken: "t" }, note: "key sk-live0123456789abcdef" }).map((f) => f.at))
    .toEqual(["$.params.paidClaim", "$.params.higgsfieldVideoPollToken", "$.note"]);
  expect(marginCreditFindings({ projects: [{ spend: 1.2, credits: 18 }], generations: [{ params: { estCredits: 40 } }] }).map((f) => f.at))
    .toEqual(["$.projects[0].credits"]);
});

for (const route of ROUTES) {
  test(`${route.name}: no vendor cost or job internal reaches the owner, an admin or a member of a credit workspace`, async () => {
    const leaks: Record<string, Finding[]> = {};
    for (const [role, user] of Object.entries(ACTORS)) {
      const { status, body } = await callAs(credit, user, route);
      /* The owner reads every one of these, so a scan of an error page cannot pass for a clean one. */
      if (role === "owner") expect(status, `${role}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
      else expect(status, `${role}: ${JSON.stringify(body).slice(0, 300)}`).toBeLessThan(500);
      const found = [...vendorCostFindings(body, { figures: FIGURES, ...route.allow }), ...secretFindings(body)];
      if (found.length) leaks[role] = found;
    }
    expect(leaks).toEqual({});
  });
}

test("a workspace on its own keys reads its own dollars, never credits beside them, and no job internals", async () => {
  const leaks: Record<string, Finding[]> = {};
  for (const route of ROUTES) {
    const { status, body } = await callAs(ownKeys, ACTORS.owner, route);
    expect(status, `${route.name}: ${JSON.stringify(body).slice(0, 300)}`).toBeLessThan(500);
    const found = [...secretFindings(body), ...(route.ownKeys ? marginCreditFindings(body) : [])];
    if (found.length) leaks[route.name] = found;
  }
  expect(leaks).toEqual({});
  /* The control: its own dollars are there to read, so the scanner is not passing on an empty page. */
  for (const url of ["/api/projects", "/api/shots?projectId=p_margin", "/api/analytics"]) {
    const { body } = await callAs(ownKeys, ACTORS.owner, ROUTES.find((r) => r.url === url)!);
    expect(vendorCostFindings(body, { figures: FIGURES }).length, url).toBeGreaterThan(0);
  }
});

test("a cached project list is not reused after the workspace's billing unit changes", async () => {
  const route = ROUTES.find((item) => item.url === "/api/projects")!;
  const { body: original } = await callAs(ownKeys, ACTORS.owner, route);
  expect(original).toMatchObject({ unit: "usd" });
  const { status, body } = await callAs({ ...ownKeys, usesPlatformKeys: true }, ACTORS.owner, route);
  expect(status).toBe(200);
  expect(body).toMatchObject({ unit: "cr" });
  expect(vendorCostFindings(body, { figures: FIGURES })).toEqual([]);
  const { body: restored } = await callAs(ownKeys, ACTORS.owner, route);
  expect(restored).toMatchObject({ unit: "usd" });
  expect(vendorCostFindings(restored, { figures: FIGURES }).length).toBeGreaterThan(0);
});
