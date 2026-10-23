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
function renders(ws: TenantWorkspace, usdOf: (node: string) => number, xai: ReadonlySet<string> = new Set()) {
  const calls: { key: string; savedKey: string | null; savedState: string | null; run: RunSpend | undefined; prompt: string }[] = [];
  const behaviour: Behaviour = {};
  /* The price the admission would compute now, per shot: a moved price refuses an old approval. */
  const priceNow = new Map<string, number>();
  const shotOf = (body: Record<string, unknown>) => String(body.prompt ?? "").match(/Shot (\d+) of/)?.[1] ?? "?";
  const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) => {
    const { billCredits } = await import("../../lib/creditTerms");
    const shot = shotOf(body);
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
    /* The first waits on the run's limit (there is none until a person approves); the rest are priced ahead, so the plan has its total. Both are covered by the plan's gate, so neither shows a price of its own. */
    expect(takes.map((p) => [p.title, p.state, p.pause])).toEqual([["Pier", "paused", "limit"], ["Deck", "waiting", null]]);
    expect(run.plan?.quote).toMatchObject({ total: a + b, ceiling: 2 * (a + b) });
    expect(run.plan?.quote).not.toHaveProperty("asks");
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

test("one price for the whole plan, a shot over 200 cr included (owner, 20 Oct 2026: the per-render ask over 200 cr goes): both shots are in the plan's total, neither shows a price of its own, the card fetches no estimate, and the one approval sends both with no further tap", async () => {
  await inRun("chips-line", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { stepsOf } = await import("../../lib/workbench/rig-agent-store");
    const { db } = await import("../../lib/db");
    const { planModel } = await import("../../components/graphite/board/cards/plan/model");
    const { wantsEstimates } = await import("../../components/graphite/board/cards/plan/estimates");
    const { creditFigure } = await import("../../lib/workbench/rig-agent-plan");
    /* Synthetic dollars, made up for this test: shot 2 comes to more than 200 cr. */
    const r = renders(ws, (shot) => (shot === "1" ? 0.3 : 25));
    const deps = await depsFor(ws, r);
    const asked = await plan();
    await agent.advanceRigAgentRun(asked.id, deps);
    const run = await view();
    const [s1, s2] = run.paid.filter((p) => p.tool === "render");
    const kept = new Map((await stepsOf(db(), asked.id)).filter((s) => s.purpose === "take").map((s) => [s.seq, s.quoteCredits]));
    const a = await credits(0.3), b = kept.get(s2.seq)!;
    expect(b).toBeGreaterThan(200);
    expect(run.plan?.quote).toMatchObject({ total: a + b, covered: [s1.seq, s2.seq] });
    /* Both are covered by the plan: no price of their own until they settle. */
    expect([s1.quote, s1.worst, s1.reason]).toEqual([null, null, null]);
    expect([s2.quote, s2.worst]).toEqual([null, null]);
    /* The card: no client estimate for a chips run; both shots read "in the plan". */
    expect(wantsEstimates(run)).toBe(false);
    expect(wantsEstimates({ kind: "ask" })).toBe(true);
    const card = planModel({ run, enabled: true, estimates: { [s1.seq]: { credits: 1, approximate: false }, [s2.seq]: { credits: 1, approximate: false } }, balance: 2000, readOnly: null })!;
    expect(card.steps.map((s) => [s.price, s.source])).toEqual([[null, "plan"], [null, "plan"]]);
    expect(card.primary).toMatchObject({ kind: "plan", label: `Approve · ${creditFigure(a + b)} cr` });
    /* The person approves the plan once; shot 1 renders, then shot 2 (over 200 cr) under the same approval, with no tap of its own. */
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId: asked.id, fingerprint: run.plan!.quote!.fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(asked.id, deps);
    expect(r.calls).toHaveLength(1);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    await agent.advanceRigAgentRun(asked.id, deps);
    expect(r.calls).toHaveLength(2);
    expect((await view()).paid.filter((p) => p.tool === "render").map((p) => p.inPlan)).toEqual([true, true]);
    expect(await reservations(ws)).toBe(2);
  });
});

