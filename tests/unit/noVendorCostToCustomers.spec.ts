import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import { loadRouteModule, vendorCostFindings, vendorFigures, type Finding, type ScanOptions } from "../helpers/vendorCostScan";

/* Vendor cost figures never reach a customer of a workspace on the
   platform's keys (lib/creditTerms.ts: "margin ... never shown"). Every
   customer-reachable GET route below is called as the workspace's owner, an
   admin and a member, and its JSON is scanned (tests/helpers/vendorCostScan.ts)
   for a vendor-money key or any seeded vendor figure. To cover a new route,
   add one line to ROUTES. */
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
  const { DEFAULT_MODEL_ID } = await import("../../lib/models");
  const at = Date.now() - 60_000;
  await runInTenant(ws, async () => {
    await ready();
    const take = `INSERT INTO generations(id,project_id,shot_id,kind,model,prompt,params,status,created_by,created_at,updated_at,
                    provider,cost_usd,refine_cost_usd,refine_model,token_id,stored_url)
                  VALUES(?,?,?,?,?,?,?,'succeeded',?,?,?,?,?,?,?,?,?)`;
    await db().batch([
      ...Object.values(ACTORS).map((u) => ({
        sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x',?,0)", args: [u.id, u.email, u.name, u.role],
      })),
      { sql: "INSERT INTO productions(id,name,client,status,cap_usd,created_at) VALUES('prod_margin','Harbour spot','',?,?,?)", args: ["active", CAP_USD, at] },
      { sql: "INSERT INTO projects(id,name,created_at,production_id,cap_usd,cap_credits) VALUES('p_margin','Harbour 30s',?,'prod_margin',?,555)", args: [at, CAP_USD] },
      { sql: "INSERT INTO shots(id,project_id,code,created_at,updated_at) VALUES('s_margin','p_margin','SH010',?,?)", args: [at, at] },
      { sql: take, args: ["g_take", "p_margin", "s_margin", "video", DEFAULT_MODEL_ID, "A harbour at dawn", JSON.stringify({ resolution: "1080p", duration: 5 }),
        "u_member", at, at, "byteplus", COST.take, COST.writer, "anthropic/claude-test", "tok_margin", "/api/media/g_take"] },
      { sql: take, args: ["g_still", "p_margin", "s_margin", "image", "gemini-3.1-flash-image", "A crane at dusk", "{}",
        "u_owner", at + 1, at + 1, "google", COST.still, null, null, null, "/api/media/g_still"] },
      { sql: take, args: ["g_dub", "p_margin", null, "audio", "eleven_dubbing_v1", "Dub · harbour → French",
        JSON.stringify({ task: "dub", dubbingStatus: "dubbed", minutes: 2, usdPerMinute: COST.dubRate, rateUsdPerMinute: COST.dubRate, estUsd: COST.dub, estCredits: 0 }),
        "u_member", at + 2, at + 2, "elevenlabs", COST.dub, null, null, null, "/api/media/g_dub"] },
      { sql: take, args: ["g_voice", "p_margin", null, "audio", "eleven_multilingual_sts_v2", "Voice change",
        JSON.stringify({ task: "voiceChange", estUsd: COST.voice, estCredits: 1234 }),
        "u_admin", at + 3, at + 3, "elevenlabs", COST.voice, null, null, null, "/api/media/g_voice"] },
      /* A starter take: nothing was rendered, and its display price is the vendor's. */
      { sql: take, args: ["g_demo", "p_margin", "s_margin", "video", DEFAULT_MODEL_ID, "Demo take",
        JSON.stringify({ demo: true, demoCostUsd: COST.demo, resolution: "1080p", duration: 5 }),
        "u_owner", at + 4, at + 4, "byteplus", 0, null, null, null, "/fixtures/clip.mp4"] },
      { sql: "INSERT INTO api_tokens(id,token_hash,name,user_id,scope,cap_usd,created_at) VALUES('tok_margin','hash_margin','Assistant','u_owner','render',20,?)", args: [at] },
      { sql: "INSERT INTO atomik_chats(id,project_id,title,model,agent_mode,status,text_cost_usd,created_by,created_at,updated_at,deleted) VALUES('ach_margin','p_margin','Harbour plan','auto','ask','waiting',?,'u_member',?,?,0)", args: [COST.turn, at, at] },
      { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,cost_usd,model,created_at) VALUES('amsg_margin','ach_margin','assistant','Two shots.',?,'anthropic/claude-test',?)", args: [COST.turn, at] },
      { sql: `INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,params,status,est_cost_usd,created_at,updated_at)
              VALUES('ast_margin','ach_margin','amsg_margin',0,'video','Harbour wide','A harbour at dawn',?,?,'proposed',?,?,?)`,
        args: [DEFAULT_MODEL_ID, JSON.stringify({ seconds: 5, ratio: "16:9", resolution: "1080p" }), COST.stepEstimate, at, at] },
    ], "write");
  });
  await platformReady();
  const meter = `INSERT INTO meter_events(id,workspace_id,project_id,shot_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,'succeeded',?,?,?,?,?,?)`;
  const paid = ws.usesPlatformKeys ? 1 : 0;
  await platformDb().batch([
    { sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at) VALUES(?,?,500,'unit','manual',0)", args: [`grant_${ws.id}`, ws.id] },
    { sql: meter, args: [`g_take`, ws.id, "p_margin", "s_margin", "video", "byteplus", "seedance", COST.take + COST.writer, paid ? 21 : 0, paid, "u_member", at, at] },
    { sql: meter, args: [`amsg_margin`, ws.id, "p_margin", null, "text", "vercel", "anthropic/claude-test", COST.turn, paid ? 1 : 0, paid, "u_member", at, at] },
  ].map((s) => ({ ...s, args: s.args.map((a) => (a === "g_take" || a === "amsg_margin" ? `${a}_${ws.id}` : a)) })), "write");
}

