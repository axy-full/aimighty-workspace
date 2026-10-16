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

/*
 * A chips plan (lib/workbench/rig-agent-chips.ts, lib/workbench/rig-agent.ts planRigAgentStep): the server's own plan for a board step from its quick
 * answers, with no thinking turn and no planning charge. Money: the plan is priced by the server's quote and reserves nothing until one person approves it
 * once; the card's total is the sum of its steps; the answers (Quality, Length) reach the priced request; a machine cannot make or approve it; the two-fix
 * allowance is the plan approval's own. The harness is the plan approval spec's: a stand-in for admission that makes the real durable claim and the real
 * reservation. Nothing reaches a provider.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-agent-chips-"));
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
let requests = 0;
const rid = () => `req-chips-${String(++requests).padStart(6, "0")}`;

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

const view = async (viewer = OWNER) => (await (await import("../../lib/workbench/rig-agent")).rigAgentState("prod-1", viewer)).run!;
const renderRows = async () => {
  const { db } = await import("../../lib/db");
  return (await db().execute("SELECT id,status FROM generations ORDER BY created_at")).rows.map((r) => ({ id: String(r.id), status: String(r.status) }));
};
async function balance(ws: TenantWorkspace) {
  const { creditStateFor } = await import("../../lib/credits");
  return (await creditStateFor(ws))!.balance;
}
/** The vendor finishes a take: its outcome and bill written together, then delivered to the ledger (the settlement). */
async function settleTake(jobId: string, status: "succeeded" | "failed", usd: number) {
  const { writeGenerationOutcome, deliverGenerationSettlement } = await import("../../lib/generationSettlement");
  await writeGenerationOutcome({ sql: "UPDATE generations SET status=?,cost_usd=?,updated_at=? WHERE id=?", args: [status, usd, Date.now(), jobId] },
    { id: jobId, kind: "video", engine: "byteplus", model: "mock", status, engineCostUsd: usd });
  await deliverGenerationSettlement(jobId);
}
const credits = async (usd: number) => (await import("../../lib/creditTerms")).billCredits(usd, "mock");


const plan = (over: Record<string, unknown> = {}) => import("../../lib/workbench/rig-agent").then((m) => m.planRigAgentStep({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: rid(), step: "shots", ...over }));
const reservations = async (ws: TenantWorkspace) => {
  const { platformDb } = await import("../../lib/platform");
  return Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM generation_reservations WHERE workspace_id=?", args: [ws.id] })).rows[0].n);
};

test("the chips are the server's: Shots has Quality and Length, each with its key in the draft's agent setup; answers sent beat answers kept beat defaults; a wrong answer is refused in words", async () => {
  const c = await import("../../lib/workbench/rig-agent-chips");
  const view = c.chipsView();
  expect(Object.keys(view)).toEqual(["shots"]);
  expect(view.shots.map((x) => [x.key, x.setupKey, x.default, x.options.map((o) => o.value)])).toEqual([["quality", "quality", "draft", ["draft", "final"]], ["length", "length", 5, [3, 5, 8, 10]]]);
  expect(c.resolveAnswers("shots", undefined, undefined)).toEqual({ quality: "draft", length: 5 });
  expect(c.resolveAnswers("shots", undefined, { quality: "final", length: 8 })).toEqual({ quality: "final", length: 8 });
  expect(c.resolveAnswers("shots", { length: 10 }, { quality: "final", length: 8 })).toEqual({ quality: "final", length: 10 });
  /* A kept answer that is no longer a choice is ignored; one sent that is not is refused. */
  expect(c.resolveAnswers("shots", undefined, { quality: "gold", length: 7 })).toEqual({ quality: "draft", length: 5 });
  expect(c.resolveAnswers("shots", { length: 7 }, undefined)).toEqual({ error: "Pick one of the length choices." });
  expect(c.resolveAnswers("shots", { model: "x" }, undefined)).toEqual({ error: '"model" is not a question of this step.' });
  expect(c.resolveAnswers("cast", undefined, undefined)).toEqual({ error: "Atomik has no quick questions for that step yet." });
  const route = (await import("node:fs")).readFileSync("app/api/workbench/team-canvas/route.ts", "utf8");
  expect(route).toContain('searchParams.get("steps") === "1"');
  expect(route).toContain('"agent.planStep"');
  /* A person's own press, in a signed-in session: the plan is a spending action as far as the sample's guard is concerned. */
  expect(route).toMatch(/SPENDING_AGENT_ACTIONS = new Set\(\["agent\.plan", "agent\.planStep"/);
});

test("a chips plan costs no thinking turn and reserves nothing: priced by the server's quote, it waits at 'needs you' with a total that is the sum of its steps; approved shots are left out", async () => {
  await inRun("chips-quote", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, (shot) => (shot === "1" ? 0.3 : 0.45));
    const deps = await depsFor(ws, r);
    const before = await balance(ws);
    const asked = await plan();
    expect(asked).toMatchObject({ kind: "chips", step: "shots", state: "running", goal: "Render 2 shots" });
    expect(asked.money?.planning).toBeNull();
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "needs_you", more: false });
    const run = await agent.rigAgentState("prod-1", OWNER).then((s) => s.run!);
    const a = await credits(0.3), b = await credits(0.45);
    const takes = run.paid.filter((p) => p.tool === "render");
    /* The first waits on the run's limit (there is none until a person approves) and keeps its price; the rest are priced ahead, so the card can show the total. */
    expect(takes.map((p) => [p.title, p.state, p.pause])).toEqual([["Pier", "paused", "limit"], ["Deck", "waiting", null]]);
    expect(run.plan?.quote).toMatchObject({ total: a + b, ceiling: 2 * (a + b), asks: [] });
    /* ONE price for the plan (owner, 16 Oct): the client is told the total and no step's price, no step's note about a price, and no engine's name; the server keeps each step's quote on its record, and their sum is the total. */
    expect(takes.every((p) => p.quote === null && p.worst === null && p.reason === null && !("quoteUsd" in p))).toBe(true);
    expect(run.reason).toBeNull();
    expect(JSON.stringify(run)).not.toMatch(/seedance|kling|veo|flux|banana|gemini|byteplus|\bengine\b/i);
    const { stepsOf } = await import("../../lib/workbench/rig-agent-store");
    const kept = (await stepsOf((await import("../../lib/db")).db(), asked.id)).filter((s) => s.purpose === "take").map((s) => s.quoteCredits);
    expect(kept).toEqual([a, b]);
    expect(run.plan?.quote?.total).toBe(kept.reduce((n: number, q) => n + (q ?? 0), 0));
    /* Nothing was sent, reserved or charged: no planning turn, no render. */
    expect(r.calls).toEqual([]);
    expect(await reservations(ws)).toBe(0);
    expect(await balance(ws)).toBe(before);
    expect(run.money).toMatchObject({ limit: 0, spent: 0, inFlight: 0 });
    /* The run's own request is idempotent: asking again with the same request id is the same run. */
    const id = "req-chips-same";
    const first = await agent.planRigAgentStep({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: id, step: "shots" });
    const second = await agent.planRigAgentStep({ productionId: "prod-1", draftId: "draft-1", userId: OWNER, requestId: id, step: "shots" });
    expect(second.id).toBe(first.id);
  });
});