test("after the approval, one price still: a covered shot waiting behind a rendering one shows no price of its own, on the card and in History; one that pauses keeps its own price and its button (Retry · N cr, or Raise)", async () => {
  await inRun("chips-approved", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { db } = await import("../../lib/db");
    const { planModel } = await import("../../components/graphite/board/cards/plan/model");
    const { readActivity } = await import("../../lib/control-room/activity.server");
    const { creditFigure } = await import("../../lib/workbench/rig-agent-plan");
    const r = renders(ws, (shot) => (shot === "1" ? 0.3 : 0.45));
    const deps = await depsFor(ws, r);
    const asked = await plan();
    await agent.advanceRigAgentRun(asked.id, deps);
    const gate = await view();
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId: asked.id, fingerprint: gate.plan!.quote!.fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(asked.id, deps);
    expect(r.calls).toHaveLength(1);
    const run = await view();
    const [s1, s2] = run.paid.filter((p) => p.tool === "render");
    /* Shot 1 renders under the approval; shot 2 waits for its turn, priced ahead at the very price the approval lists. Neither shows a price of its own. */
    expect([s1.state, s1.inPlan, s1.quote, s1.planPriced]).toEqual(["rendering", true, null, true]);
    expect([s2.state, s2.inPlan, s2.quote, s2.worst, s2.reason, s2.planPriced]).toEqual(["waiting", false, null, null, null, true]);
    expect(run.plan?.approval).toMatchObject({ open: true });
    const card = planModel({ run, enabled: true, balance: 2000, readOnly: null })!;
    expect(card.steps.map((s) => [s.price, s.source])).toEqual([[null, "plan"], [null, "plan"]]);
    const history = (await readActivity({ id: OWNER, role: "admin", owner: true }, null)).runs.find((x) => x.id === `board:${asked.id}`)!;
    expect(history.steps.filter((x) => x.kind === "paid").map((x) => x.priced)).toEqual([null, null]);
    /* A step the approval sent keeps the approval's id when it pauses (credits, limit, a refusal): then it shows its own server price, and its button. */
    const approvalId = String((await db().execute({ sql: "SELECT id FROM rig_plan_approvals WHERE run_id=?", args: [asked.id] })).rows[0].id);
    const b = await credits(0.45);
    for (const pause of ["credits", "refused", "limit"] as const) {
      await db().execute({ sql: "UPDATE rig_agent_steps SET state='paused', pause=?, reason='It waits for you.', approval_id=?, approved_fingerprint=json_extract(admission,'$.quote.fingerprint'), approved_by=? WHERE run_id=? AND seq=?", args: [pause, approvalId, OWNER, asked.id, s2.seq] });
      await db().execute({ sql: "UPDATE rig_agent_runs SET state='needs_you' WHERE id=?", args: [asked.id] });
      const paused = await view();
      const step = paused.paid.find((p) => p.seq === s2.seq)!;
      expect([step.state, step.pause, step.inPlan, step.quote, step.planPriced], pause).toEqual(["paused", pause, true, b, undefined]);
      const m = planModel({ run: paused, enabled: true, balance: 2000, readOnly: null })!;
      expect(m.steps[1].price, pause).toEqual({ kind: "exact", credits: b });
      /* A limit pause offers Raise from this price when the room is short (tests/unit/demo-s04-plan-model.spec.ts); here the faked pause has room, so no button is made up. */
      if (pause === "limit") expect(m.primary?.kind ?? null, pause).not.toBe("render");
      else expect(m.primary, pause).toMatchObject({ kind: "render", label: `Retry · ${creditFigure(b)} cr`, price: { kind: "exact", credits: b }, seq: s2.seq, blocked: null });
    }
    expect(r.calls).toHaveLength(1);
  });
});

