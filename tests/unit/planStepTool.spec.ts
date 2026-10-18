import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor, AdmissionReply, PreparedAdmission } from "../../lib/admissionTypes";
import type { TenantWorkspace } from "../../lib/tenant";
import type { RunSpend } from "../../lib/runLimit";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { BoardSnapshot } from "../../lib/workbench/rig-agent-plan";
import { mockPlannerModel, runPlanner, MOCK_PLANNER_CATALOG, MOCK_PLANNER_MODEL } from "../../lib/workbench/rig-agent-planner";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

/*
 * plan_step (lib/workbench/plan-step-tool.ts, POST /api/board-agent/plan, the MCP tool): Agent mode's quick plan, prepared and priced for a person or a token acting as
 * them. It prepares only: nothing is reserved, sent or approved, and the plan waits for the owner's one approval. The harness is the chips spec's. Nothing reaches a provider.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-plan-step-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.LIVEBLOCKS_SECRET_KEY;

const OWNER = "ana", TEAMMATE = "bo";
/** People whose workspace role is member (the rest are admins). */
const MEMBERS = new Set<string>();
const userOf = (id: string) => ({ id, email: `${id}@example.invalid`, name: id === OWNER ? "Ana" : "Bo", role: (MEMBERS.has(id) ? "member" : "admin") as "admin", owner: id === OWNER, disabled: false, createdAt: 0, lastSeen: null });
const actorOf = (id: string): AdmissionActor => ({ user: userOf(id) });
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/* ── A paid workspace, a production, a board ──────────────────────────── */

