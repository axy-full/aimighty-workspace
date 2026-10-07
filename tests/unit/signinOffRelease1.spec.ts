import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import * as retired from "../../lib/higgsfield-consumer/retired";
import { PAGES as LEGACY_SUITE_PAGES } from "../../lib/suites";
import { ALL_PAGES, resolvePageId } from "../../lib/workspace/pages";
import { PLANS } from "../../lib/workspace/plans";
import { ALL_SHELL_PAGES, SHELL_SUITES } from "../../lib/shell/ia";
import { CONTROL_PLACES, SETTINGS_SECTIONS } from "../../lib/shell/palette";
import { OWNER_RUN_PAGES, OWNER_RUN_SUITES } from "../../lib/shell/connected-capability";
import { mcpTools } from "../../lib/shell/tools-connections";
import { TOOLS } from "../../lib/mcp";

/**
 * Release 1: no feature that needs a Higgsfield sign-in (lib/higgsfield-consumer/retired.ts › SIGN_IN_OFF).
 * The consumer routes' refusals are guarded in tests/unit/signinRetiredGuard.spec.ts; this spec holds the rest:
 * no registry or mounted surface offers a sign-in feature, nothing in the browser reads the connected account,
 * and the heartbeat runs every stage except the connected account's collection.
 */

function compile(source: string) {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}
function files(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) out.push(...files(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** What a person reads for a sign-in feature: its names, as the registries and pages used to list them. */
const SIGN_IN_WORDS = /\bShorts\b|Virality|Social cuts|Change voice|\bDub\b|connected account|Connect Higgsfield|Higgsfield account|sign in to Higgsfield/i;

test("the switch is on", () => {
  expect(retired.SIGN_IN_OFF).toBe(true);
  expect(retired.SIGN_IN_RETIRED).toBe(true);
  const off = retired.signInOff(async () => new Response("kept"));
  return Promise.resolve(off(new Request("https://particl.example/x"))).then(async (response) => {
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ code: "retired", error: retired.SIGN_IN_RETIRED_MESSAGE });
  });
});