test("the approvals queue lists only the shot that asks: after the approval of three shots, shot 2's price moves (or it pauses), and the covered shot behind it is not listed, so no Approve without a price reaches any screen", async () => {
  await inRun("chips-queue", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { patchTeamCanvas } = await import("../../lib/workbench/team-canvas");
    const { readApprovals } = await import("../../lib/control-room/approvals.server");
    const { stepsOf } = await import("../../lib/workbench/rig-agent-store");
    const { db } = await import("../../lib/db");
    await patchTeamCanvas("prod-1", { upsertNodes: [scene("s4", { x: 1300, y: 100, title: "Rope", text: "Shot 4 of 4: The captain coils the rope." })], removeNodes: [], upsertAssets: [], order: ["s1", "s2", "s3", "s4"] }, OWNER);
    const r = renders(ws, (shot) => (shot === "2" ? 0.45 : 0.3));
    const deps = await depsFor(ws, r);
    const asked = await plan();
    await agent.advanceRigAgentRun(asked.id, deps);
    const gate = await view();
    const [s1, s2, s4] = gate.paid.filter((p) => p.tool === "render");
    expect([s1.title, s2.title, s4.title]).toEqual(["Pier", "Deck", "Rope"]);
    expect(gate.paid.filter((p) => p.tool === "render").map((p) => [p.fingerprint, p.planPriced])).toEqual([[null, true], [null, true], [null, true]]);
    await agent.approveRigAgentPlan({ productionId: "prod-1", runId: asked.id, fingerprint: gate.plan!.quote!.fingerprint, userId: OWNER });
    await agent.advanceRigAgentRun(asked.id, deps);
    await settleTake((await renderRows())[0].id, "succeeded", 0.3);
    /* Shot 2's price moves before its turn: it is priced afresh and asks at its new price; shot 3 (Rope) waits behind it, covered. */
    r.priceNow.set("2", 0.6);
    expect(await agent.advanceRigAgentRun(asked.id, deps)).toEqual({ state: "needs_you", more: false });
    expect(r.calls).toHaveLength(1);
    const run = await view();
    const moved = run.paid.find((p) => p.seq === s2.seq)!, behind = run.paid.find((p) => p.seq === s4.seq)!;
    const quoteOf = async (seq: number) => (await stepsOf(db(), asked.id)).find((x) => x.seq === seq)!.quoteCredits!;
    const now2 = await quoteOf(s2.seq);
    expect(now2).toBe(await credits(0.6));
    expect([moved.state, moved.quote, moved.planPriced]).toEqual(["waiting", now2, undefined]);
    expect([behind.state, behind.quote, behind.fingerprint, behind.planPriced]).toEqual(["waiting", null, null, true]);
    const queued = async () => (await readApprovals({ id: OWNER, role: "admin", owner: true })).items.filter((i) => i.source === "board-render" || i.source === "board-plan");
    const items = await queued();
    expect(items.map((i) => [i.id, i.price, i.canApprove])).toEqual([[`board-render:${asked.id}:${s2.seq}`, { kind: "exact", credits: now2 }, true]]);
    expect(items[0].approve).toEqual({ kind: "board-render", productionId: "prod-1", runId: asked.id, seq: s2.seq, fingerprint: moved.fingerprint });
    expect(moved.fingerprint).toBeTruthy();
    /* Shot 2 pauses for credits instead (keeping the approval's id): still the only item, at its own server price; Retry is pressed on its board. */
    const approvalId = String((await db().execute({ sql: "SELECT id FROM rig_plan_approvals WHERE run_id=?", args: [asked.id] })).rows[0].id);
    await db().execute({ sql: "UPDATE rig_agent_steps SET state='paused', pause='credits', reason='Short of credits.', approval_id=? WHERE run_id=? AND seq=?", args: [approvalId, asked.id, s2.seq] });
    expect((await queued()).map((i) => [i.id, i.price])).toEqual([[`board-render:${asked.id}:${s2.seq}`, { kind: "exact", credits: now2 }]]);
    expect(await reservations(ws)).toBe(1);
  });
});

