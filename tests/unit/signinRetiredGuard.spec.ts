import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { PLANS } from "../../lib/workspace/plans";

/**
 * The guard for the retired Higgsfield sign-in on the page side (CLAUDE.md
 * ground rule 10): no feature may need a sign-in to a Higgsfield account. The
 * account's screens, composers, hooks and collector are deleted; nothing a page
 * renders reads the account or calls an account route; Gen, its composers and
 * the shell's chrome carry no account source. The server side (its routes,
 * sign-in, client and services) is guarded in tests/unit/signinRemovedGuard.spec.ts.
 */

test("Atomik reads nothing of the account, and the shell's capability answers member for everyone", () => {
  /* Atomik's account planner, recipes and connected step are gone (tests/unit/atomikNoAccount.spec.ts guards what replaced them). */
  for (const gone of ["app/api/atomik/recipes/route.ts", "app/api/atomik/steps/[id]/connected/route.ts", "lib/higgsfield-consumer/planner-service.ts", "lib/higgsfield-consumer/recipes-service.ts"])
    expect(existsSync(gone), gone).toBe(false);
  const hook = readFileSync("lib/shell/use-connected-capability.ts", "utf8");
  expect(hook).toContain('owner: false, status: "member" as const');
  expect(hook).not.toMatch(/fetch\(|CONNECTION_ENDPOINT|session\.owner/);
  /* No workspace plan calls an account route, not even to read: Compare reads the project's Library (GET /api/workbench/library). */
  for (const [page, plan] of Object.entries(PLANS))
    for (const step of plan.steps) expect(step.executor.backend.path, `${page}: ${step.label}`).not.toMatch(/^\/api\/higgsfield\/consumer\//);
  expect(readFileSync("lib/workspace/plans.ts", "utf8")).not.toContain("/api/higgsfield/consumer");
});

test("no page mounts a surface that starts account work: the sign-in card, the developer check, the account's composers and forms", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  for (const root of ["app", "components", "lib"]) walk(root);
  const retiredSurfaces = ["HiggsfieldConsumerConnection", "ConsumerVideoVerification", "DeveloperApiRow", "AtomikGenerate", "ConsumerGenjutsu", "ConsumerShorts", "ConsumerMarketingVideo", "ShortsPage", "FormPage", "WorkflowHosts", "WorkflowHost", "AtomikVoiceTools"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const surface of retiredSurfaces) expect(source, `${file} mounts ${surface}`).not.toMatch(new RegExp(`import[^;]*\\b${surface}\\b[^;]*from`));
    /* Nothing starts a sign-in: no connect route is called, and nothing builds the account's sign-in address. */
    expect(source, file).not.toContain("/api/higgsfield/consumer/connect");
    expect(source, file).not.toContain("clerk.higgsfield.ai");
  }
});

/* ── The account's UI and the shell's wiring to it ── */

const uiFiles = () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  for (const root of ["components", "lib/shell", "lib/workspace"]) walk(root);
  for (const entry of readdirSync("app", { withFileTypes: true, recursive: true })) {
    const path = `${entry.parentPath}/${entry.name}`;
    if (entry.isFile() && /(page|layout)\.tsx$/.test(entry.name) && !path.startsWith("app/api")) files.push(path);
  }
  return files;
};

test("the account's screens are deleted: its composers, forms, workflows, collector, diagnostics, connection card and Engines row", () => {
  for (const gone of [
    /* Workspace › Engines' retired row (Disconnect, Set aside) went with the server code. */
    "components/graphite/ConnectedAccountRow.tsx",
    "components/graphite/DeveloperApiRow.tsx", "components/graphite/tools/WorkflowHost.tsx", "components/graphite/tools/SoulIdHost.tsx",
    "components/suites/ConsumerGenjutsu.tsx", "components/suites/ConsumerMarketingVideo.tsx", "components/suites/consumer-marketing-video.module.css",
    "components/suites/ConsumerShorts.tsx", "components/suites/AtomikVoiceTools.tsx", "components/suites/atomik-generate.module.css",
    "components/management/HiggsfieldConsumerConnection.tsx", "components/management/ConsumerVideoVerification.tsx",
    "components/workspace/pages/ShortsPage.tsx", "components/workspace/mobile/pages/FormPage.tsx",
    "lib/shell/workflows.ts", "lib/shell/use-connected-collector.ts", "lib/workspace/mobile-form.ts",
    /* Business's account Ads and Setup composers, the resumed-jobs list, the account job hooks and the collector itself,
       and the ad-format template library: Ads and Setup are the retired card, Viral and Image ads run on the API key. */
    "components/graphite/ResumedJobs.tsx", "components/suites/MarketingTemplates.tsx", "components/suites/marketing-templates.module.css",
    "lib/shell/use-business.ts", "lib/shell/use-viral.ts", "lib/shell/use-connected-job.ts", "lib/shell/use-resumed-jobs.ts", "lib/shell/connected-collector.ts",
  ]) expect(existsSync(gone), gone).toBe(false);
});

test("nothing a page renders reads the account's client: only the history readers", () => {
  /* History: a take the account made, read from Particl's own records (the /usage tab's types, the tray's words).
     Cast shows an older entry's element token from its own module (lib/production/cast.ts). */
  const HISTORY = /higgsfield-consumer\/(activity-types|resume)"/;
  for (const file of uiFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from "[^"]*higgsfield-consumer\/[^"]+"/g)) expect(match[0], `${file} imports ${match[0]}`).toMatch(HISTORY);
    /* The credit history's read (the /usage tab) is the one account route a page may call. */
    expect(source, file).not.toMatch(/\/api\/higgsfield\/consumer\/(?!activity\b)/);
  }
});

test("Gen, its composers and the shell's chrome carry no account source, catalogue, identity, resumed take, Analysis or owner gate", () => {
  for (const file of [
    "components/graphite/GenView.tsx", "components/graphite/ModelSheet.tsx", "components/workspace/GenerateComposer.tsx", "components/workspace/mobile/MakeComposer.tsx",
    "lib/workspace/composer.ts", "lib/workspace/use-composer.ts", "lib/workspace/take-batch.ts", "lib/workspace/model-picker.ts",
    "components/graphite/StageStrip.tsx", "components/graphite/PageHead.tsx", "components/graphite/AtomikSheet.tsx", "components/workspace/AtomikPanel.tsx",
    "components/workspace/mobile/sheets/AtomikSheet.tsx", "components/workspace/spec/SpecInspector.tsx", "lib/workspace/atomik-host.tsx", "lib/shell/state.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/useConnectedCapability|useConnectedCollector|useResumedConnectedJobs|runsOnOwnerAccount|ownerAccountPlans|connected-collector|ResumedJobs|WorkflowHost/);
    /* A take made on the account is still named as one when it is recreated (its recipe's `billing`), but the composer holds no such source. */
    expect(source, file).not.toMatch(/state\.billing|type: "billing"|connected cr|gen-tab-analysis|gen-resumed|gen-identity|action: "characters"|action: "catalogue"/);
  }
});
