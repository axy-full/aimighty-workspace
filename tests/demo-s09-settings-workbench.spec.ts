import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { signInWithNewInterface } from "./helpers/newInterface";
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
  if (opts.member) { await joinLocallyAsMember(opts.member, page.request); }
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
  /* GET, POST and DELETE /api/tokens (a workspace billed in credits); the secret comes back once, on POST. */
  const tokens = [{ id: "tk1", name: "Claude on my laptop", scope: "render", lastUsed: Date.now() - 7_200_000, createdAt: 1, spendThisMonth: 120, capCredits: 500 }, { id: "tk2", name: "Reader", scope: "read", lastUsed: null, createdAt: 2, spendThisMonth: 0 }];
  await page.route(/\/api\/tokens(\/[a-z0-9]+)?$/, async (route) => {
    const at = new URL(route.request().url()).pathname.split("/")[3];
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { name: string; scope: string; capCredits?: number };
      writes.push({ url: "/api/tokens", method: "POST", body });
      tokens.push({ id: "tk3", name: body.name, scope: body.scope, lastUsed: null as unknown as number, createdAt: 3, spendThisMonth: 0, ...(body.capCredits ? { capCredits: body.capCredits } : {}) } as (typeof tokens)[number]);
      return route.fulfill({ status: 201, json: { id: "tk3", name: body.name, token: "pk_secret_once_123" } });
    }
    if (route.request().method() === "DELETE" && at) {
      writes.push({ url: `/api/tokens/${at}`, method: "DELETE", body: null });
      tokens.splice(tokens.findIndex((t) => t.id === at), 1);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { unit: "cr", tokens } });
  });
  await page.route("**/api/workspaces/keys", (route) => route.fulfill({ json: { usesPlatformKeys: true, mode: "platform", managed: true, canPlatform: true, credits: null, keys: [
    { name: "byteplus", label: "BytePlus", does: "Seedance video", set: true, masked: null }, { name: "google", label: "Google", does: "Nano Banana stills", set: true, masked: null }, { name: "xai", label: "xAI", does: "Grok", set: true, masked: null }, { name: "elevenlabs", label: "ElevenLabs", does: "Voice", set: false, masked: null },
  ] } }));
  await page.route("**/api/crew/status", (route) => route.fulfill({ json: { connected: true, priced: true, model: "grok" } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: false, requiresReconnect: false, capacity: null } }));
  const rules = [{ id: "r1", text: "Keep shots under ten seconds", scope: "all", apply: "prompt", on: true, source: "workspace" }, { id: "p1", text: "No logos in frame", scope: "all", apply: "prompt", on: true, source: "platform" }];
  await page.route(/\/api\/rules(\/[a-z0-9]+)?$/, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { rules } });
    writes.push({ url: new URL(route.request().url()).pathname, method: route.request().method(), body: route.request().postDataJSON() });
    if (route.request().method() === "POST") rules.push({ id: "r2", text: (route.request().postDataJSON() as { text: string }).text, scope: "all", apply: "prompt", on: true, source: "workspace" });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() === "PATCH") { writes.push({ url: "/api/workspaces", method: "PATCH", body: route.request().postDataJSON() }); return route.fulfill({ json: { ok: true } }); }
    return route.fallback();
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
  await page.waitForTimeout(600); /* the page eases in */
  await page.screenshot({ path: `${dir}/${name}-${size?.width}x${size?.height}.png`, fullPage: false });
}

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);
const compact = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768 || (page.viewportSize()?.height ?? 900) <= 500;
/** The viewports where the shell mounts the phone app (lib/shell/use-compact.ts). Settings is a page under the phone header there, with no avatar menu. */
const COMPACT = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const isCompact = (info: { project: { name: string } }) => COMPACT.includes(info.project.name);

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