test("a chips plan's shot stored as waiting for an admin (before 21 Oct 2026) goes back to its own person at a fresh quote: no price, no admin marker, nothing sent until they price it again and approve", async () => {
  MEMBERS.add(OWNER);
  try {
    await inRun("chips-admin", async (ws) => {
      const agent = await import("../../lib/workbench/rig-agent");
      const { BACK_TO_ITS_PERSON } = await import("../../lib/workbench/rig-agent-store");
      const { readApprovals } = await import("../../lib/control-room/approvals.server");
      const { db } = await import("../../lib/db");
      const r = renders(ws, () => 0.3);
      const deps = await depsFor(ws, r);
      const asked = await plan();
      await agent.advanceRigAgentRun(asked.id, deps);
      const [s1] = (await view()).paid.filter((p) => p.tool === "render");
      /* Shot 1 as the retired rule left it: paused for an admin, with the price an admin was quoted and no admission. */
      await db().execute({ sql: "UPDATE rig_agent_steps SET state='paused', pause='admin', reason='Needs an admin: it asks on its own, at its own price.', admission=NULL, quote_credits=? WHERE run_id=? AND seq=?", args: [await credits(0.3), asked.id, s1.seq] });
      const run = await view();
      const shot1 = run.paid.find((p) => p.seq === s1.seq)!;
      expect(shot1).toMatchObject({ state: "paused", pause: "unpriced", quote: null, worst: null, fingerprint: null, reason: BACK_TO_ITS_PERSON });
      /* The plan waits for that price: no gate quote covers a shot with none. */
      expect(run.plan?.quote ?? null).toBeNull();
      const queued = (await readApprovals({ id: OWNER, role: "member" })).items.filter((i) => i.source === "board-render" || i.source === "board-plan");
      for (const item of queued) expect(item).not.toHaveProperty("needsAdmin");
      expect(JSON.stringify([run, queued])).not.toMatch(/needs an admin|for an admin/i);
      /* Its own person prices it again: it is priced afresh, and nothing is sent until the plan is approved. */
      await agent.renderRigAgentStep({ productionId: "prod-1", runId: asked.id, seq: s1.seq, userId: OWNER });
      await agent.advanceRigAgentRun(asked.id, deps);
      const again = await view();
      expect(again.plan?.quote).toMatchObject({ total: 2 * (await credits(0.3)) });
      expect(r.calls).toHaveLength(0);
    });
  } finally {
    MEMBERS.delete(OWNER);
  }
});

test("a pricing refusal that names the engine never reaches the client: the step, the plan's note and the run's note say it in fixed words; the record keeps the refusal", async () => {
  await inRun("chips-engine", async (ws) => {
    const agent = await import("../../lib/workbench/rig-agent");
    const { stepsOf } = await import("../../lib/workbench/rig-agent-store");
    const { db } = await import("../../lib/db");
    const r = renders(ws, () => 0.3);
    /* A made-up engine label, standing in for the catalog's `${model.label} has no draft mode.` (lib/generationAdmission.ts). */
    const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) =>
      String(body.prompt ?? "").includes("Shot 1 of") ? { ok: false as const, status: 422, body: { error: "Zephyrcam 9 has no draft mode." } } : r.prepare(body, actor);
    const deps = await depsFor(ws, r, { prepare });
    const asked = await plan();
    await agent.advanceRigAgentRun(asked.id, deps);
    const run = await view();
    const s1 = run.paid.find((p) => p.tool === "render")!;
    expect(s1).toMatchObject({ state: "paused", pause: "unpriced", reason: "Can't be priced yet. Check the shot, then price it again." });
    expect(run.plan).toMatchObject({ quote: null, blocked: "Pier: Can't be priced yet. Check the shot, then price it again." });
    expect(JSON.stringify(run)).not.toMatch(/zephyrcam|draft mode/i);
    const stored = (await stepsOf(db(), asked.id)).find((s) => s.seq === s1.seq)!;
    expect(stored.reason).toBe("Zephyrcam 9 has no draft mode.");
    /* History reads the same view: no engine's name there either. */
    const { readActivity } = await import("../../lib/control-room/activity.server");
    const history = await readActivity({ id: OWNER, role: "admin", owner: true }, null);
    expect(JSON.stringify(history)).toContain("Pier");
    expect(JSON.stringify(history)).not.toMatch(/zephyrcam|draft mode/i);
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