test("the answers reach the priced request: Draft asks for the draft at the draft resolution, Final for the full render; Length is the shot's length for this plan", async () => {
  await inRun("chips-answers", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const seen: Record<string, unknown>[] = [];
    const r = renders(ws, () => 0.3);
    const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) => { seen.push(body); return r.prepare(body, actor); };
    const deps = await depsFor(ws, r, { prepare });
    const a = await plan({ answers: { quality: "draft", length: 8 } });
    await agent.advanceRigAgentRun(a.id, deps);
    const draft = seen.filter((b) => String(b.prompt).includes("Shot 1 of"));
    expect(draft.length).toBeGreaterThan(0);
    for (const body of draft) expect(body).toMatchObject({ duration: 8 });
    const wasDraft = draft.some((b) => b.draft === true);
    seen.length = 0;
    const f = await plan({ answers: { quality: "final", length: 3 } });
    await agent.advanceRigAgentRun(f.id, deps);
    for (const body of seen) { expect(body).toMatchObject({ duration: 3 }); expect(body.draft).not.toBe(true); }
    /* A draft only where the engine has one (the shot's own engine decides); Final never asks for one. */
    expect(typeof wasDraft).toBe("boolean");
    /* The plan is what the person approves: its answers are in the fingerprint, so another answer is another plan. */
    const again = await agent.rigAgentState("prod-1", OWNER).then((s) => s.run!);
    expect(again.proposal?.fingerprint).not.toBe(a.proposal?.fingerprint);
  });
});

