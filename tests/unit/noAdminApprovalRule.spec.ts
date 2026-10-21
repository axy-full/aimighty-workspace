import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Tripwire for the owner's decision of 21 Oct 2026, verbatim: "the admin approval rule is retired; every member approves their own spend with
 * their own tap on the quote; Atomik, tokens and MCP callers still never approve." and "The monthly limit stays as a mechanism, off by default,
 * owner-only, no Paused card".
 *
 *  - Nothing in the product reads the retired settings (`approvalRule`, `shotCapCredits`) to decide a spend; their modules are gone.
 *  - The settings route refuses them; a member is never sent them; no default is kept for them.
 *  - No product string says something "needs an admin" (the rule's words); the production cap's Unlock, an admin's, keeps its words.
 *  - Approving stays a person's: an agent identity, Auto, a token and an MCP caller are refused where they were.
 * Source reads and pure calls only: nothing is rendered, reserved or spent.
 */
const repoRoot = path.resolve(__dirname, "../..");

function sources(folder: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const file = path.join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(ts|tsx)$/.test(name)) out.push({ file: path.relative(repoRoot, file), text: readFileSync(file, "utf8") });
    }
  };
  walk(path.join(repoRoot, folder));
  return out;
}
const product = () => ["app", "lib", "components"].flatMap(sources);

/*
 * The only product files that may name a retired key, and why. Each reads no value of it to decide a spend:
 *  - lib/settings.ts names them to refuse and hide them (RETIRED_SETTING_KEYS);
 *  - lib/settingValues.ts says in a comment that they were retired;
 *  - lib/creditConversionTenant.ts is the owner's credit-unit conversion tool: it lists every saved cap for the owner's own keep-or-multiply
 *    choice (kept unless the owner names it), and it gates nothing.
 */
const MAY_NAME = new Set(["lib/settings.ts", "lib/settingValues.ts", "lib/creditConversionTenant.ts"]);