async function paidWorkspace(name: string, credits = 2000): Promise<TenantWorkspace> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,?,0,0,20,500)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`, OWNER],
  });
  if (credits) await grantCredits(name, credits, "Test", OWNER, "manual");
  return rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
}

const scene = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 344, linked: [], mode: "Video", ...extra });

async function seedBoard() {
  const { db, ready } = await import("../../lib/db");
  const { patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
  const project: Project = { ...newProject("Harbour"), id: "draft-1", productionProjectId: "prod-1" };
  await ready();
  await db().execute("INSERT INTO projects(id,name,created_at) VALUES('prod-1','Harbour',0)");
  await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${OWNER}:draft-1`, OWNER, "draft-1", "Harbour", JSON.stringify(project)] });
  await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${TEAMMATE}:draft-1`, TEAMMATE, "draft-1", "Harbour", JSON.stringify(project)] });
  await patchTeamCanvas("prod-1", { upsertNodes: [
    scene("s1", { x: 100, y: 100, title: "Pier", text: "Shot 1 of 3: The captain on the pier at dawn." }),
    scene("s2", { x: 500, y: 100, title: "Deck", text: "Shot 2 of 3: The captain walks the deck." }),
    scene("s3", { x: 900, y: 100, title: "Done", text: "Shot 3 of 3: The captain waves.", status: "approved" }),
  ], removeNodes: [], upsertAssets: [], order: ["s1", "s2", "s3"] }, OWNER);
}

/** Runs `fn` in a fresh paid workspace with a production and its board. */
async function inRun<T>(name: string, fn: (ws: TenantWorkspace) => Promise<T>, credits?: number): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await paidWorkspace(name, credits);
  return runInTenant(ws, async () => { await seedBoard(); return fn(ws); });
}

/* ── A stand-in for admission: the real durable claim and the real reservation ── */

type Behaviour = { throwBeforeClaim?: boolean; throwAfterReply?: boolean; pendingClaim?: boolean };

/** `xai`: shots whose engine settles on what the provider states (worst case 3 × the quote), as an approximate engine does. */
/** `adminShots`: shots over the workspace's per-shot rule: a member's preparation is refused with needsAdmin, as admission does. */
function renders(ws: TenantWorkspace, usdOf: (node: string) => number, xai: ReadonlySet<string> = new Set(), adminShots: ReadonlySet<string> = new Set()) {
  const calls: { key: string; savedKey: string | null; savedState: string | null; run: RunSpend | undefined; prompt: string }[] = [];
  const behaviour: Behaviour = {};
  /* The price the admission would compute now, per shot: a moved price refuses an old approval. */
  const priceNow = new Map<string, number>();
  const shotOf = (body: Record<string, unknown>) => String(body.prompt ?? "").match(/Shot (\d+) of/)?.[1] ?? "?";
  const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) => {
    const { billCredits } = await import("../../lib/creditTerms");
    const shot = shotOf(body);
    if (adminShots.has(shot) && actor.user.role !== "admin")
      return { ok: false as const, status: 403, body: { error: `Shot ${shot} is over the 50 cr a shot may take. An admin has to press this one.`, needsAdmin: true } };
    const usd = priceNow.get(shot) ?? usdOf(shot);
    const credits = billCredits(usd, "mock");
    /* The compile covers the prompt, as a real one does: an edited shot is a different quote fingerprint. */
    const compiled = {
      model: { provider: xai.has(shot) ? "xai" : "byteplus" }, estUsd: usd, shot, prompt: String(body.prompt ?? ""), engine: body.model ?? null, references: body.references ?? [],
      draft: body.draft === true, resolution: body.resolution,
    };
    const quote = { estimatedCredits: credits, price: credits, unit: "cr" as const };
    return { ok: true as const, value: { version: 1 as const, kind: "video" as const, workspaceId: ws.id, actorId: actor.user.id, request: { ...body, maxCredits: credits }, compiled, quote: { ...quote, fingerprint: sha({ compiled, quote }) } } satisfies PreparedAdmission };
  };
  const admit = async (prepared: PreparedAdmission, actor: AdmissionActor, options: { requestKey: string; run?: RunSpend }): Promise<AdmissionReply> => {
    const { db, id, now } = await import("../../lib/db");
    const { withGenerationRequestData, bindGenerationRequestStatement, reserveGenerationSpend, SpendReservationError } = await import("../../lib/generationRequests");
    const { preparedClaimFingerprint } = await import("../../lib/admissionSupport");
    const saved = (await db().execute({ sql: "SELECT state,request_key FROM rig_agent_steps WHERE request_key=?", args: [options.requestKey] })).rows[0];
    calls.push({ key: options.requestKey, savedKey: saved ? String(saved.request_key) : null, savedState: saved ? String(saved.state) : null, run: options.run, prompt: String(prepared.request.prompt ?? "") });
    if (behaviour.throwBeforeClaim) { behaviour.throwBeforeClaim = false; throw new Error("the function died before the request left"); }
    if (behaviour.pendingClaim) {
      behaviour.pendingClaim = false;
      await db().execute({ sql: "INSERT INTO generation_requests(user_id,request_key,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?)", args: [actor.user.id, options.requestKey, preparedClaimFingerprint(prepared), now(), now()] });
      throw new Error("the function died while the request was being accepted");
    }
    const compiled = prepared.compiled as { estUsd: number; shot: string };
    const response = await withGenerationRequestData({ userId: actor.user.id, key: options.requestKey, fingerprint: preparedClaimFingerprint(prepared) }, async (claim) => {
      /* The checkpoint: what this shot would cost now must be what was approved. */
      const current = priceNow.get(compiled.shot);
      if (current != null && current !== compiled.estUsd) return Response.json({ error: "The compiled generation or price changed. Review and approve a fresh quote.", quoteChanged: true }, { status: 409 });
      const genId = id("gen");
      await db().batch([
        { sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [genId, "prod-1", "video", "mock", String(prepared.request.prompt ?? ""), "{}", "queued", actor.user.id, now(), now()] },
        bindGenerationRequestStatement(claim, genId),
      ], "write");
      try {
        await reserveGenerationSpend({ id: genId, kind: "video", engine: "byteplus", model: "mock", status: "running", engineCostUsd: compiled.estUsd, projectId: "prod-1", createdBy: actor.user.id }, { run: options.run });
      } catch (error) {
        await db().execute({ sql: "UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?", args: [(error as Error).message, now(), genId] });
        return Response.json({ id: genId, status: "failed", error: (error as Error).message }, { status: error instanceof SpendReservationError ? error.status : 503 });
      }
      return Response.json({ id: genId, status: "queued" }, { status: 202 });
    }, { atomicBinding: true });
    const reply = { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
    if (behaviour.throwAfterReply) { behaviour.throwAfterReply = false; throw new Error("the reply was lost on its way back"); }
    return reply;
  };
  return { prepare, admit, calls, behaviour, priceNow };
}

type Renders = ReturnType<typeof renders>;

async function depsFor(ws: TenantWorkspace, r: Renders, extra: Record<string, unknown> = {}) {
  const { runInTenant } = await import("../../lib/tenant");
  return {
    access: async () => null, paceMs: 0,
    plan: async (snapshot: BoardSnapshot) => ({ ...(await runPlanner(snapshot, mockPlannerModel(snapshot))), model: MOCK_PLANNER_MODEL }),
    pricing: async () => ({ id: MOCK_PLANNER_MODEL, catalog: MOCK_PLANNER_CATALOG, direct: false }),
    asOwner: <T,>(owner: string, work: (actor: AdmissionActor) => Promise<T>) => runInTenant(ws, () => work(actorOf(owner)), { user: userOf(owner) }),
    prepare: r.prepare, admit: r.admit, defer: async () => {}, follow: async () => {},
    ...extra,
  };
}

async function balance(ws: TenantWorkspace) {
  const { creditStateFor } = await import("../../lib/credits");
  return (await creditStateFor(ws))!.balance;
}
const credits = async (usd: number) => (await import("../../lib/creditTerms")).billCredits(usd, "mock");



const reservations = async (ws: TenantWorkspace) => {
  const { platformDb } = await import("../../lib/platform");
  return Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE workspace_id=?", args: [ws.id] })).rows[0].n);
};

test("plan_step is declared once, listed over MCP as a tool a prepare token may use, and described on the connections page", async () => {
  const { PLAN_STEP_TOOL } = await import("../../lib/workbench/plan-step-tool");
  expect(PLAN_STEP_TOOL).toMatchObject({ id: "plan_step", kind: "app", route: "/api/board-agent/plan", needs: [], provider: null });
  expect(PLAN_STEP_TOOL.who).toContain("the person who owns the board");
  const { TOOLS } = await import("../../lib/mcp");
  const tool = TOOLS.find((t) => t.name === "plan_step")!;
  expect(tool.description).toContain("you cannot approve it");
  expect(JSON.stringify(tool.inputSchema)).not.toMatch(/maxCredits|max_credits|approve"/);
  const { mcpTools, MCP_TOOL_LINES } = await import("../../lib/shell/tools-connections");
  expect(MCP_TOOL_LINES.plan_step).toContain("a person approves it in Particl");
  expect(mcpTools().find((t) => t.name === "plan_step")).toMatchObject({ token: "prepare" });
  const route = (await import("node:fs")).readFileSync("app/api/board-agent/plan/route.ts", "utf8");
  expect(route).toContain("preparedJobs: true");
  /* The sample workspace makes no plan, as on the board (team-canvas's agent.planStep). */
  expect(route).toContain("sampleWorkspaceOff()");
  expect(route).not.toMatch(/requireRender|approveRigAgentPlan|maxCredits\)|reserveGenerationSpend/);
});

test("it prepares and prices and nothing more: the server's quote for each shot, the total their sum, nothing reserved or charged, and only the board's owner can approve what it made", async () => {
  await inRun("pstep", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { preparePlanStep } = await import("../../lib/workbench/plan-step-tool");
    const r = renders(ws, (shot) => (shot === "1" ? 0.3 : 0.45));
    const deps = await depsFor(ws, r);
    const before = await balance(ws);
    const out = await preparePlanStep(OWNER, { boardId: "draft-1", answers: { length: 8 } }, deps);
    const a = await credits(0.3), b = await credits(0.45);
    expect(out).toMatchObject({ step: "shots", priced: true, total: a + b, ceiling: 2 * (a + b), state: "needs_you", asks: 0, reason: null, answers: { quality: "draft", length: 8 } });
    expect(out.shots).toEqual(["Pier", "Deck"]);
    /* One price: the plan's total. No shot's price and no engine's name in the reply. */
    expect(JSON.stringify(out)).not.toMatch(/credits|seedance|kling|veo|flux|banana|gemini|byteplus/i);
    expect(out.needs).toContain("A person approves this plan in Particl");
    expect(r.calls).toEqual([]);
    expect(await reservations(ws)).toBe(0);
    expect(await balance(ws)).toBe(before);
    /* The plan is the owner's: a teammate cannot approve it, and the owner's one approval is the only way it spends. */
    const run = (await agent.rigAgentState("prod-1", OWNER)).run!;
    expect(run).toMatchObject({ id: out.id, kind: "chips" });
    await expect(agent.approveRigAgentPlan({ productionId: "prod-1", runId: out.id, fingerprint: run.plan!.quote!.fingerprint, userId: TEAMMATE })).rejects.toMatchObject({ status: 403 });
    expect(await reservations(ws)).toBe(0);
    /* Asked again with the same request id: the same plan. */
    const again = await preparePlanStep(OWNER, { boardId: "draft-1", requestId: "mcp-plan-same" }, deps);
    const same = await preparePlanStep(OWNER, { boardId: "draft-1", requestId: "mcp-plan-same" }, deps);
    expect(same.id).toBe(again.id);
  });
});

test("it refuses in words: a board that is not the caller's, one with no production yet, a bad request id or card list, an unknown step, an agent identity", async () => {
  await inRun("pstep-refuse", async (ws) => {
    const { preparePlanStep } = await import("../../lib/workbench/plan-step-tool");
    const { PEOPLE_ONLY } = await import("../../lib/workbench/plan-approval");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    await expect(preparePlanStep(OWNER, { boardId: "../x" }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(preparePlanStep(OWNER, { boardId: "nope-board" }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(preparePlanStep(OWNER, { boardId: "draft-1", requestId: "bad id!" }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(preparePlanStep(OWNER, { boardId: "draft-1", cards: "s1" }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(preparePlanStep(OWNER, { boardId: "draft-1", cards: ["theirs"] }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(preparePlanStep(OWNER, { boardId: "draft-1", step: "cast" }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(preparePlanStep(OWNER, { boardId: "draft-1", answers: { quality: "gold" } }, deps)).rejects.toMatchObject({ status: 400 });
    /* People only, before the board is read: an agent identity gets the people-only refusal, not "not yours". */
    for (const machine of ["agent:rar_aaaaaaaaaaaaaaaaaaaaaaaa", "mcp:client", "auto"])
      await expect(preparePlanStep(machine, { boardId: "draft-1" }, deps), machine).rejects.toMatchObject({ status: 403, message: PEOPLE_ONLY });
    await expect(preparePlanStep(OWNER, { boardId: "draft-1" }, deps).then(() => (async () => {
      /* A board saved to no production. */
      const body = JSON.stringify({ ...JSON.parse(String((await db().execute({ sql: "SELECT body FROM workbench_projects WHERE key=?", args: [`${OWNER}:draft-1`] })).rows[0].body)), productionProjectId: undefined, id: "draft-free" });
      await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`${OWNER}:draft-free`, OWNER, "draft-free", "Free", body] });
      return preparePlanStep(OWNER, { boardId: "draft-free" }, deps);
    })())).rejects.toMatchObject({ status: 409 });
  });
});

test("plan_step's reason counts only shots it tried to price and could not; one not reached yet is still being priced", async () => {
  const { unpricedWords } = await import("../../lib/workbench/plan-step-tool");
  const t = (state: string, extra: Record<string, unknown> = {}) => ({ state, quote: null, pause: null, fixOf: null, ...extra }) as never;
  expect(unpricedWords([t("paused", { pause: "unpriced" }), t("next"), t("next")])).toBe("1 shot can't be priced yet; open the board.");
  expect(unpricedWords([t("next"), t("next")])).toBe("The plan is still being priced; open the board.");
  expect(unpricedWords([t("waiting", { quote: 300 }), t("paused", { pause: "admin", quote: 40 })])).toBe("Every shot here asks on its own; open the board.");
});

test("over MCP: one call to the board route as the caller, never an approval; an approval in the arguments is refused; the answer says the person approves it and nothing was rendered", async () => {
  const { runTool } = await import("../../lib/mcp");
  const calls: { path: string; method?: string; body?: Record<string, unknown> }[] = [];
  const reply = { plan: { id: "rar_x", state: "needs_you", step: "shots", priced: true, total: 12, ceiling: 24, approximate: false, shots: ["Pier", "Deck"], asks: 0, reason: null, needs: "A person approves this plan in Particl. Nothing is spent until they do." } };
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => { calls.push({ path, method: init.method, body: init.body as Record<string, unknown> }); return reply; };
  const text = await runTool("plan_step", { board_id: "draft-1", quality: "final", length: 8, cards: "s1, s2", request_id: "r1" }, call as never, "https://example.invalid");
  expect(calls).toEqual([{ path: "/api/board-agent/plan", method: "POST", body: { boardId: "draft-1", step: undefined, answers: { quality: "final", length: 8 }, cards: ["s1", "s2"], requestId: "r1" } }]);
  expect(text).toContain("12 cr, at most 24 cr with fixes");
  expect(text).not.toMatch(/Pier · \d|Deck · \d/);
  expect(text).toContain("A person approves this plan in Particl");
  expect(text).toContain("Nothing was rendered or reserved");
  for (const bad of [{ maxCredits: 12 }, { max_credits: 12 }, { fingerprint: "f".repeat(64) }, { approve: true }]) await expect(runTool("plan_step", { board_id: "draft-1", ...bad } as never, call as never, "https://example.invalid")).rejects.toThrow(/not yours to approve/);
  expect(calls).toHaveLength(1);
  /* A plan that could not be priced says why, and still approves nothing. */
  const unpriced = async () => ({ plan: { ...reply.plan, priced: false, total: null, ceiling: null, reason: "Pier is not priced yet." } });
  expect(await runTool("plan_step", { board_id: "draft-1" }, unpriced as never, "https://example.invalid")).toContain("not priced yet: Pier is not priced yet.");
});

test("a tool's plan never replaces a plan waiting on the board; it may replace an earlier tool-made one, and says so; a person's own plan replaces either", async () => {
  await inRun("pstep-replace", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { preparePlanStep } = await import("../../lib/workbench/plan-step-tool");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const state = async (id: string) => String((await db().execute({ sql: "SELECT state FROM rig_agent_runs WHERE id=?", args: [id] })).rows[0].state);
    /* A plan the person made on the board, waiting for their approval. */
    const mine = await agent.planRigAgentStep({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: "req-pstep-board", step: "shots" });
    await agent.advanceRigAgentRun(mine.id, deps);
    expect(await state(mine.id)).toBe("needs_you");
    await expect(preparePlanStep(OWNER, { boardId: "draft-1" }, deps)).rejects.toMatchObject({ status: 409, message: "A plan is waiting for approval on the board." });
    expect(await state(mine.id)).toBe("needs_you");
    /* A person's own new plan replaces theirs; then a tool's plan is the one waiting. */
    const next = await agent.planRigAgentStep({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: "req-pstep-board-2", step: "shots" });
    expect(await state(mine.id)).toBe("stopped");
    await agent.stopRigAgent({ productionId: "prod-1", runId: next.id, userId: OWNER });
    const first = await preparePlanStep(OWNER, { boardId: "draft-1" }, deps);
    expect(first.replaced).toBe(false);
    /* A tool's plan replaces an earlier tool's, and says it did. */
    const second = await preparePlanStep(OWNER, { boardId: "draft-1", cards: ["s1"] }, deps);
    expect(second).toMatchObject({ replaced: true, priced: true });
    expect(second.id).not.toBe(first.id);
    expect(await state(first.id)).toBe("stopped");
    /* The person's own plan replaces the tool's. */
    const board = await agent.planRigAgentStep({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: "req-pstep-board-3", step: "shots" });
    expect(board.replaced).toBeUndefined();
    expect(await state(second.id)).toBe("stopped");
  });
  /* The words an agent reads. */
  const { runTool } = await import("../../lib/mcp");
  const reply = { plan: { id: "rar_x", state: "needs_you", step: "shots", priced: true, total: 5, ceiling: 10, approximate: false, shots: ["Pier"], asks: 0, reason: null, replaced: true, needs: "A person approves this plan in Particl. Nothing is spent until they do." } };
  expect(await runTool("plan_step", { board_id: "draft-1" }, (async () => reply) as never, "https://example.invalid")).toContain("Replaced the plan waiting on the board.");
});

/** The real route file, its imports given: the caller (`requireUser`, no session layer) and plan_step with the test's stand-in for admission. */
function planRoute(userId: string, prepare: (userId: string, input: unknown) => Promise<unknown>, spendGuard: unknown, agent: unknown) {
  const filename = path.resolve("app/api/board-agent/plan/route.ts"), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const deps: Record<string, unknown> = {
    "@/lib/auth": { requireUser: async () => ({ user: { id: userId } }), withTenant: (handler: unknown) => handler },
    "@/lib/demo/spend-guard.server": spendGuard,
    "@/lib/workbench/plan-step-tool": { preparePlanStep: prepare },
    "@/lib/workbench/rig-agent": agent,
  };
  const mod = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", compiled)((name: string) => (Object.hasOwn(deps, name) ? deps[name] : require(name)), mod, mod.exports);
  return mod.exports as { POST: (req: Request) => Promise<Response> };
}
const post = (body: unknown) => new Request("http://localhost/api/board-agent/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("a pricing refusal that names the engine reaches no reply: plan_step's summary, the route's JSON and the MCP answer say how many shots can't be priced, in fixed words", async () => {
  await inRun("pstep-engine", async (ws) => {
    const tool = await import("../../lib/workbench/plan-step-tool");
    const spendGuard = await import("../../lib/demo/spend-guard.server");
    const r = renders(ws, () => 0.3);
    /* A made-up engine label, standing in for the catalog's `${model.label} has no draft mode.` (lib/generationAdmission.ts). */
    const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) =>
      String(body.prompt ?? "").includes("Shot 1 of") ? { ok: false as const, status: 422, body: { error: "Zephyrcam 9 has no draft mode." } } : r.prepare(body, actor);
    const deps = await depsFor(ws, r, { prepare });
    const out = await tool.preparePlanStep(OWNER, { boardId: "draft-1", requestId: "engine-1" }, deps);
    /* Pier's pricing was refused; Deck, behind it, is not counted as one that can't be priced. */
    expect(out).toMatchObject({ priced: false, total: null, reason: "1 shot can't be priced yet; open the board." });
    const words = out.reason!;
    expect(JSON.stringify(out)).not.toMatch(/zephyrcam|draft mode/i);
    /* Through the route, as an outside agent's token reaches it. */
    const route = planRoute(OWNER, (userId, input) => tool.preparePlanStep(userId, input as never, deps), spendGuard, await import("../../lib/workbench/rig-agent"));
    const res = await route.POST(post({ boardId: "draft-1", requestId: "engine-2" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.plan).toMatchObject({ priced: false, reason: words });
    expect(JSON.stringify(json)).not.toMatch(/zephyrcam|draft mode/i);
    /* And the words the agent reads over MCP, from that route. */
    const { runTool } = await import("../../lib/mcp");
    const call = async (_path: string, init: { method?: string; body?: unknown } = {}) => (await route.POST(post(init.body))).json();
    const text = await runTool("plan_step", { board_id: "draft-1", request_id: "engine-3" }, call as never, "https://example.invalid");
    expect(text).toContain(`not priced yet: ${words}`);
    expect(text).not.toMatch(/zephyrcam|draft mode/i);
    expect(r.calls).toEqual([]);
    expect(await reservations(ws)).toBe(0);
  });
});

test("the route: the sample workspace makes no plan; an approval or a fingerprint in the body is refused; an agent identity gets 403", async () => {
  await inRun("pstep-route", async (ws) => {
    const tool = await import("../../lib/workbench/plan-step-tool");
    const spendGuard = await import("../../lib/demo/spend-guard.server");
    const { PEOPLE_ONLY } = await import("../../lib/workbench/plan-approval");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    let prepared = 0;
    const route = planRoute(OWNER, (userId, input) => { prepared++; return tool.preparePlanStep(userId, input as never, deps); }, spendGuard, await import("../../lib/workbench/rig-agent"));
    for (const bad of [{ maxCredits: 5 }, { fingerprint: "f".repeat(64) }, { approve: true }])
      expect((await route.POST(post({ boardId: "draft-1", ...bad }))).status, JSON.stringify(bad)).toBe(400);
    expect(prepared).toBe(0);
    const machine = planRoute("agent:rar_aaaaaaaaaaaaaaaaaaaaaaaa", (userId, input) => tool.preparePlanStep(userId, input as never, deps), spendGuard, await import("../../lib/workbench/rig-agent"));
    const refused = await machine.POST(post({ boardId: "draft-1" }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe(PEOPLE_ONLY);
    /* The sample workspace: refused in the sample's words, before anything is made. */
    const { SAMPLE_SETTING_KEY, SAMPLE_LINE } = await import("../../lib/demo/sample");
    await db().execute({ sql: "INSERT INTO settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)", args: [SAMPLE_SETTING_KEY, JSON.stringify({ version: 1, projectId: "prod-1", draftOwner: OWNER, draftId: "draft-1" }), OWNER, 1] });
    const sample = await route.POST(post({ boardId: "draft-1" }));
    expect(sample.status).toBe(409);
    expect((await sample.json()).error).toBe(SAMPLE_LINE);
    expect(prepared).toBe(0);
    const { rigAgentExists } = await import("../../lib/workbench/rig-agent-store");
    if (await rigAgentExists()) expect((await db().execute("SELECT COUNT(*) AS n FROM rig_agent_runs")).rows[0].n).toBe(0);
  });
});