test("no registry lists a sign-in feature: suites, pages, ⌘K places, Settings sections, Atomik plans, MCP tools", () => {
  const registries: Record<string, unknown> = {
    shellSuites: SHELL_SUITES.map((suite) => ({ id: suite.id, pages: suite.pages })),
    shellPages: ALL_SHELL_PAGES.map(({ page }) => page),
    controlPlaces: CONTROL_PLACES,
    settingsSections: SETTINGS_SECTIONS,
    legacySuitePages: LEGACY_SUITE_PAGES,
    legacyPages: ALL_PAGES,
    mcp: TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
    mcpRows: mcpTools(),
  };
  for (const [name, registry] of Object.entries(registries)) expect(JSON.stringify(registry), name).not.toMatch(SIGN_IN_WORDS);
  /* Shorts ran only on the account: it is no page, in either shell, and its old id resolves to none. */
  expect(LEGACY_SUITE_PAGES.subatomik.map((page) => page.id)).not.toContain("shorts");
  expect(ALL_PAGES.map((page) => page.id)).not.toContain("shorts");
  expect(resolvePageId("shorts")).toBeNull();
  /* No suite or page runs on the owner's account. */
  expect(OWNER_RUN_SUITES).toEqual([]);
  expect(OWNER_RUN_PAGES).toEqual({});
  /* No Atomik plan step calls an account route (the Shorts plan has no backend and no page to open it from). */
  for (const [page, plan] of Object.entries(PLANS))
    for (const step of plan.steps) expect(step.executor.backend.path, `${page}: ${step.label}`).not.toMatch(/^\/api\/higgsfield\/consumer\//);
});

test("no mounted surface offers a sign-in feature or reads the connected account", () => {
  /* The sign-in surfaces stay in their files, unmounted: nothing else imports or renders them. */
  const surfaces = [
    "HiggsfieldConsumerConnection", "ConsumerVideoVerification", "ConsumerCreditActivity", "DeveloperApiRow", "WorkflowHost", "WorkflowHosts",
    "ConnectedAccountRow", "AtomikVoiceTools", "ConsumerMarketingVideo", "MarketingTemplates", "ConsumerShorts", "ShortsPage", "FormPage", "OwnerRunCard", "ResumedJobs",
  ];
  const own = (file: string) => surfaces.some((surface) => file.endsWith(`/${surface}.tsx`)) || file.startsWith("lib/higgsfield-consumer/") || file.startsWith("app/api/higgsfield/consumer/");
  const all = ["app", "components", "lib"].flatMap(files);
  for (const file of all) {
    if (own(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const surface of surfaces) expect(source, `${file} renders ${surface}`).not.toMatch(new RegExp(`<${surface}[\\s/>]`));
  }
  /* Settings › Connections and Workspace › Engines have no connected-account row. */
  for (const file of ["components/graphite/settings/connections/ConnectionsSection.tsx", "components/graphite/WorkspaceView.tsx"])
    expect(readFileSync(file, "utf8"), file).not.toContain("ConnectedAccountRow");
  /* The /usage page has no connected-account tab. */
  const usage = readFileSync("app/(app)/usage/page.tsx", "utf8");
  expect(usage).not.toContain("ConsumerCreditActivity");
  expect(usage).not.toMatch(/connected-account activity/i);
  /* Only the files that are themselves off (or switched off) name an account route. */
  const callers = all.filter((file) => !own(file) && readFileSync(file, "utf8").includes("/api/higgsfield/consumer/")).sort();
  expect(callers).toEqual([
    "lib/shell/connected-capability.ts", // the route constants; the hook answers member for everyone and reads nothing
    "lib/shell/use-business.ts", // unmounted (nothing calls useBusiness); its one call is a retired action
    "lib/workspace/mobile-form.ts", // a comment
    "lib/workspace/plan-types.ts", // a comment
  ]);
});

test("the shell's collector is never made, so no browser lists or reads the connected account's jobs", () => {
  const hook = readFileSync("lib/shell/use-connected-collector.ts", "utf8");
  expect(hook).toContain("if (!scope || !owner || SIGN_IN_OFF) return;");
  expect(hook).toContain('import { SIGN_IN_OFF } from "@/lib/higgsfield-consumer/retired";');
  /* Without a collector, listing is a no-op (lib/shell/connected-collector.ts › listConnectedJobs). */
  expect(readFileSync("lib/shell/connected-collector.ts", "utf8")).toContain("return shared ? shared.list(draftId) : Promise.resolve();");
  /* Nobody is the account's owner in the shell's capability, so no surface reads the connection either. */
  expect(readFileSync("lib/shell/use-connected-capability.ts", "utf8")).toContain("const owner = !SIGN_IN_RETIRED && ");
});

/** The heartbeat, run for real with every stage's work replaced by a recorder. */
async function runSync(retiredModule: Record<string, unknown>) {
  const ran: string[] = [];
  const settings: Record<string, string> = {};
  const work = (name: string, result: unknown) => async () => { ran.push(name); return result; };
  const deps: Record<string, unknown> = {
    "@/lib/recovery": {
      recoveryFence: () => ({ status: async () => ({ state: "open" }) }),
      recoveryRoute: (fn: () => Promise<Response>) => fn,
      reserveRecoveryContinuation: async (_name: string, fn: unknown) => fn,
    },
    "@/lib/recoveryDrain": { drainRecoveryJobs: async () => { throw new Error("NOT_DRAINING"); }, RECOVERY_DRAIN_WORK_BUDGET_MS: 1 },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) }, after: () => {} },
    "@/lib/db": { ready: async () => {}, db: () => ({ execute: async () => ({ rows: [{ pending: 0, atrisk: 0 }] }) }) },
    "@/lib/jobs": { syncPending: work("generations", { failed: false, deferred: 0 }) },
    "@/lib/pipeline/executor": { drainPipelineWakeups: work("pipelines", { failed: false }) },
    "@/lib/identities": { syncTrainingIdentities: work("training", { failed: false }) },
    "@/lib/soulIdentities": { syncSoulIdentities: work("soul_training", { failed: false }) },
    "@/lib/higgsfield-consumer/sweep": { sweepConsumerJobs: work("connected_jobs", { deferred: false }) },
    "@/lib/higgsfield-consumer/retired": retiredModule,
    "@/lib/workbench/canvas-push": { drainCanvasPushes: work("canvas_pushes", {}) },
    "@/lib/workbench/rig-agent": { drainRigAgentWakeups: work("rig_agents", {}) },
    "@/lib/storageCost": { backfillSizes: work("storage_sizes", {}) },
    "@/lib/uploadReservations": { cleanupExpiredUploads: work("expired_uploads", {}) },
    "@/lib/held": { releaseHeldJobs: work("held_jobs", {}) },
    "@/lib/genjutsuVideo": { expireUnansweredCinemaTakes: work("cinema_unanswered", { expired: [] }) },
    "@/lib/settings": { setSetting: async (key: string, value: string) => { settings[key] = value; } },
    "@/lib/platform": { platformReady: async () => {}, platformDb: () => ({}), getWorkspace: async (id: string) => ({ id, deletedAt: null }) },
    "@/lib/tenant": { runInTenant: async (_workspace: unknown, fn: () => Promise<unknown>) => fn() },
    "@/lib/purge": { retireDeletedWorkspaces: async () => {} },
    "@/lib/reconciliation": {
      reconcileWorkspaces: async (input: { visit: (id: string, deadlineAt: number) => Promise<{ failed: boolean }> }) => {
        const visit = await input.visit("workspace-1", Date.now() + 60_000);
        return { ok: !visit.failed, visited: 1 };
      },
    },
  };
  const output = { exports: {} as { GET(request: Request): Promise<Response> } };
  new Function("require", "module", "exports", compile(readFileSync("app/api/cron/sync/route.ts", "utf8")))((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected cron dependency ${name}`);
    return deps[name];
  }, output, output.exports);
  const secret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron-test-secret";
  const log = console.info, error = console.error;
  console.info = () => {}; console.error = () => {};
  try {
    const response = await output.exports.GET(new Request("https://particl.example/api/cron/sync", { headers: { authorization: "Bearer cron-test-secret" } }));
    return { response, ran, settings };
  } finally {
    console.info = log; console.error = error;
    if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
  }
}

const EVERY_OTHER_STAGE = ["generations", "pipelines", "training", "soul_training", "canvas_pushes", "rig_agents", "storage_sizes", "expired_uploads", "cinema_unanswered", "held_jobs"];

test("the heartbeat runs every other stage, in order, and never the connected account's collection", async () => {
  const { response, ran, settings } = await runSync(retired as unknown as Record<string, unknown>);
  expect(response.status).toBe(200);
  expect(ran).toEqual(EVERY_OTHER_STAGE);
  expect(ran).not.toContain("connected_jobs");
  /* Leaving the stage out is not a failure or a deferral: the heartbeat still counts as a full success. */
  expect(settings.lastCronStatus).toBe("succeeded");
  expect(JSON.parse(settings.lastCronResult)).toMatchObject({ ok: true, deferred: false });
  expect(settings.lastCronAt).toBeTruthy();
});

test("the collection stage is gated by the switch alone: switched back on, it would run in its old place", async () => {
  const { ran } = await runSync({ ...retired, SIGN_IN_OFF: false });
  expect(ran).toEqual([...EVERY_OTHER_STAGE.slice(0, 4), "connected_jobs", ...EVERY_OTHER_STAGE.slice(4)]);
});