test("nothing in the product reads the retired approval rule or per-shot cap: no module, no import, no gate, no setting read", () => {
  for (const gone of ["lib/approvalRule.ts", "lib/shotCap.ts"]) expect(existsSync(path.join(repoRoot, gone)), gone).toBe(false);
  const files = product();
  expect(files.length).toBeGreaterThan(100);
  const named = files.filter((f) => /\b(approvalRule|shotCapCredits)\b/.test(f.text)).map((f) => f.file);
  expect(named.filter((f) => !MAY_NAME.has(f)), "a file names a retired setting").toEqual([]);
  /* No import of the retired modules, and none of their functions or the admin-step paths, under any name. */
  const gone = /from\s+["'][^"']*\/(approvalRule|shotCap)["']|\b(shotCapGate|shotCapAdmin|shotCapVerdict|shotCreditsSoFar|cleanShotCap|cleanRule|ruleLine|needsAdminTap|adminStepSheet|claimedStepFiling|approveAnotherStep|shotCapExempt|PausedBody|budgetPauseLine|isBudgetPauseReason)\b/;
  expect(files.filter((f) => gone.test(f.text)).map((f) => f.file)).toEqual([]);
  /* The conversion tool reads the stored row only to list it for the owner: never through getSetting, and no spending module imports the tool. */
  expect(files.filter((f) => /getSetting\(\s*["'](approvalRule|shotCapCredits)["']/.test(f.text)).map((f) => f.file)).toEqual([]);
  const spending = ["lib/generationAdmission.ts", "lib/generationRequests.ts", "lib/quote.ts", "lib/impact.ts", "lib/lipSync.ts", "lib/recraftImage.ts", "lib/batchPress.ts",
    "lib/held.ts", "lib/caps.ts", "lib/atomikAccess.ts", "lib/workbench/rig-agent-runs.ts", "lib/workbench/plan-approval.ts", "lib/control-room/approvals.server.ts"];
  for (const file of spending) expect(readFileSync(path.join(repoRoot, file), "utf8"), file).not.toMatch(/creditConversionTenant|approvalRule|shotCapCredits|needsAdmin/);
});

test("the settings route refuses the retired keys whole; no default is kept; a member is never sent them", async () => {
  const settings = await import("../../lib/settings");
  expect(settings.RETIRED_SETTING_KEYS).toEqual(["approvalRule", "shotCapCredits"]);
  for (const key of settings.RETIRED_SETTING_KEYS) expect(settings.DEFAULTS, key).not.toHaveProperty(key);
  expect(settings.memberSettings({ approvalRule: "cap", shotCapCredits: "50", capWarnPct: "80" })).toEqual({ capWarnPct: "80" });
  const route = readFileSync(path.join(repoRoot, "app/api/settings/route.ts"), "utf8");
  /* Refused before any value is checked or written (tests/unit/settingsRoute.spec.ts runs the route: 410, code "retired", nothing written). */
  const refusal = route.indexOf("RETIRED_SETTING_KEYS.includes(k)");
  expect(refusal).toBeGreaterThan(0);
  expect(refusal).toBeLessThan(route.indexOf("await setSetting("));
  expect(refusal).toBeLessThan(route.indexOf("settingProblem(k, v)"));
  expect(route).toMatch(/status: 410/);
});

test("no product string says something needs an admin for the rule; the production cap's Unlock keeps its own words; no Paused card", async () => {
  const files = product();
  expect(files.filter((f) => /needs? an admin\b/i.test(f.text)).map((f) => f.file)).toEqual([]);
  expect(files.filter((f) => /an admin above it|An admin has to press this one|An admin must start it|Before an admin|a shot over the cap waits/i.test(f.text)).map((f) => f.file)).toEqual([]);
  /* What stays: an admin unlocks or raises a production's cap. */
  expect(readFileSync(path.join(repoRoot, "lib/caps.ts"), "utf8")).toContain("An admin can unlock it or raise it.");
  expect(readFileSync(path.join(repoRoot, "components/graphite/settings/rules/RulesSection.tsx"), "utf8")).toContain('testId="settings-production-unlock">Unlock</Btn>');
  /* No Paused card, and nothing words a budget pause. */
  const money = await import("../../components/graphite/board/cards/plan/money-state");
  expect(money).not.toHaveProperty("PausedBody");
  for (const f of files.filter((x) => x.file.startsWith("components/"))) expect(f.text, f.file).not.toMatch(/Paused at \$\{|>Paused at|"Paused at \d/);
  const budgetPause = await import("../../lib/budgetPause") as Record<string, unknown>;
  for (const gone of ["budgetPauseLine", "isBudgetPauseReason"]) expect(budgetPause[gone], gone).toBeUndefined();
});

test("approving stays a person's: an agent identity, an MCP caller, a token and Auto are no approver; a token and an MCP caller are refused where they were", async () => {
  const { isPersonApprover } = await import("../../lib/workbench/plan-approval");
  for (const machine of ["agent:rar_1", "mcp:client", "token:tok_1", "auto", "AUTO", "", " u_member", null, undefined]) expect(isPersonApprover(machine as never), String(machine)).toBe(false);
  expect(isPersonApprover("u_member")).toBe(true);
  const { isPersonId } = await import("../../lib/control-room/ask-admin");
  for (const machine of ["agent:rar_1", "auto", "server", ""]) expect(isPersonId(machine), machine).toBe(false);
  /* A step's claim (its spend's approval) refuses a token as a person-only press before it reads the step, and then takes the step's own person only. */
  const claim = readFileSync(path.join(repoRoot, "app/api/atomik/steps/[id]/claim/route.ts"), "utf8");
  expect(claim.indexOf("isPerson({ user: got.user, token: got.token })")).toBeGreaterThan(0);
  expect(claim.indexOf("isPerson({ user: got.user, token: got.token })")).toBeLessThan(claim.indexOf("stepIsMine(id, got.user)"));
  expect(claim).not.toMatch(/adminStepSheet|chatless/);
  /* A batch press refuses anyone but a person (a token, an agent identity, a run marked Auto). */
  expect(readFileSync(path.join(repoRoot, "lib/batchPress.ts"), "utf8")).toMatch(/!isPersonApprover\(got\.user\.id\) \|\| isAgentId\(got\.user\.id\) \|\| got\.token != null \|\| options\.run\?\.auto === true\)\) return admissionReply\(\{ error: PEOPLE_ONLY \}, \{ status: 403 \}\)/);
  /* The MCP plan tool refuses an approval in its arguments, and its reply names no admin. */
  const mcp = readFileSync(path.join(repoRoot, "lib/mcp.ts"), "utf8");
  expect(mcp).toContain('throw new Error("The plan is not yours to approve: only a person approves spending, in Particl.")');
  expect(mcp).not.toMatch(/needs an admin/i);
  /* A plan's approval row refuses a machine approver in the database itself. */
  expect(readFileSync(path.join(repoRoot, "lib/workbench/plan-approval.ts"), "utf8")).toMatch(/CHECK \(NOT \$\{notAPersonSql\("approved_by"\)\}\)/);
});
