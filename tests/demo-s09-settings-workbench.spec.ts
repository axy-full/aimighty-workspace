import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { setNewInterface, signInWithNewInterface } from "./helpers/newInterface";
import { joinLocallyAsMember } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";

/**
 * Settings in five sections, behind the avatar (design/particl-graphite/README.md § 3.5, § 1.2), with the new
 * interface on: Team and Plan & credits drawn, the other three opening the page that holds them today; old
 * Workspace links landing on their section; the avatar menu's items; and, with it off, Workspace as it was.
 * Every route below answers in its real shape (the same shapes tests/suites-workspace-workbench.spec.ts holds).
 * Nothing here spends: a top-up is a request the platform approves, and the request is mocked.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-settings", productionProjectId: "prod-settings", shotMappings: {} });

async function open(page: Page, path: string, opts: { on?: boolean; member?: APIRequestContext } = {}) {
  if (opts.member) { const { workspace } = await joinLocallyAsMember(opts.member, page.request); await setNewInterface(workspace.id, true); }
  else if (opts.on !== false) await signInWithNewInterface(page.request); else await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  const writes: { url: string; method: string; body: unknown }[] = [];
  const team = {
    mail: { configured: true, from: null }, canSeeRoles: true,
    users: [
      { id: "u1", email: "owner@example.test", name: "Workspace Owner", role: "admin", standing: "owner", permanent: true, disabled: false, locked: false, lastSeen: Date.now(), createdAt: 1, clips: 12 },
      { id: "u2", email: "j@example.test", name: "Jordan Lee", role: "member", standing: "member", permanent: false, disabled: false, locked: false, lastSeen: null, createdAt: 2, clips: 0 },
    ],
    invites: [{ code: "inv_old", email: "r@example.test", name: "Riley", role: "member", createdAt: 1, expiresAt: Date.now() + 86_400_000, sentAt: null, sendCount: 0 }],
  };
  await page.route("**/api/team", async (route) => {
    if (route.request().method() === "POST") { writes.push({ url: "/api/team", method: "POST", body: route.request().postDataJSON() }); return route.fulfill({ json: { code: "inv_new123", email: "m@example.test", name: "Maya", role: "member" } }); }
    return route.fulfill({ json: team });
  });
  await page.route(/\/api\/team\/(u2|invites\/inv_old)(\/send)?$/, async (route) => {
    writes.push({ url: new URL(route.request().url()).pathname, method: route.request().method(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/billing", (route) => route.fulfill({ json: {
    canManage: true, packs: [], credits: { balance: 2000 }, reach: null, rates: null,
    plans: [{ id: "invite", label: "Invite", priceUsd: 0, includedCredits: 0, maxProductions: 1, maxMembers: 3 }, { id: "studio", label: "Studio", priceUsd: 49, includedCredits: 400, maxProductions: null, maxMembers: null }],
    subscription: { planId: "studio", status: "active", interval: "month", currentPeriodStart: Date.UTC(2026, 9, 1), currentPeriodEnd: Date.UTC(2026, 10, 1), cancelAtPeriodEnd: false },
  } }));
  await page.route(/\/api\/statements$/, (route) => route.fulfill({ json: { months: [{ month: "2026-09", takes: 14 }] } }));
  await page.route(/\/api\/workspaces\/topups(\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") { writes.push({ url: "/api/workspaces/topups", method: "POST", body: route.request().postDataJSON() }); return route.fulfill({ status: 201, json: { request: { id: "t1", label: "Starter", credits: 500, bonus: 0, usd: 50, status: "requested" }, checkout: { kind: "queued" } } }); }
    return route.fulfill({ json: { applies: true, provider: "manual", canRequest: !opts.member, openLimit: 3, creditUsd: 0.1, credits: null,
      packs: [{ id: "starter", label: "Starter", credits: 500, bonus: 0, total: 500, usd: 50, perCredit: 0.1 }, { id: "team", label: "Team", credits: 2000, bonus: 200, total: 2200, usd: 200, perCredit: 0.091 }],
      requests: [], history: [{ id: "g1", credits: 250, note: "Welcome credits", createdAt: Date.UTC(2026, 9, 1) }] } });
  });
  /* GET /api/usage: the summary, and the ledger's pages (`rows=1`, with the month's totals; `rows=connected`). */
  await page.route(/\/api\/usage(\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    if (q.get("rows") === "connected") return route.fulfill({ json: { unit: "connected", rows: [], next: null } });
    if (q.get("rows") === "1") return route.fulfill({ json: { unit: "credits", month: q.get("month"), months: ["2026-10"], totals: { jobs: 9, charged: 163, held: 20, notBilled: 1 }, rows: [], next: null } });
    return route.fulfill({ json: { unit: "credits", pending: 1, spentCredits: 312, promptSpendCredits: 0, credits: { granted: 2312, used: 312, balance: 2000 }, vendors: [], totalGenerations: 15, succeeded: 15, failed: 0, promptCount: 0, storage: null, timing: [], refines: [],
      byModel: [{ model: "seedance-2.5", label: "Seedance 2.5", provider: "byteplus", kind: "video", n: 6, credits: 240, spend: 240, promptSpend: 0 }, { model: "nano-banana-2", label: "Nano Banana 2", provider: "google", kind: "image", n: 9, credits: 72, spend: 72, promptSpend: 0 }], byProject: [], byPerson: [] } });
  });
  await page.route("**/api/account/security", (route) => route.fulfill({ json: { enabled: true, requiredWorkspaces: [], recoveryCodesRemaining: 8,
    sessions: [{ id: "s1", current: true, label: "Chrome on macOS", createdAt: Date.now() - 86_400_000, expiresAt: Date.now() + 86_400_000 }, { id: "s2", current: false, label: "Safari on iPhone", createdAt: Date.now() - 3 * 86_400_000, expiresAt: Date.now() + 86_400_000 }] } }));
  await page.route("**/api/workspaces/security", (route) => route.fulfill({ json: { requiresMfa: false, ownerEnrolled: true, members: 2, unenrolled: 1 } }));
  await page.route(/\/api\/workspaces\/audit(\?.*)?$/, (route) => route.fulfill({ json: { events: [{ id: "e1", workspaceId: "w", actorId: "u1", action: "member.updated", targetType: "member", targetId: "u2", details: { role: "admin" }, createdAt: Date.now() }], nextCursor: null, actors: {} } }));
  /* GET and PATCH /api/settings: the workspace's own rules, kept as the route keeps them. */
  const stored: Record<string, string> = { approvalRule: "cap", shotCapCredits: "50", capWarnPct: "80", atCap: "producer" };
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as Record<string, string>;
      writes.push({ url: "/api/settings", method: "PATCH", body });
      Object.assign(stored, body);
      return route.fulfill({ json: { settings: stored, changed: Object.keys(body) } });
    }
    return route.fulfill({ json: { settings: stored, defaults: { approvalRule: "anyone", shotCapCredits: "50", capWarnPct: "80", atCap: "producer" }, models: {}, platformModels: {} } });
  });
  /* GET /api/projects (a workspace billed in credits) and PATCH /api/projects/:id. */
  const caps: Record<string, number | null> = { pa: 200, pb: null };
  const unlocked: Record<string, boolean> = {};
  await page.route(/\/api\/projects(\/[a-z]+)?$/, async (route) => {
    const at = new URL(route.request().url()).pathname.split("/")[3];
    if (route.request().method() === "PATCH" && at) {
      const body = route.request().postDataJSON() as { capCredits?: number | null; capUnlocked?: boolean };
      writes.push({ url: `/api/projects/${at}`, method: "PATCH", body });
      if ("capCredits" in body) caps[at] = body.capCredits ?? null;
      if ("capUnlocked" in body) unlocked[at] = Boolean(body.capUnlocked);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { unit: "cr", projects: [
      { id: "pa", name: "Coastal light study", credits: 200, capCredits: caps.pa, capUnlocked: Boolean(unlocked.pa) },
      { id: "pb", name: "Studio reel", credits: 31, capCredits: caps.pb, capUnlocked: false },
    ] } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return { errors, writes };
}

/** Review screenshots, only when S09_SHOTS names a folder (never in CI). */
async function shot(page: Page, name: string) {
  const dir = process.env.S09_SHOTS;
  if (!dir) return;
  const size = page.viewportSize();
  await page.screenshot({ path: `${dir}/${name}-${size?.width}x${size?.height}.png`, fullPage: false });
}

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);
const compact = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768 || (page.viewportSize()?.height ?? 900) <= 500;

async function floors(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${where}: no horizontal page scroll`).toBe(true);
  expect(await smallText(page, ".gx-header, header"), `${where}: text under 12px`).toEqual([]);
  if (compact(page)) expect(await smallTargets(page, ".gs"), `${where}: targets under 44×44`).toEqual([]);
}

test("Team: people and invites on the team routes, a role changed in place, a one-time link, security read-only", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, writes } = await open(page, "/suites?view=workspace&tab=team");
  const view = page.getByTestId("settings-view");
  await expect(view).toBeVisible();
  await expect(page.getByTestId("settings-title")).toHaveText("Team");
  await expect(view.getByRole("group", { name: "Settings sections" }).getByRole("button")).toHaveText(["Team", "Plan & credits", "Spending rules", "Connections", "Advanced"]);
  await expect(page.getByTestId("settings-section-team")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("settings-people")).toContainText("2 on this workspace · 1 invited");
  await expect(page.getByTestId("settings-member")).toHaveCount(2);
  /* Limits are by role: no row names what one person may approve. */
  await expect(page.getByTestId("settings-people")).not.toContainText(/may approve/);
  await expect(page.getByTestId("settings-member").first()).toContainText("owner");
  await expect(page.getByTestId("settings-member").first().getByTestId("settings-change-role")).toHaveCount(0);
  await floors(page, "Team");
  await shot(page, "team");

  await page.getByTestId("settings-member").nth(1).getByTestId("settings-change-role").click();
  await page.getByTestId("settings-role-admin").click();
  await expect.poll(() => writes.find((w) => w.url === "/api/team/u2")?.body).toEqual({ role: "admin" });

  await page.getByTestId("settings-invite").click();
  await page.getByTestId("settings-invite-name").fill("Maya");
  await page.getByTestId("settings-invite-email").fill("m@example.test");
  await page.getByTestId("settings-invite-make").click();
  await expect(page.getByTestId("settings-invite-link")).toContainText("/invite/inv_new123");
  expect(writes.find((w) => w.url === "/api/team")?.body).toEqual({ name: "Maya", email: "m@example.test", role: "member" });

  await page.getByTestId("settings-invite-row").getByTestId("settings-invite-revoke").click();
  await expect.poll(() => writes.some((w) => w.url === "/api/team/invites/inv_old" && w.method === "DELETE")).toBe(true);

  /* Security opens read-only: two-step and the workspace rule change on their own pages. */
  await page.getByTestId("settings-security-toggle").click();
  await expect(page.getByTestId("settings-two-step")).toContainText("On");
  await expect(page.getByTestId("settings-two-step-change")).toHaveAttribute("href", "/account/security");
  await expect(page.getByTestId("settings-workspace-two-step")).toContainText("off");
  await expect(page.getByTestId("settings-sessions")).toContainText("2 sessions");
  await expect(page.getByTestId("settings-security")).not.toContainText(/password/i);
  await floors(page, "Team › Security");
  await page.getByTestId("settings-security").scrollIntoViewIfNeeded();
  await shot(page, "team-security");
  expect(errors).toEqual([]);
});

test("Plan & credits: the balance with its dollars, this month settled and held, Top up as today's request, the plan as billing holds it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, writes } = await open(page, "/suites?view=workspace&tab=credits");
  await expect(page.getByTestId("settings-title")).toHaveText("Plan & credits");
  const credits = page.getByTestId("settings-balance-credits");
  await expect(credits).toContainText(/1 credit = \$\d/);
  await expect(credits).toContainText(/[\d,]+ cr · \$[\d,]+\.\d\d/);
  await expect(page.getByTestId("settings-month")).toContainText("163 cr settled · 20 cr held");
  await expect(page.getByTestId("settings-plan")).toContainText("Studio · $49 a month");
  await expect(page.getByTestId("settings-plan-included")).toContainText("400 cr");
  await expect(page.getByTestId("settings-plan-renews")).toContainText("Renews");
  await expect(page.getByTestId("settings-change-plan")).toHaveAttribute("href", "/billing");
  /* No feature row the code has no flag for, no vendor figure, no sample-price footnote. */
  await expect(page.getByTestId("settings-view")).not.toContainText(/Review links, exports|samples from the rate card|BytePlus|vendor/i);
  await floors(page, "Plan & credits");
  await shot(page, "credits");

  const topUp = page.getByTestId("settings-top-up");
  await expect(topUp).toHaveText("Top up · 500 cr · $50");
  await topUp.click();
  await expect(page.getByTestId("settings-credits-note")).toContainText("nothing is charged here");
  expect(writes.filter((w) => w.url === "/api/workspaces/topups")).toEqual([{ url: "/api/workspaces/topups", method: "POST", body: { packId: "starter" } }]);

  /* The rest is one fold away. */
  await page.getByTestId("settings-fold-packs-toggle").click();
  await expect(page.getByTestId("settings-pack")).toHaveCount(2);
  await page.getByTestId("settings-fold-usage-toggle").click();
  await expect(page.getByTestId("settings-usage-row").first()).toContainText("Seedance 2.5");
  await expect(page.getByTestId("settings-usage-total")).toContainText("312 cr settled");
  await page.getByTestId("settings-fold-statements-toggle").click();
  await expect(page.getByTestId("settings-statement")).toHaveCount(1);
  await floors(page, "Plan & credits, folds open");
  await page.getByTestId("settings-fold-packs").scrollIntoViewIfNeeded();
  await shot(page, "credits-folds");
  expect(errors).toEqual([]);
});

test("old links land on their section; the design's ws= spelling and open= work; undrawn sections open today's page", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?view=workspace&tab=people");
  await expect(page.getByTestId("settings-title")).toHaveText("Team");
  expect([param(page, "view"), param(page, "tab")]).toEqual(["workspace", "team"]);
  await page.goto("/suites?view=workspace&tab=usage");
  await expect(page.getByTestId("settings-title")).toHaveText("Plan & credits");
  await expect(page.getByTestId("settings-fold-usage")).toHaveAttribute("data-open", "true");
  await page.goto("/suites?view=workspace&ws=team");
  await expect(page.getByTestId("settings-title")).toHaveText("Team");
  expect(param(page, "tab")).toBe("team");
  await page.goto("/suites?view=workspace&tab=security");
  await expect(page.getByTestId("settings-two-step")).toBeVisible();
  /* Atomik's Budget page is Spending rules now. */
  await page.goto("/suites?suite=atomik&page=budget");
  await expect(page.getByTestId("settings-title")).toHaveText("Spending rules");
  expect(param(page, "tab")).toBe("rules");
  /* Connections is not drawn in this build: the section opens Atomik's Tools & connections, as the avatar menu did. */
  await page.getByTestId("settings-section-connections").click();
  await expect(page.getByTestId("page-title")).toHaveText("Tools & connections");
  expect(errors).toEqual([]);
});

test("Spending rules: the rule, the platform line and Ask, read as the code has them; an admin changes them with Undo; an admin's cap per production", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, writes } = await open(page, "/suites?view=workspace&tab=rules");
  await expect(page.getByTestId("settings-title")).toHaveText("Spending rules");
  await expect(page.getByTestId("settings-approve")).toContainText("people only · Atomik never approves");
  await expect(page.getByTestId("settings-rule")).toContainText("Members up to 50 cr a shot; an admin above it.");
  await expect(page.getByTestId("settings-rule").locator(".gs-row-v")).toHaveText("50 cr");
  await expect(page.getByTestId("settings-platform-line")).toContainText("Any job over 200 cr needs a person’s approval, even under Auto.");
  await expect(page.getByTestId("settings-budget")).toContainText("Warn at 80% of a production’s cap · at the cap an admin unlocks it");
  /* Spend without asking is Ask, read-only: no Auto switch, no invented pause. */
  await expect(page.getByTestId("settings-auto")).toContainText("Every paid step waits for a person.");
  await expect(page.getByTestId("settings-auto")).toContainText("Auto is picked per Board run, for drafts at or under 200 cr.");
  await expect(page.getByTestId("settings-mode").locator(".gs-row-v")).toHaveText("Ask");
  await expect(page.getByTestId("settings-auto").getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("settings-view")).not.toContainText(/pause asks|Set Auto|may approve up to/);
  await expect(page.getByTestId("settings-view")).toContainText("Spending rules belong to people: Atomik prepares and explains, you decide.");
  await floors(page, "Spending rules");
  await shot(page, "rules");

  /* Change the rule: it saves itself, a toast offers Undo, and Undo writes the old values back. */
  await page.getByTestId("settings-rule-change").click();
  await page.getByTestId("settings-rule-producer").click();
  await expect.poll(() => writes.find((w) => w.url === "/api/settings")?.body).toEqual({ approvalRule: "producer" });
  await expect(page.getByTestId("settings-rule")).toContainText("A producer signs off on every take.");
  await shot(page, "rules-editing");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => writes.filter((w) => w.url === "/api/settings").at(-1)?.body).toEqual({ approvalRule: "cap", shotCapCredits: "50" });
  await expect(page.getByTestId("settings-rule")).toContainText("Members up to 50 cr a shot");
  await page.getByTestId("settings-shot-cap").fill("40");
  await page.getByTestId("settings-shot-cap-set").click();
  await expect.poll(() => writes.filter((w) => w.url === "/api/settings").at(-1)?.body).toEqual({ shotCapCredits: "40" });
  await expect(page.getByTestId("settings-rule")).toContainText("Members up to 40 cr a shot");

  await page.getByTestId("settings-budget-change").click();
  await page.getByTestId("settings-warn-90").click();
  await expect.poll(() => writes.filter((w) => w.url === "/api/settings").at(-1)?.body).toEqual({ capWarnPct: "90" });
  await page.getByTestId("settings-atcap-stop").click();
  await expect(page.getByTestId("settings-budget")).toContainText("Warn at 90% of a production’s cap · rendering stops at the cap");
  await floors(page, "Spending rules, editing");

  /* Each production's cap, on the route Atomik › Budget used: a number of credits, and Unlock at the cap. */
  await page.getByTestId("settings-fold-productions-toggle").click();
  await expect(page.getByTestId("settings-production")).toHaveCount(2);
  await expect(page.getByTestId("settings-production").first()).toContainText("200 of 200 cr");
  await page.getByTestId("settings-production-unlock").click();
  await expect.poll(() => writes.find((w) => w.url === "/api/projects/pa")?.body).toEqual({ capUnlocked: true });
  await page.getByTestId("settings-production").nth(1).getByTestId("settings-production-change").click();
  await page.getByTestId("settings-production-cap").fill("120");
  await page.getByTestId("settings-production-save").click();
  await expect.poll(() => writes.find((w) => w.url === "/api/projects/pb")?.body).toEqual({ capCredits: 120 });
  await expect(page.getByTestId("settings-production").nth(1)).toContainText("31 of 120 cr");
  await floors(page, "Spending rules, productions");
  await page.getByTestId("settings-fold-productions").scrollIntoViewIfNeeded();
  await shot(page, "rules-productions");
  expect(errors).toEqual([]);
});

test("a member reads Team, Plan & credits and Spending rules, and changes nothing", async ({ page, request }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, writes } = await open(page, "/suites?view=workspace&tab=rules", { member: request });
  await expect(page.getByTestId("settings-rule")).toContainText("Members up to 50 cr a shot");
  await expect(page.getByTestId("settings-rule-change")).toHaveCount(0);
  await expect(page.getByTestId("settings-budget-change")).toHaveCount(0);
  await expect(page.getByTestId("settings-rules-readonly")).toContainText("Only an admin changes these.");
  await page.getByTestId("settings-section-team").click();
  await expect(page.getByTestId("settings-people")).toContainText("The team is the owner’s and admins’ to manage.");
  await expect(page.getByTestId("settings-invite")).toHaveCount(0);
  await page.getByTestId("settings-section-credits").click();
  await expect(page.getByTestId("settings-top-up")).toHaveCount(0);
  await expect(page.getByTestId("settings-top-up-ask")).toContainText("Ask an admin");
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("the avatar menu opens the sections and opens itself once from settings=1", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?settings=1");
  const menu = page.getByRole("menu", { name: "Settings" });
  await expect(menu).toBeVisible();
  await expect.poll(() => param(page, "settings")).toBeNull();
  await expect(menu.getByRole("menuitem").first()).toHaveText("Team");
  await shot(page, "avatar-menu");
  await menu.getByRole("menuitem", { name: "Plan & credits" }).click();
  await expect(page.getByTestId("settings-title")).toHaveText("Plan & credits");
  await page.getByTestId("workspace-avatar").click();
  await menu.getByRole("menuitem", { name: "Team" }).click();
  await expect(page.getByTestId("settings-title")).toHaveText("Team");
  expect([param(page, "view"), param(page, "tab")]).toEqual(["workspace", "team"]);
  await expect(page.getByTestId("suite-mark")).toHaveText("SETTINGS");
  expect(errors).toEqual([]);
});

test("with the new interface off, Workspace's tabs are as they were", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?view=workspace&tab=people", { on: false });
  await expect(page.getByTestId("ws-people")).toBeVisible();
  await expect(page.getByTestId("settings-view")).toHaveCount(0);
  expect(errors).toEqual([]);
});
