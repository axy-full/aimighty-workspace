import { test, expect } from "@playwright/test";
import { agentButton, agentStateLabel, priceText, runButton, runChip, stepRows } from "../../lib/workspace/atomik-view";
import { missingRequest, projectRequests, withRequestGate, type RequestKey } from "../../lib/workspace/plan-requests";
import { PLANS } from "../../lib/workspace/plans";
import type { PlanContext } from "../../lib/workspace/plan-types";
import type { RunView } from "../../lib/workspace/run-engine";
import { newProject } from "../../lib/workbench/studio";
import { createAstraScene } from "../../lib/astra-blender/scene";

const ctx: PlanContext = { projectId: "draft-1", productionId: null, data: {}, fetch: (() => { throw new Error("no fetch"); }) as typeof fetch };

const run = (patch: Partial<RunView>): RunView => ({
  id: "run-1", page: "agent", i: 0, status: "running", approved: false, quote: null, quoting: false,
  dispatching: false, dispatched: false, notice: null, error: null, details: {}, ...patch,
});

const quote = { unit: "cr" as const, credits: 1240, parts: [], expiresAt: 0, quotedAt: 0, inputKey: "k", line: "One planning pass." };

test("step marks: ✓ done, ● current, $ gate, index otherwise", () => {
  const plan = PLANS.agent;
  const idle = stepRows(plan, null, ctx);
  expect(idle.map((r) => r.mark)).toEqual(["1", "$", "3", "4"]);
  const running = stepRows(plan, run({ i: 0 }), ctx);
  expect(running.map((r) => r.mark)).toEqual(["●", "$", "3", "4"]);
  const waiting = stepRows(plan, run({ i: 1, status: "waiting", quote }), ctx);
  expect(waiting.map((r) => r.tone)).toEqual(["done", "gate", "idle", "idle"]);
  expect(waiting[1].meta).toBe("1,240 cr");
  const failed = stepRows(plan, run({ i: 2, status: "failed" }), ctx);
  expect(failed.map((r) => r.mark)).toEqual(["✓", "✓", "!", "4"]);
  const done = stepRows(plan, run({ i: 4, status: "done", details: { 2: "queued" } }), ctx);
  expect(done.every((r) => r.mark === "✓")).toBe(true);
  expect(done[2].meta).toBe("queued");
});

test("button, chip and header states follow the run", () => {
  const plan = PLANS.agent;
  expect(agentButton(null, null, false)).toMatchObject({ status: "idle", badge: "ready" });
  expect(agentButton(run({ i: 1 }), plan, false)).toMatchObject({ status: "running", badge: "1/4", running: true });
  expect(agentButton(run({ status: "waiting", quote }), plan, false)).toMatchObject({ status: "waiting", badge: "1 approval", waiting: true });
  expect(agentButton(run({ status: "waiting", quote }), plan, true).status).toBe("open");

  expect(runChip(null)).toEqual({ label: "Run with Atomik", tone: "idle" });
  expect(runChip(run({ status: "waiting", quote }))).toEqual({ label: "Approve 1,240 cr", tone: "waiting" });
  expect(runChip(run({ status: "waiting", quote: { ...quote, unit: "connected", credits: 1 } })).label).toBe("Approve 1 credit");
  expect(runChip(run({}))).toEqual({ label: "Pause run", tone: "running" });
  expect(runChip(run({ status: "paused" })).label).toBe("Resume run");

  const ok = { ok: true } as const;
  const no = { ok: false, reason: "Needs Rig data" } as const;
  expect(runButton(null, ok)).toEqual({ label: "Run this page", disabled: false, busy: false });
  expect(runButton(null, no).disabled).toBe(true);
  expect(runButton(run({ status: "waiting" }), ok)).toMatchObject({ label: "Waiting", disabled: true });
  expect(runButton(run({}), ok)).toMatchObject({ label: "Pause run", disabled: false });
  expect(runButton(run({ status: "done" }), ok).label).toBe("Run again");

  expect(agentStateLabel(null)).toBe("IDLE");
  expect(agentStateLabel(run({ status: "waiting" }))).toBe("WAITING ON YOU");
  expect(agentStateLabel(run({ quoting: true }))).toBe("QUOTING");
  expect(priceText(plan, null)).toBe(plan.priceLabel);
  expect(priceText(plan, run({ quote }))).toBe("1,240 cr");
});

test("a paid plan without its page's data is not runnable and never guesses a body", () => {
  const none = new Set<RequestKey>();
  expect(missingRequest("rig", none)).toBe("Needs Rig data");
  expect(missingRequest("models", none)).toBe("Needs Rig data");
  expect(missingRequest("edit", none)).toBe("Needs Edit & Sound data");
  expect(missingRequest("motion", none)).toBe("Needs Motion Transfer data");
  expect(missingRequest("agent", none)).toBeNull();
  expect(missingRequest("rig", new Set<RequestKey>(["shots"]))).toBeNull();

  let provided = new Set<RequestKey>();
  const plans = withRequestGate(PLANS, () => provided);
  expect(plans.rig.runnable(ctx)).toEqual({ ok: false, reason: "Needs Rig data" });
  /* Without a project, "open a project first" wins. */
  expect(plans.rig.runnable({ ...ctx, projectId: null }).ok).toBe(false);
  expect((plans.rig.runnable({ ...ctx, projectId: null }) as { reason: string }).reason).toMatch(/open a project/);
  /* Provided but empty: the plan's own reason. */
  provided = new Set<RequestKey>(["shots"]);
  expect((plans.rig.runnable(ctx) as { reason: string }).reason).toMatch(/no shot is ready/);
  expect(plans.rig.runnable({ ...ctx, request: { shots: [{ name: "Opening", body: { model: "m" } }] } })).toEqual({ ok: true });
  /* Plans that need no page data are unaffected. */
  expect(plans.agent.runnable(ctx)).toEqual({ ok: true });
  expect(plans.builds.runnable(ctx).ok).toBe(false);
});

test("Astra's request comes from the saved scene's digest, never a default scene", async () => {
  const bare = { ...newProject("Study"), id: "draft-1" };
  const empty = await projectRequests(bare);
  expect(empty.provided).toEqual(["astra"]);
  expect(empty.request.astra).toBeUndefined();
  const saved = await projectRequests({ ...bare, astraBlender: createAstraScene("product") });
  expect(saved.request.astra?.source).toBe("scene");
  expect(saved.request.astra?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(await projectRequests(null)).toEqual({ request: {}, provided: [] });
});
