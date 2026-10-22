import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Which browser specs a pull request runs (scripts/ci-select.mjs; docs/ci.md): the whole suite after a merge and for any change that
 * is not presentational (money, sign-in, tenant separation, shared code, everything in lib/); a slimmer set (touched specs plus a fixed
 * guard set) for CSS, presentational new-interface files and unit tests; none for documentation. A PR that changes a browser spec runs
 * the whole suite (owner, 19 Oct 2026). A dry run over example diffs, on the repository's real files.
 */
type Run = { name: string; suite: "workbench" | "customer"; grep: string | null; specs: string[] };
type Plan = { mode: "full" | "slim" | "docs"; reasons: string[]; runs: Run[]; fiveMinute: boolean };
type Input = { event: string; base: string; files: string[]; specs: string[]; read?: (path: string) => string | null; exposed?: Set<string> };
const script = async () => (await import("../../scripts/ci-select.mjs")) as {
  select: (input: Input) => Plan;
  exposedV12: () => Set<string>;
  GUARDS: { workbench: string[]; customer: string[]; switchOffGrep: string };
  WORKBENCH_SPEC: RegExp; CUSTOMER_SPEC: RegExp;
};
const SPECS = readdirSync("tests").filter((n) => /\.spec\.ts$/.test(n)).map((n) => `tests/${n}`);
const readReal = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const pr = async (files: string[], base = "release/1", event = "pull_request", over: Partial<Input> = {}) => {
  const { select, exposedV12 } = await script();
  return select({ event, base, files, specs: SPECS, read: readReal, exposed: exposedV12(), ...over });
};
/* Nothing outside components/v12 imports anything: for the cases that need a stylesheet or a file to count as presentational. */
const unexposed = { exposed: new Set<string>() };
const specsOf = (plan: Plan) => plan.runs.flatMap((r) => r.specs);
const BROWSER_SPEC_RULE = "the full plan at its head (owner, 19 Oct 2026";
/* A PR that changes a browser spec: the whole suite, and the plan quotes the owner's rule for that spec. */
const expectSpecFull = (plan: Plan, spec: string) => {
  expect(plan.mode, spec).toBe("full");
  expect(plan.runs, spec).toEqual([]);
  expect(plan.fiveMinute, spec).toBe(true);
  expect(plan.reasons.join(" "), spec).toContain(`changes a browser spec (${spec}): ${BROWSER_SPEC_RULE}`);
};

