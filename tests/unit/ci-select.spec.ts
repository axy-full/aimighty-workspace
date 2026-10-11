import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Which browser specs a pull request runs (scripts/ci-select.mjs; docs/ci.md): the whole suite after a merge and for money,
 * sign-in, tenant-separation and shared-code changes; a slimmer set (touched specs plus a fixed guard set) for a PR into
 * release/1 that only touches new-interface files; none for documentation. Pure: a dry run over example diffs.
 */
type Run = { name: string; suite: "workbench" | "customer"; grep: string | null; specs: string[] };
type Plan = { mode: "full" | "slim" | "docs"; reasons: string[]; runs: Run[]; fiveMinute: boolean };
const script = async () => (await import("../../scripts/ci-select.mjs")) as {
  select: (input: { event: string; base: string; files: string[]; specs: string[] }) => Plan;
  GUARDS: { workbench: string[]; customer: string[]; switchOffGrep: string };
  WORKBENCH_SPEC: RegExp; CUSTOMER_SPEC: RegExp;
};
const SPECS = readdirSync("tests").filter((n) => /\.spec\.ts$/.test(n)).map((n) => `tests/${n}`);
const pr = async (files: string[], base = "release/1", event = "pull_request") => (await script()).select({ event, base, files, specs: SPECS });
const specsOf = (plan: Plan) => plan.runs.flatMap((r) => r.specs);

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
  expect((await pr(["components/v12/rounds/RoundCard.tsx"], "main")).mode).toBe("full");
});

test("a money, sign-in, tenant or shared-code change runs the whole suite", async () => {
  const full = [
    ["lib/credits.ts"], ["lib/billingLedger.ts"], ["lib/approvalRule.ts"], ["lib/session.ts"], ["lib/auth/session.ts"], ["app/api/generate/quote/route.ts"],
    ["middleware.ts"], ["lib/workbench/studio.ts"], ["lib/v12/quote.ts"], ["lib/v12/useQuote.ts"], ["lib/v12/unpriced.ts"], ["lib/v12/billing.ts"],
    ["components/graphite/board/BoardView.tsx"], ["components/graphite/SpendButton.tsx"], ["components/v12/ui/Price.tsx"], ["components/v12/settings/CreditsPage.tsx"],
    ["tests/helpers/workbenchLocal.ts"], ["tests/unit/spend-buttons.spec.ts"], ["tests/unit/spend-ratchet.json"], ["tests/helpers/paidRoutes.ts"],
    ["playwright.workbench.config.ts"], ["package.json"], ["package-lock.json"], [".github/workflows/verify.yml"], ["scripts/ci-select.mjs"],
    ["app/page.tsx"],
    /* One shared file among new-interface ones is enough. */
    ["components/v12/rounds/RoundCard.tsx", "lib/credits.ts"],
  ];
  for (const files of full) {
    const plan = await pr(files);
    expect(plan.mode, files.join(" + ")).toBe("full");
    expect(plan.fiveMinute).toBe(true);
  }
});

test("a pull request whose changed files cannot be read runs the whole suite", async () => {
  expect((await pr([])).mode).toBe("full");
});

test("a new-interface change runs its own specs plus the fixed guard set, and nothing else", async () => {
  const { GUARDS } = await script();
  const plan = await pr(["components/v12/rounds/RoundCard.tsx", "lib/v12/rounds.ts", "tests/unit/v12-rounds.spec.ts"]);
  expect(plan.mode).toBe("slim");
  expect(plan.fiveMinute).toBe(true);
  const workbench = plan.runs.find((r) => r.suite === "workbench" && r.grep === null)!;
  expect(workbench.specs).toEqual([...new Set(["tests/rounds-v12-workbench.spec.ts", ...GUARDS.workbench])].sort());
  /* The guard set: the spend pages, the switch-off checks of every new-interface spec, and a customer smoke test. */
  expect(workbench.specs).toContain("tests/spend-buttons-workbench.spec.ts");
  const off = plan.runs.find((r) => r.grep === GUARDS.switchOffGrep)!;
  expect(off.specs.length).toBeGreaterThan(10);
  expect(off.specs.every((s) => /-v12-.*workbench\.spec\.ts$/.test(s))).toBe(true);
  expect(off.specs).not.toContain("tests/rounds-v12-workbench.spec.ts");
  const customer = plan.runs.find((r) => r.suite === "customer")!;
  expect(customer.specs).toEqual(GUARDS.customer);
  /* Far fewer than the 180-odd specs of the whole suite. */
  expect(new Set(specsOf(plan)).size).toBeLessThan(30);
  for (const spec of specsOf(plan)) expect(SPECS, spec).toContain(spec);
});

test("a changed spec runs itself; a changed area maps to its own specs; an unmapped new-interface path runs every new-interface spec", async () => {
  const own = await pr(["tests/shots-v12-workbench.spec.ts"]);
  expect(own.runs[0].specs).toContain("tests/shots-v12-workbench.spec.ts");
  const campaign = await pr(["components/v12/board/campaign/FormatsStage.tsx"]);
  expect(campaign.mode).toBe("slim");
  expect(campaign.runs[0].specs).toContain("tests/campaign-v12-workbench.spec.ts");
  expect(campaign.runs[0].specs).not.toContain("tests/rig-v12-workbench.spec.ts");
  const css = await pr(["components/v12/v12.css"]);
  expect(css.mode).toBe("slim");
  expect(css.runs[0].specs.length + (css.runs.find((r) => r.grep)?.specs.length ?? 0)).toBeGreaterThan(15);
  const customerSpec = await pr(["tests/customer.spec.ts"]);
  expect(customerSpec.runs.find((r) => r.suite === "customer")!.specs).toContain("tests/customer.spec.ts");
});

test("a documentation-only change runs no browser specs and no five-minute test", async () => {
  const plan = await pr(["docs/ci.md", "README.md", "docs/redesign/inventory.md"]);
  expect(plan.mode).toBe("docs");
  expect(plan.runs).toEqual([]);
  expect(plan.fiveMinute).toBe(false);
  /* Docs next to a new-interface file is not docs only. */
  expect((await pr(["docs/ci.md", "components/v12/rounds/RoundCard.tsx"])).mode).toBe("slim");
});

test("the workflow gates its jobs on the plan, keeps the required check names and never cancels a post-merge run", async () => {
  const workflow = readFileSync(".github/workflows/verify.yml", "utf8");
  expect(workflow).toMatch(/push:\n\s+branches: \[main, release\/1\]/);
  expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  for (const job of ["unit:", "core:", "browser-shards:", "browser:"]) expect(workflow).toContain(`\n  ${job}`);
  expect(workflow).toMatch(/browser-shards:\n\s+needs: plan\n\s+if: needs\.plan\.outputs\.mode == 'full'/);
  expect(workflow).toMatch(/browser-slim:\n\s+needs: plan\n\s+if: needs\.plan\.outputs\.mode == 'slim'/);
  /* The gate fails on no plan, and passes docs only when nothing was asked for. */
  expect(workflow).toContain('*) echo "::error::No plan was made for this run."; exit 1 ;;');
  expect(workflow).toContain('docs) test "$SHARDS" = skipped && test "$SLIM" = skipped && test "$FIVE" = skipped ;;');
});