test("old links land on their section; the design's ws= spelling and open= work; Atomik's Budget, Models and Tools pages are sections", async ({ page }, info) => {
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
  /* Atomik's Tools & connections is Connections; Models and General's rest are Advanced. */
  await page.goto("/suites?suite=atomik&page=skills");
  await expect(page.getByTestId("settings-title")).toHaveText("Connections");
  await page.goto("/suites?suite=atomik&page=models");
  await expect(page.getByTestId("settings-title")).toHaveText("Advanced");
  await expect(page.getByTestId("settings-fold-models")).toHaveAttribute("data-open", "true");
  await page.goto("/suites?view=workspace&tab=engines");
  await expect(page.getByTestId("settings-fold-models")).toHaveAttribute("data-open", "true");
  await page.goto("/suites?view=workspace&tab=general");
  await expect(page.getByTestId("settings-fold-workspace")).toHaveAttribute("data-open", "true");
  await page.goto("/suites?view=workspace&ws=advanced&open=models");
  expect([param(page, "tab"), param(page, "open")]).toEqual(["advanced", "models"]);
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

test("Connections: tokens as the code has them, made and shown once, revoked in place; publishing accounts never connected", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, writes } = await open(page, "/suites?view=workspace&tab=connections");
  await expect(page.getByTestId("settings-title")).toHaveText("Connections");
  await expect(page.getByTestId("settings-tokens")).toContainText("Particl is an MCP server · tokens you control");
  const rows = page.getByTestId("settings-token");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Can generate · 120 cr of 500 cr this month · used 2h ago");
  await expect(rows.nth(1)).toContainText("Read-only · never used");
  /* Older tokens say what they do; a new one reads or prepares jobs a person approves (Gaps B, lane 5). */
  await expect(page.getByTestId("settings-publishing-row")).toHaveCount(3);
  await expect(page.getByTestId("settings-publishing")).toContainText("Not connected");
  await expect(page.getByTestId("settings-publishing").getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("settings-view")).not.toContainText(/maisonaurel|@maison/i);
  await floors(page, "Connections");
  await shot(page, "connections");

  await page.getByTestId("settings-token-make").click();
  await page.getByTestId("settings-token-name").fill("Studio assistant");
  await expect(page.getByTestId("settings-token-scope-prepare")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("settings-token-create").click();
  await expect(page.getByTestId("settings-token-secret")).toHaveText("pk_secret_once_123");
  expect(writes.find((w) => w.url === "/api/tokens")?.body).toEqual({ name: "Studio assistant", scope: "prepare" });
  await expect(page.getByTestId("settings-token")).toHaveCount(3);
  await page.getByTestId("settings-token-done").click();
  await floors(page, "Connections, fresh token");
  await shot(page, "connections-token");
  /* The secret fills the setup, which is one fold away. */
  await page.getByTestId("settings-fold-assistant-toggle").click();
  await expect(page.getByTestId("settings-setup-step").nth(1)).toContainText("PARTICL_TOKEN=pk_secret_once_123");
  await page.getByTestId("settings-client-mcp").click();
  await expect(page.getByTestId("settings-setup-step").nth(1)).toContainText("Bearer pk_secret_once_123");
  await page.getByTestId("settings-fold-mcp-toggle").click();
  await expect(page.getByTestId("settings-mcp-tool")).toHaveCount(8);
  await expect(page.getByTestId("settings-mcp-tool").filter({ hasText: "render_shot" })).toContainText("Can generate");
  await floors(page, "Connections, folds open");
  await page.getByTestId("settings-fold-mcp").scrollIntoViewIfNeeded();
  await shot(page, "connections-folds");

  /* Revoke asks in place; nothing is erased. */
  await page.getByTestId("settings-token").first().getByTestId("settings-token-revoke").click();
  await page.getByTestId("settings-token-keep").click();
  expect(writes.some((w) => w.method === "DELETE")).toBe(false);
  await page.getByTestId("settings-token").first().getByTestId("settings-token-revoke").click();
  await page.getByTestId("settings-token-revoke-confirm").click();
  await expect.poll(() => writes.find((w) => w.method === "DELETE")?.url).toBe("/api/tokens/tk1");
  await expect(page.getByTestId("settings-token")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("Advanced: Models, Tools and Workspace in folds, from the routes that serve them", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, writes } = await open(page, "/suites?view=workspace&tab=advanced&open=models");
  await expect(page.getByTestId("settings-title")).toHaveText("Advanced");
  await expect(page.getByTestId("settings-fold-models")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("settings-thinking")).toContainText("Claude, OpenAI and Grok · Auto starts here");
  await expect(page.getByTestId("settings-effort").locator(".gs-row-v")).toHaveText("Auto");
  await expect(page.getByTestId("settings-view")).not.toContainText(/\bDepth\b/);
  await expect(page.getByTestId("settings-engines").locator(".gs-row-v")).toHaveText("2 available");
  await expect(page.getByTestId("settings-fold-tools")).not.toHaveAttribute("data-open", "true");
  await floors(page, "Advanced");
  await shot(page, "advanced-models");
  await page.getByTestId("settings-enhancer-claude").click();
  await expect.poll(() => writes.find((w) => w.url === "/api/settings")?.body).toEqual({ promptEnhancer: "claude" });
  await page.getByTestId("settings-engines-show").click();
  await expect(page.getByTestId("settings-engine")).toHaveCount(3);
  await expect(page.getByTestId("engine-xai")).toBeVisible();
  await page.getByTestId("settings-thinking-change").click();
  /* Atomik's panel on a desktop (`atomik=1`); on a phone the sheet is its own screen (`screen=atomik`, components/graphite/phone/phone-model.ts). */
  await expect.poll(() => param(page, "atomik") === "1" || param(page, "screen") === "atomik" || param(page, "page") === "agent").toBe(true);
  await page.goto("/suites?view=workspace&tab=advanced");
  await expect(page.getByTestId("settings-fold-models")).not.toHaveAttribute("data-open", "true");
  await page.getByTestId("settings-fold-tools-toggle").click();
  await expect(page.getByTestId("settings-reach")).toHaveCount(6);
  await expect(page.getByTestId("settings-fold-tools")).toContainText("3D blocking");
  await expect(page.getByTestId("settings-fold-tools")).not.toContainText("Astra");
  await page.getByTestId("settings-reach-mcp-open").click();
  await expect(page.getByTestId("settings-title")).toHaveText("Connections");
  expect([param(page, "tab"), param(page, "open")]).toEqual(["connections", "mcp"]);
  await expect(page.getByTestId("settings-fold-mcp")).toHaveAttribute("data-open", "true");
  await page.goto("/suites?view=workspace&tab=general");
  await expect(page.getByTestId("settings-ws-name-field")).toBeVisible();
  await page.getByTestId("settings-ws-name-field").fill("Renamed studio");
  await page.getByTestId("settings-ws-name-save").click();
  await expect.poll(() => writes.find((w) => w.url === "/api/workspaces")?.body).toEqual({ name: "Renamed studio" });
  await page.getByTestId("settings-format-mov").click();
  await expect.poll(() => writes.filter((w) => w.url === "/api/settings").at(-1)?.body).toEqual({ editOutputFormat: "mov" });
  await expect(page.getByTestId("settings-rule-row")).toHaveCount(1);
  await page.getByTestId("settings-rule-text").fill("Always end on a held frame");
  await page.getByTestId("settings-rule-add").click();
  await expect.poll(() => writes.find((w) => w.url === "/api/rules")?.body).toEqual({ text: "Always end on a held frame", scope: "all", apply: "prompt" });
  await page.getByTestId("settings-rule-remove").first().click();
  await expect(page.getByTestId("settings-rule-remove").first()).toHaveText("Remove it");
  await expect(page.getByTestId("settings-export")).toBeVisible();
  await floors(page, "Advanced, Workspace");
  await page.getByTestId("settings-fold-workspace").scrollIntoViewIfNeeded();
  await shot(page, "advanced-workspace");
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
  test.skip(isCompact(info), "the phone has no avatar menu: its way to Settings is the credits in its header, and the sections are the page's own group: the twin 'phone: the credits open Settings…' below, and demo-s10-phone-workbench 'phone Home: a short balance offers Top up…'");
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


test("phone: the credits open Settings under the phone header, whose section group reaches every section, and Back goes Home", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(!isCompact(info), "desktop widths: 'the avatar menu opens the sections…' above");
  const { errors, writes } = await open(page, "/suites?view=home");
  await expect(page.getByTestId("phone-home")).toBeVisible({ timeout: 60_000 });
  /* No avatar menu on a phone; the balance in the header is the door (the same Top up request flow, Settings › Plan & credits). */
  await expect(page.getByTestId("workspace-avatar")).toHaveCount(0);
  await page.getByTestId("phone-credits").click();
  await expect(page.getByTestId("phone-title")).toHaveText("Settings");
  await expect(page.getByTestId("settings-title")).toHaveText("Plan & credits");
  expect([param(page, "view"), param(page, "tab")]).toEqual(["workspace", "credits"]);
  const group = page.getByRole("group", { name: "Settings sections" });
  await expect(group.getByRole("button")).toHaveText(["Team", "Plan & credits", "Spending rules", "Connections", "Advanced"]);
  for (const [label, tab] of [["Team", "team"], ["Spending rules", "rules"], ["Connections", "connections"], ["Advanced", "advanced"], ["Plan & credits", "credits"]] as const) {
    await group.getByRole("button", { name: label }).click();
    await expect(page.getByTestId("settings-title")).toHaveText(label);
    expect(param(page, "tab")).toBe(tab);
  }
  await floors(page, "Settings on a phone");
  await page.getByTestId("phone-back").click();
  await expect(page.getByTestId("phone-home")).toBeVisible();
  /* Reading and moving between sections wrote nothing. */
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