test("the suite patterns here are the playwright configs' own", async () => {
  const { WORKBENCH_SPEC, CUSTOMER_SPEC } = await script();
  const source = (file: string) => readFileSync(file, "utf8");
  expect(source("playwright.workbench.config.ts")).toContain(WORKBENCH_SPEC.source.replace(/\\\//g, "/"));
  expect(source("playwright.customer.config.ts")).toContain(CUSTOMER_SPEC.source);
});

test("every merge into release/1 or main runs the whole suite, whatever it touched", async () => {
  for (const base of ["release/1", "main"]) {
    const plan = await pr(["docs/ci.md"], base, "push");
    expect(plan.mode, base).toBe("full");
    expect(plan.runs).toEqual([]);
    expect(plan.fiveMinute).toBe(true);
  }
});

test("a pull request into main runs the whole suite", async () => {
  expect((await pr(["components/v12/rounds/rounds.css"], "main", "pull_request", unexposed)).mode).toBe("full");
});

test("money, sign-in, tenant, server and shared-code changes run the whole suite", async () => {
  const full = [
    ["lib/credits.ts"], ["lib/billingLedger.ts"], ["lib/approvalRule.ts"], ["lib/session.ts"], ["lib/auth/session.ts"], ["app/api/generate/quote/route.ts"],
    ["middleware.ts"], ["lib/workbench/studio.ts"],
    /* Everything in lib/, including lib/v12/ and the files a reviewer named: none of them may run slim. */
    ["lib/v12/quote.ts"], ["lib/v12/useQuote.ts"], ["lib/v12/unpriced.ts"], ["lib/v12/billing.ts"], ["lib/v12/rounds.ts"], ["lib/v12/renderFacts.ts"],
    ["lib/v12/queuePosition.server.ts"], ["lib/v12/typicalTimes.server.ts"], ["lib/v12/renderState.ts"], ["lib/v12/renderCancel.ts"], ["lib/v12/campaign.ts"],
    ["lib/v12/board/stages.ts"], ["lib/anything.server.ts"], ["components/v12/anything.server.ts"],
    /* New-interface files with money, holds, charges, cancels or fetches, or that a file outside components/v12 imports. */
    ["components/v12/render/use-render.ts"], ["components/v12/render/use-batch.ts"], ["components/v12/make/use-results.ts"], ["components/v12/rig/model.ts"],
    ["components/v12/make/Composer.tsx"], ["components/v12/rounds/RoundCard.tsx"], ["components/v12/board/campaign/FormatsStage.tsx"],
    ["components/graphite/board/BoardView.tsx"], ["components/graphite/SpendButton.tsx"], ["components/v12/ui/Price.tsx"], ["components/v12/settings/CreditsPage.tsx"],
    ["tests/helpers/workbenchLocal.ts"], ["tests/unit/spend-buttons.spec.ts"], ["tests/unit/spend-ratchet.json"], ["tests/helpers/paidRoutes.ts"],
    ["playwright.workbench.config.ts"], ["package.json"], ["package-lock.json"], [".github/workflows/verify.yml"], ["scripts/ci-select.mjs"], ["app/page.tsx"],
    /* One shared file among presentational ones is enough. */
    ["components/v12/rounds/rounds.css", "lib/credits.ts"],
  ];
  for (const files of full) {
    const plan = await pr(files);
    expect(plan.mode, files.join(" + ")).toBe("full");
    expect(plan.fiveMinute).toBe(true);
  }
});

test("a new-interface file is slim only when it is presentational, unexposed and readable", async () => {
  const path = "components/v12/home/Greeting.tsx";
  const slim = (text: string | null, exposed = new Set<string>()) => pr([path], "release/1", "pull_request", { read: () => text, exposed });
  expect((await slim("export const Greeting = () => <p>Hello</p>;")).mode).toBe("slim");
  expect((await slim("export const Box = () => <input placeholder=\"Name\" />;")).mode, "a placeholder is not a hold").toBe("slim");
  for (const text of ["const r = await fetch(url);", "const u = '/api/me';", "const quote = 1;", "const price = 2;", "const credit = 3;", "const charged = 1;", "const billed = 1;", "const hold = 1;", "const refund = 1;",
    "const cancelled = 1;", "const approved = 1;", "const ledger = 1;", "const workspace_id = 1;", "const cr = 1;"]) {
    expect((await slim(`export const A = () => null; ${text}`)).mode, text).toBe("full");
  }
  expect((await slim(null)).mode, "a deleted file cannot be read").toBe("full");
  expect((await slim("export const A = () => null;", new Set(["components/v12/home/Greeting"]))).mode, "imported from outside components/v12").toBe("full");
});

test("what a file outside components/v12 imports from it is exposed, directly or through other new-interface files", async () => {
  const { exposedV12 } = await script();
  const exposed = exposedV12();
  /* BoardView (components/graphite) imports RoundCard and the Campaign stages; those import their own helpers. */
  expect(exposed.has("components/v12/rounds/RoundCard")).toBe(true);
  expect(exposed.has("components/v12/board/campaign/FormatsStage")).toBe(true);
  expect(exposed.has("components/v12/ui/Price")).toBe(true);
});

test("a stylesheet that something outside components/v12 imports is shared: the whole suite", async () => {
  /* components/graphite/board/BoardView.tsx imports components/v12/board/board.css; the shell imports v12.css. */
  for (const css of ["components/v12/board/board.css", "components/v12/v12.css"]) {
    const plan = await pr([css]);
    expect(plan.mode, css).toBe("full");
  }
  const { exposedV12 } = await script();
  expect(exposedV12().has("components/v12/board/board.css")).toBe(true);
  /* The same stylesheet with nothing importing it from outside is presentational. */
  expect((await pr(["components/v12/board/board.css"], "release/1", "pull_request", unexposed)).mode).toBe("slim");
});

test("any change to a guard or safety test is a full run, and the plan says it needs the owner's review", async () => {
  const guards = [
    "tests/unit/spend-buttons.spec.ts", "tests/unit/spend-ratchet.json", "tests/spend-buttons-workbench.spec.ts", "tests/helpers/paidRoutes.ts", "tests/unit/platformOwnerPrivacy.spec.ts",
    "tests/unit/v12-privacy.spec.ts", "tests/unit/new-interface-switch-off.spec.ts", "tests/unit/newInterfaceSwitch.spec.ts", "tests/unit/one-design-guard.spec.ts", "tests/unit/ui-names-guard.spec.ts",
    "tests/unit/v12-tooltip-audit.spec.ts", "tests/signin-retired-workbench.spec.ts", "tests/unit/signinRetiredGuard.spec.ts", "tests/audit-money-workbench.spec.ts", "tests/r1-port-paid-sends-workbench.spec.ts",
    "tests/unit/demo-gaps-l5-client-link.spec.ts",
  ];
  for (const file of guards) {
    const plan = await pr([file], "release/1", "pull_request", unexposed);
    expect(plan.mode, file).toBe("full");
    expect(plan.reasons.join(" "), file).toContain("guard test changed: owner review");
  }
  /* An ordinary test next to a guard does not make the guard slim; an ordinary browser spec alone is a full run too (owner, 19 Oct 2026). */
  const mixed = await pr(["tests/rounds-v12-workbench.spec.ts", "tests/unit/spend-buttons.spec.ts"], "release/1", "pull_request", unexposed);
  expect(mixed.mode).toBe("full");
  expectSpecFull(await pr(["tests/rounds-v12-workbench.spec.ts"], "release/1", "pull_request", unexposed), "tests/rounds-v12-workbench.spec.ts");
});

test("a pull request whose changed files cannot be read runs the whole suite", async () => {
  expect((await pr([])).mode).toBe("full");
});

test("CSS and tests run slim: their own specs plus the fixed guard set, and nothing else", async () => {
  const { GUARDS } = await script();
  const plan = await pr(["components/v12/rounds/rounds.css", "tests/unit/v12-rounds.spec.ts"], "release/1", "pull_request", unexposed);
  expect(plan.mode).toBe("slim");
  expect(plan.fiveMinute).toBe(true);
  const workbench = plan.runs.find((r) => r.suite === "workbench" && r.grep === null)!;
  expect(workbench.specs).toEqual([...new Set(["tests/rounds-v12-workbench.spec.ts", ...GUARDS.workbench])].sort());
  /* The guard set: spend, paid sends, money audit, the retired sign-in, the visitor pages, the switch-off checks and a customer smoke test. */
  for (const spec of ["tests/spend-buttons-workbench.spec.ts", "tests/signin-retired-workbench.spec.ts", "tests/r1-port-paid-sends-workbench.spec.ts",
    "tests/audit-money-workbench.spec.ts", "tests/marketing-site-workbench.spec.ts", "tests/demo-s15-guest-home-workbench.spec.ts"]) expect(workbench.specs, spec).toContain(spec);
  const off = plan.runs.find((r) => r.grep === GUARDS.switchOffGrep)!;
  expect(off.specs.length).toBeGreaterThan(8);
  /* Only specs that have a switch-off test: a chunk of none would fail with "No tests found". */
  for (const spec of off.specs) {
    expect(/-v12-.*workbench\.spec\.ts$/.test(spec), spec).toBe(true);
    expect(readFileSync(spec, "utf8"), spec).toMatch(/switch off/);
  }
  expect(off.specs).not.toContain("tests/rounds-v12-workbench.spec.ts");
  const customer = plan.runs.find((r) => r.suite === "customer")!;
  expect(customer.specs).toEqual(GUARDS.customer);
  expect(new Set(specsOf(plan)).size).toBeLessThan(30);
  for (const spec of specsOf(plan)) expect(SPECS, spec).toContain(spec);
});

test("a changed browser spec runs the whole suite; a changed area maps to its own specs; an unmapped new-interface path runs every new-interface spec", async () => {
  expectSpecFull(await pr(["tests/shots-v12-workbench.spec.ts"]), "tests/shots-v12-workbench.spec.ts");
  const board = await pr(["components/v12/board/board.css"], "release/1", "pull_request", unexposed);
  expect(board.mode).toBe("slim");
  expect(board.runs[0].specs).toContain("tests/campaign-v12-workbench.spec.ts");
  expect(board.runs[0].specs).not.toContain("tests/rig-v12-workbench.spec.ts");
  const css = await pr(["components/v12/v12.css"], "release/1", "pull_request", unexposed);
  expect(css.mode).toBe("slim");
  expect(css.runs[0].specs.length + (css.runs.find((r) => r.grep)?.specs.length ?? 0)).toBeGreaterThan(15);
  expectSpecFull(await pr(["tests/customer.spec.ts"]), "tests/customer.spec.ts");
});

test("owner, 19 Oct 2026: a pull request that changes a browser spec runs the full plan at its head; a unit spec or docs alone do not", async () => {
  /* A browser spec alone: tests/*.spec.ts at the top (the #845 case), in a subfolder such as tests/redesign/, and with a presentational file. */
  for (const spec of ["tests/r1-d0-check-workbench.spec.ts", "tests/redesign/board-frame.spec.ts", "tests/home-v12-layout-workbench.spec.ts"]) {
    expectSpecFull(await pr([spec], "release/1", "pull_request", unexposed), spec);
  }
  const greeting = { ...unexposed, read: () => "export const Greeting = () => <p>Hello</p>;" };
  expectSpecFull(await pr(["components/v12/home/Greeting.tsx", "tests/home-v12-workbench.spec.ts"], "release/1", "pull_request", greeting), "tests/home-v12-workbench.spec.ts");
  /* Several: the reason names them. */
  const many = await pr(["tests/a-workbench.spec.ts", "tests/b-workbench.spec.ts"], "release/1", "pull_request", unexposed);
  expect(many.mode).toBe("full");
  expect(many.reasons.join(" ")).toContain("changes a browser spec (tests/a-workbench.spec.ts, tests/b-workbench.spec.ts)");
  /* Already full for another reason: both reasons are in the plan. */
  const both = await pr(["tests/shots-v12-workbench.spec.ts", "lib/credits.ts"]);
  expect(both.mode).toBe("full");
  expect(both.reasons.join(" ")).toContain(`changes a browser spec (tests/shots-v12-workbench.spec.ts): ${BROWSER_SPEC_RULE}`);
  expect(both.reasons.join(" ")).toContain("touches lib/credits.ts");
  /* A unit spec alone runs in the unit shards, which every plan runs: this rule does not make it full. */
  const unit = await pr(["tests/unit/v12-rounds.spec.ts"], "release/1", "pull_request", unexposed);
  expect(unit.mode).toBe("slim");
  expect(unit.reasons.join(" ")).not.toContain("changes a browser spec");
  /* Non-spec test files under tests/redesign/ stay as they were. */
  expect((await pr(["tests/redesign/board-frame.shots.ts"], "release/1", "pull_request", unexposed)).mode).toBe("slim");
  /* Documentation alone is still docs. */
  expect((await pr(["docs/ci.md"])).mode).toBe("docs");
  /* A presentational new-interface component alone, with no spec, is still slim, and still runs its area's specs. */
  const component = await pr(["components/v12/home/Greeting.tsx"], "release/1", "pull_request", greeting);
  expect(component.mode).toBe("slim");
  expect(specsOf(component)).toContain("tests/home-v12-workbench.spec.ts");
  /* A push or a PR into main is full as before, with no browser-spec reason needed. */
  expect((await pr(["tests/r1-d0-check-workbench.spec.ts"], "main")).mode).toBe("full");
});

test("a documentation-only change runs no browser specs and no five-minute test", async () => {
  const plan = await pr(["docs/ci.md", "README.md", "docs/redesign/inventory.md"]);
  expect(plan.mode).toBe("docs");
  expect(plan.runs).toEqual([]);
  expect(plan.fiveMinute).toBe(false);
  /* Docs next to a CSS file is not docs only. */
  expect((await pr(["docs/ci.md", "components/v12/rounds/rounds.css"], "release/1", "pull_request", unexposed)).mode).toBe("slim");
});

test("the workflow gates its jobs on the plan, keeps the required check names, reports the five-minute test without requiring it, and never cancels a post-merge run", async () => {
  const workflow = readFileSync(".github/workflows/verify.yml", "utf8");
  expect(workflow).toMatch(/push:\n\s+branches: \[main, release\/1\]/);
  expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  for (const job of ["unit:", "core:", "browser-shards:", "browser:"]) expect(workflow).toContain(`\n  ${job}`);
  expect(workflow).toMatch(/browser-shards:\n\s+needs: plan\n\s+if: needs\.plan\.outputs\.mode == 'full'/);
  expect(workflow).toMatch(/browser-slim:\n\s+needs: plan\n\s+if: needs\.plan\.outputs\.mode == 'slim'/);
  expect(workflow).toContain('*) echo "::error::No plan was made for this run."; exit 1 ;;');
  expect(workflow).toContain('docs) test "$SHARDS" = skipped && test "$SLIM" = skipped ;;');
  expect(workflow).toContain('full) test "$SHARDS" = success ;;');
  /* The five-minute result is shown, never a condition of the gate. */
  expect(workflow).toContain("five-minute (reported, not required yet): $FIVE");
  expect(workflow).not.toMatch(/test "\$FIVE" = success/);
});

test("the runner passes an empty switch-off chunk instead of failing it", async () => {
  expect(readFileSync("scripts/ci-run-specs.sh", "utf8")).toContain('--grep "$GREP" --pass-with-no-tests');
});