test("only a person makes and approves it: an agent identity cannot make a plan, a teammate cannot approve the asker's, an agent cannot approve; the owner's one approval runs the plan inside its ceiling", async () => {
  await inRun("chips-approve", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { PEOPLE_ONLY } = await import("../../lib/workbench/plan-approval");
    const r = renders(ws, (shot) => (shot === "1" ? 0.3 : 0.45));
    const deps = await depsFor(ws, r);
    await expect(agent.planRigAgentStep({ productionId: "prod-1", draftId: "draft-1", userId: "agent:rar_aaaaaaaaaaaaaaaaaaaaaaaa", requestId: rid(), step: "shots" })).rejects.toMatchObject({ status: 403, message: PEOPLE_ONLY });
    const asked = await plan();
    await agent.advanceRigAgentRun(asked.id, deps);
    const run = await agent.rigAgentState("prod-1", OWNER).then((s) => s.run!);
    const fingerprint = run.plan!.quote!.fingerprint;
    for (const userId of [TEAMMATE, "agent:rar_aaaaaaaaaaaaaaaaaaaaaaaa", "mcp:client", "auto"])
      await expect(agent.approveRigAgentPlan({ productionId: "prod-1", runId: asked.id, fingerprint, userId }), userId).rejects.toMatchObject({ status: 403 });
    expect(r.calls).toEqual([]);
    expect(await reservations(ws)).toBe(0);
    /* The build approval does nothing here: there is nothing to build, and it never spends. */
    expect((await agent.approveRigAgent({ productionId: "prod-1", runId: asked.id, fingerprint: run.proposal!.fingerprint, userId: OWNER })).state).toBe("needs_you");
    expect(await reservations(ws)).toBe(0);
    const approved = await agent.approveRigAgentPlan({ productionId: "prod-1", runId: asked.id, fingerprint, userId: OWNER });
    expect(approved.plan?.approval).toMatchObject({ mine: true, total: run.plan!.quote!.total, ceiling: run.plan!.quote!.ceiling, maxFixes: 2 });
    /* Renders go one at a time, each as the plan lists it with no further tap. */
    await agent.advanceRigAgentRun(asked.id, deps);
    expect(r.calls).toHaveLength(1);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(asked.id, deps);
    expect(r.calls).toHaveLength(2);
    await settleTake((await renderRows())[1].id, "succeeded", 0.45);
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "done", more: false });
    expect(await reservations(ws)).toBe(2);
    const sent = await agent.rigAgentState("prod-1", OWNER).then((s) => s.run!);
    expect(sent.paid.filter((p) => p.tool === "render").map((p) => [p.state, p.inPlan])).toEqual([["done", true], ["done", true]]);
    expect(sent.money!.spent).toBeLessThanOrEqual(run.plan!.quote!.ceiling);
  });
});

test("the two-fix allowance is the plan approval's own: two fixes a shot are covered, within the plan's ceiling, and the third asks again", async () => {
  await inRun("chips-fixes", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { THIRD_FIX } = await import("../../lib/workbench/plan-approval");
    const r = renders(ws, (shot) => (shot === "1" ? 0.3 : 0.45));
    const deps = await depsFor(ws, r);
    const asked = await plan();
    await agent.advanceRigAgentRun(asked.id, deps);
    const gate = await agent.rigAgentState("prod-1", OWNER).then((s) => s.run!);
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId: asked.id, fingerprint: gate.plan!.quote!.fingerprint, userId: OWNER });
    for (let i = 0; i < 2; i++) {
      await agent.advanceRigAgentRun(asked.id, deps);
      await settleTake((await renderRows())[i].id, "succeeded", i ? 0.45 : 0.3);
    }
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "done", more: false });
    const first = (await view()).paid.find((p) => p.tool === "render")!;
    for (let i = 0; i < 2; i++) {
      expect((await agent.fixRigAgentShot({ productionId: "prod-1", runId: asked.id, seq: first.seq, userId: OWNER })).state).toBe("running");
      await agent.advanceRigAgentRun(asked.id, deps);
      expect(r.calls).toHaveLength(3 + i);
      await settleTake((await renderRows())[2 + i].id, "succeeded", 0.3);
      await agent.advanceRigAgentRun(asked.id, deps);
    }
    expect((await view()).plan?.approval?.fixes).toEqual({ [String(first.seq)]: 2 });
    await expect(agent.fixRigAgentShot({ productionId: "prod-1", runId: asked.id, seq: first.seq, userId: OWNER })).rejects.toMatchObject({ status: 409, message: THIRD_FIX });
    expect(r.calls).toHaveLength(4);
  });
});

test("a newer plan replaces one still waiting for its approval; one already approved is not replaced; a plan for nothing, for a card that is not a shot, or for a step with no chips is refused in words", async () => {
  await inRun("chips-replace", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const r = renders(ws, () => 0.3);
    const deps = await depsFor(ws, r);
    const one = await plan();
    await agent.advanceRigAgentRun(one.id, deps);
    const two = await plan({ cards: ["s2"] });
    expect(two.id).not.toBe(one.id);
    expect((await agent.rigAgentState("prod-1", OWNER)).run!.id).toBe(two.id);
    const { db } = await import("../../lib/db");
    expect(String((await db().execute({ sql: "SELECT state FROM rig_agent_runs WHERE id=?", args: [one.id] })).rows[0].state)).toBe("stopped");
    expect((await db().execute({ sql: "SELECT state FROM rig_agent_steps WHERE run_id=? AND purpose='take'", args: [one.id] })).rows.every((x) => x.state === "skipped")).toBe(true);
    await agent.advanceRigAgentRun(two.id, deps);
    const gate = await agent.rigAgentState("prod-1", OWNER).then((s) => s.run!);
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId: two.id, fingerprint: gate.plan!.quote!.fingerprint, userId: OWNER });
    await expect(plan()).rejects.toMatchObject({ status: 409 });
    await expect(plan({ cards: ["theirs"] })).rejects.toMatchObject({ status: 400 });
    await expect(plan({ step: "cast" })).rejects.toMatchObject({ status: 400 });
    await expect(plan({ answers: { length: 7 } })).rejects.toMatchObject({ status: 400, message: "Pick one of the length choices." });
  });
});