/** Customer-reachable GET routes. `allow` names what a route may carry, and why, at the line that allows it. */
type RouteCase = { name: string; file: string; url: string; params?: Record<string, string>; allow?: ScanOptions };
const ROUTES: RouteCase[] = [
  { name: "GET /api/projects", file: "app/api/projects/route.ts", url: "/api/projects" },
  { name: "GET /api/shots", file: "app/api/shots/route.ts", url: "/api/shots?projectId=p_margin" },
  { name: "GET /api/productions", file: "app/api/productions/route.ts", url: "/api/productions" },
  { name: "GET /api/jobs", file: "app/api/jobs/route.ts", url: "/api/jobs?sync=0" },
  { name: "GET /api/jobs/[id] (a dub)", file: "app/api/jobs/[id]/route.ts", url: "/api/jobs/g_dub?sync=0", params: { id: "g_dub" } },
  { name: "GET /api/jobs/[id] (a starter take)", file: "app/api/jobs/[id]/route.ts", url: "/api/jobs/g_demo?sync=0", params: { id: "g_demo" } },
  { name: "GET /api/atomik", file: "app/api/atomik/route.ts", url: "/api/atomik" },
  { name: "GET /api/atomik/[id]", file: "app/api/atomik/[id]/route.ts", url: "/api/atomik/ach_margin", params: { id: "ach_margin" } },
  { name: "GET /api/atomik/steps/[id]", file: "app/api/atomik/steps/[id]/route.ts", url: "/api/atomik/steps/ast_margin", params: { id: "ast_margin" } },
  { name: "GET /api/analytics", file: "app/api/analytics/route.ts", url: "/api/analytics" },
  { name: "GET /api/usage", file: "app/api/usage/route.ts", url: "/api/usage" },
  { name: "GET /api/usage?rows=1", file: "app/api/usage/route.ts", url: "/api/usage?rows=1" },
  { name: "GET /api/usage/summary", file: "app/api/usage/summary/route.ts", url: "/api/usage/summary" },
  /* `capUsd` is the ceiling the customer typed for their own token, in the dollars they pay us, not a vendor figure. */
  { name: "GET /api/tokens", file: "app/api/tokens/route.ts", url: "/api/tokens", allow: { allowKeys: ["capUsd"] } },
  { name: "GET /api/workspaces/keys", file: "app/api/workspaces/keys/route.ts", url: "/api/workspaces/keys" },
  { name: "GET /api/me", file: "app/api/me/route.ts", url: "/api/me" },
];

type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function callAs(ws: TenantWorkspace, user: TenantUser, route: RouteCase): Promise<{ status: number; body: unknown }> {
  const { runInTenant } = await import("../../lib/tenant");
  const auth = await import("../../lib/auth");
  const mod = loadRouteModule<{ GET: Handler }>(route.file, {
    "@/lib/auth": {
      ...auth,
      withTenant: (fn: Handler) => (req: Request, ctx?: { params: Promise<Record<string, string>> }) =>
        runInTenant(ws, () => fn(req, ctx), { user, workspaces: [{ id: ws.id, slug: ws.slug, name: ws.name, role: user.owner ? "owner" : user.role }] }),
    },
  });
  const res = await mod.GET(new Request(`https://studio.test${route.url}`), { params: Promise.resolve(route.params ?? {}) });
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

test("the scanner reports a money key, a vendor figure under any key, and a dollar in a sentence", () => {
  const body = {
    ok: { credits: 21, creditUsd: 0.1, rate: 0.9165, title: "Harbour 30s · 1.5x speed" },
    leaks: [{ costUsd: null, estCostUsd: 0.5 }, { spend: COST.take + COST.writer }, "Cost $1.36", "(19.87 spent)", "20.00 USD ceiling"],
  };
  expect(vendorCostFindings(body, { figures: FIGURES }).map((f) => f.at)).toEqual([
    "$.leaks[0].estCostUsd", "$.leaks[1].spend", "$.leaks[2]", "$.leaks[3]", "$.leaks[4]",
  ]);
});

for (const route of ROUTES) {
  test(`${route.name}: no vendor cost reaches the owner, an admin or a member of a credit workspace`, async () => {
    const leaks: Record<string, Finding[]> = {};
    for (const [role, user] of Object.entries(ACTORS)) {
      const { status, body } = await callAs(credit, user, route);
      expect(status, `${role}: ${JSON.stringify(body).slice(0, 300)}`).toBeLessThan(500);
      const found = vendorCostFindings(body, { figures: FIGURES, ...route.allow });
      if (found.length) leaks[role] = found;
    }
    expect(leaks).toEqual({});
  });
}

test("the scanner sees a vendor figure where one is allowed: a workspace on its own keys reads its dollars", async () => {
  /* The control: the same routes, a workspace that pays its vendors itself. Its dollars are its own. */
  for (const url of ["/api/projects", "/api/shots?projectId=p_margin", "/api/analytics"]) {
    const route = ROUTES.find((r) => r.url === url)!;
    const { body } = await callAs(ownKeys, ACTORS.owner, route);
    expect(vendorCostFindings(body, { figures: FIGURES }).length, url).toBeGreaterThan(0);
  }
});
