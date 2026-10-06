import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { isCompact } from "./helpers/shellMode";

/**
 * Release 1: the old Workspace tabs (General, People, Plans & credits, Usage, Engines, Security) and Atomik's Tools & connections page are
 * Settings sections (lib/shell/settings.ts › OLD_TAB_TO_SECTION): Team (people, Security fold), Plan & credits (plan, packs, Usage and
 * Statements folds), Spending rules, Connections (tokens, MCP), Advanced (Models, Tools and Workspace folds). This spec keeps what it
 * checked, on the routes that still serve it, at the section that holds it now: Settings saves through /api/settings in the vocabulary
 * the gate reads and renames through /api/workspaces, Team reads /api/team and invites, disables and revokes, Plan & credits reads
 * /api/billing, /api/statements and /api/workspaces/topups, Usage reads /api/usage, Engines lists /api/workspaces/keys and the xAI row,
 * Security reads /api/account/security. The one page a section opens is a month's printable statement. The approval rule, the per-shot
 * cap and the warn/at-cap choices that General held are Spending rules now, and tests/demo-s09-settings-workbench.spec.ts holds them.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-tabs", productionProjectId: "prod-ws", shotMappings: {} });

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  const patches: Record<string, unknown>[] = [];
  const writes: { url: string; method: string; body: unknown }[] = [];
  /* Every mock below is the route's real response shape (the audit found mocks that had drifted from it). */
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PATCH") { patches.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, changed: Object.keys(route.request().postDataJSON()) } }); }
    /* A fresh workspace stores the default "anyone"; an older one may still hold a value the old select saved. */
    return route.fulfill({ json: { settings: { promptEnhancer: "higgsfield", approvalRule: "anyone", editOutputFormat: "webm" }, defaults: { promptEnhancer: "higgsfield", approvalRule: "anyone", shotCapCredits: "40", capWarnPct: "80", atCap: "producer", defaultVideoModel: "", defaultImageModel: "", editOutputFormat: "mp4" }, models: null } });
  });
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() === "PATCH") { writes.push({ url: "/api/workspaces", method: "PATCH", body: route.request().postDataJSON() }); return route.fulfill({ json: { ok: true, workspace: { id: "w", name: route.request().postDataJSON().name, slug: "w" } } }); }
    return route.fallback();
  });
  await page.route("**/api/team", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ json: { code: "inv_abc123", email: "m@example.test", name: "Maya", role: "member" } });
    return route.fulfill({ json: { mail: { configured: false, from: null }, canSeeRoles: true, users: [{ id: "u1", email: "owner@example.test", name: "Workspace Owner", role: "admin", standing: "owner", permanent: true, disabled: false, locked: false, lastSeen: Date.now(), createdAt: 1, clips: 12 }, { id: "u2", email: "j@example.test", name: "Jordan Lee", role: "member", standing: "member", permanent: false, disabled: false, locked: true, lastSeen: null, createdAt: 2, clips: 0 }], invites: [{ code: "inv_old", email: "r@example.test", name: "Riley", role: "member", createdAt: 1, expiresAt: Date.now() + 86_400_000, sentAt: null, sendCount: 0 }] } });
  });
  await page.route(/\/api\/team\/(u2|invites\/inv_old)$/, async (route) => {
    writes.push({ url: new URL(route.request().url()).pathname, method: route.request().method(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/billing", (route) => route.fulfill({ json: { canManage: true, plans: [{ id: "studio", label: "Studio" }], packs: [], subscription: { planId: "studio", status: "active", interval: "month", currentPeriodStart: Date.UTC(2026, 8, 1), currentPeriodEnd: Date.UTC(2026, 9, 1), cancelAtPeriodEnd: false }, credits: { balance: 1300 } } }));
  await page.route(/\/api\/statements$/, (route) => route.fulfill({ json: { months: [{ month: "2026-09", takes: 14 }, { month: "2026-08", takes: 3 }] } }));
  await page.route(/\/api\/workspaces\/topups(\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") { writes.push({ url: "/api/workspaces/topups", method: "POST", body: route.request().postDataJSON() }); return route.fulfill({ status: 201, json: { request: { id: "t1", label: "Team", credits: 2000, bonus: 200, usd: 200, status: "requested" }, checkout: { kind: "queued" } } }); }
    return route.fulfill({ json: { applies: true, provider: "manual", canRequest: true, openLimit: 3, creditUsd: 0.1, credits: null, packs: [{ id: "starter", label: "Starter", credits: 500, bonus: 0, total: 500, usd: 50, perCredit: 0.1 }, { id: "team", label: "Team", credits: 2000, bonus: 200, total: 2200, usd: 200, perCredit: 0.091 }], requests: [], history: [] } });
  });
  await page.route("**/api/usage", (route) => route.fulfill({ json: { unit: "credits", pending: 0, spentCredits: 312, promptSpendCredits: 0, credits: { granted: 1612, used: 312, balance: 1300 }, vendors: [{ id: "byteplus", label: "BytePlus" }], totalGenerations: 15, succeeded: 15, failed: 0, promptCount: 0, storage: null, timing: [], refines: [], byModel: [{ model: "seedance-2.5", label: "Seedance 2.5", provider: "byteplus", kind: "video", n: 6, credits: 240, spend: 240, promptSpend: 0 }, { model: "nano-banana-2", label: "Nano Banana 2", provider: "google", kind: "image", n: 9, credits: 72, spend: 72, promptSpend: 0 }], byProject: [], byPerson: [] } }));
  await page.route("**/api/workspaces/keys", (route) => route.fulfill({ json: { usesPlatformKeys: true, mode: "platform", canPlatform: true, keyring: true, allowance: null, credits: null, gatewayMinted: false, keys: [{ name: "ark", label: "Connected video account", does: "Seedance video · prompt writer", set: true, masked: "ark_••••1234" }, { name: "openai", label: "Connected language account", does: "Thinking models", set: false, masked: null }, { name: "xai", label: "xAI · Grok", does: "Crew", set: true, masked: "xai_••••" }] } }));
  await page.route("**/api/crew/status", (route) => route.fulfill({ json: { connected: true, priced: true, model: "grok-4.6" } }));
  /* No grant held and nothing running: the Higgsfield account's row has nothing to show. */
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 410, json: { code: "retired", error: "The connected account is no longer used. Past results stay in your Library." } })
    : route.fulfill({ json: { connected: false, requiresReconnect: false, capacity: { limit: 4, active: 0, mine: [] } } }));
  await page.route("**/api/account/security", (route) => route.fulfill({ json: { enabled: true, requiredWorkspaces: [], pendingRecoveryBatch: null, recoveryReplacementAuthorizedUntil: null, enabledAt: 1, recoveryCodesRemaining: 8, sessions: [{ id: "s1", current: true, label: "Chrome on macOS", createdAt: Date.now() - 86_400_000, expiresAt: Date.now() + 86_400_000 }, { id: "s2", current: false, label: "Safari on iPhone", createdAt: Date.now() - 3 * 86_400_000, expiresAt: Date.now() + 86_400_000 }] } }));
  await page.route(/\/api\/workspaces\/audit(\?.*)?$/, (route) => route.fulfill({ json: { events: [{ id: "e1", workspaceId: "w", actorId: "u1", action: "member.updated", targetType: "member", targetId: "u2", details: { role: "admin" }, createdAt: Date.now() }], nextCursor: null, actors: {} } }));
  /* GET/POST /api/rules and PATCH/DELETE /api/rules/[id] answer with the rules in force (lib/platformLayer.ts EffectiveRule). */
  const rules = [
    { id: "rule_own", text: "Our brand never shows logos in the first frame.", scope: "all", apply: "prompt", on: true, source: "workspace" },
    { id: "pr_light", text: "Name the light source.", scope: "video", apply: "writer", on: true, source: "platform" },
    { id: "pr_lens", text: "Name the lens.", scope: "all", apply: "writer", on: true, source: "platform" },
  ];
  const ruleWrites: { url: string; method: string; body: unknown }[] = [];
  await page.route(/\/api\/rules(\/[^/?]+)?$/, async (route) => {
    const request = route.request();
    const where = new URL(request.url()).pathname;
    if (request.method() === "GET") return route.fulfill({ json: { rules } });
    const body = request.postDataJSON() as Record<string, unknown> | null;
    ruleWrites.push({ url: where, method: request.method(), body });
    if (request.method() === "POST") {
      const rule = { id: `rule_${rules.length}`, text: String(body?.text), scope: String(body?.scope ?? "all"), apply: String(body?.apply ?? "prompt"), on: true, source: "workspace" };
      rules.push(rule);
      return route.fulfill({ json: { rule, rules } });
    }
    const at = rules.findIndex((r) => r.id === decodeURIComponent(where.split("/").pop() ?? ""));
    if (at < 0) return route.fulfill({ status: 404, json: { error: "No such rule here." } });
    if (request.method() === "DELETE") { rules.splice(at, 1); return route.fulfill({ json: { rules } }); }
    Object.assign(rules[at], body);
    return route.fulfill({ json: { rules } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return { errors, patches, writes, ruleWrites };
}

test("Connections lists the MCP tools and Advanced › Tools Particl's own reach, with no skill packs and no Higgsfield word", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?view=workspace&tab=connections&open=mcp");
  await expect(page.getByTestId("settings-title")).toHaveText("Connections");
  await expect(page.getByTestId("settings-mcp-tool")).toHaveCount(7);
  await expect(page.getByTestId("skill-packs")).toHaveCount(0);
  await expect(page.getByTestId("settings-view")).not.toContainText(/higgsfield/i);
  await page.goto("/suites?view=workspace&tab=advanced&open=tools");
  await expect(page.getByTestId("settings-reach")).toHaveCount(6);
  await expect(page.getByTestId("settings-view")).not.toContainText(/higgsfield/i);
  expect(errors).toEqual([]);
});

test("Settings are Graphite over the real routes and speak their vocabulary; the one page they open is a month's statement", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, patches, writes } = await open(page, "/suites?view=workspace&tab=general");
  /* General is Advanced › Workspace now. */
  await expect(page.getByTestId("settings-title")).toHaveText("Advanced");
  await expect(page.getByTestId("settings-fold-workspace")).toHaveAttribute("data-open", "true");
  /* A stored "webm" was always delivered as mp4; the container says so and offers only what the reader knows. */
  await expect(page.getByTestId("settings-format-mp4")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("settings-format").getByRole("radio")).toHaveText(["MP4", "MOV"]);
  /* The enhancer in force is shown (the Higgsfield writer), and changing it saves in the gate's vocabulary. */
  await page.getByTestId("settings-fold-models-toggle").click();
  await expect(page.getByTestId("settings-enhancer-higgsfield")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("settings-enhancer-claude").click();
  await expect.poll(() => patches).toEqual([{ promptEnhancer: "claude" }]);
  await page.getByTestId("settings-ws-name-field").fill("Harbour Studio");
  await page.getByTestId("settings-ws-name-save").click();
  await expect(page.getByTestId("settings-ws-note")).toHaveText("Renamed.");
  expect(writes).toEqual([{ url: "/api/workspaces", method: "PATCH", body: { name: "Harbour Studio" } }]);
  await expect(page.getByTestId("settings-export").getByRole("link")).toHaveCount(2);

  /* Team: people and invites. */
  await page.goto("/suites?view=workspace&tab=people");
  await expect(page.getByTestId("settings-title")).toHaveText("Team");
  await expect(page.getByTestId("settings-member")).toHaveCount(2);
  const member = page.getByTestId("settings-member").nth(1);
  await expect(member).toContainText("locked");
  await expect(member.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(member.getByTestId("settings-change-role")).toBeVisible();
  /* The owner's own row carries no action that would be refused. */
  await expect(page.getByTestId("settings-member").first().getByRole("button")).toHaveCount(0);
  const before = writes.length;
  await member.getByTestId("settings-member-disable").click();
  await expect(page.getByTestId("toast")).toContainText("Jordan Lee is disabled; their work stays.");
  await page.getByTestId("settings-invite-revoke").click();
  await expect(page.getByTestId("toast")).toContainText("no longer works");
  expect(writes.slice(before)).toEqual([{ url: "/api/team/u2", method: "PATCH", body: { disabled: true } }, { url: "/api/team/invites/inv_old", method: "DELETE", body: null }]);
  await page.getByTestId("settings-invite").click();
  await page.getByTestId("settings-invite-name").fill("Maya");
  await page.getByTestId("settings-invite-email").fill("m@example.test");
  await page.getByTestId("settings-invite-make").click();
  await expect(page.getByTestId("settings-invite-link")).toContainText("/invite/inv_abc123");

  /* Plan & credits: the plan as billing holds it, the packs the request flow sells (priced), and Request queues one for the platform. */
  await page.goto("/suites?view=workspace&tab=credits&open=packs");
  await expect(page.getByTestId("settings-plan")).toContainText("Studio");
  await expect(page.getByTestId("settings-plan-renews")).toContainText("1 Oct 2026");
  await expect(page.getByTestId("settings-pack")).toHaveCount(2);
  await expect(page.getByTestId("settings-pack").nth(1)).toContainText("2,200 cr");
  await expect(page.getByTestId("settings-pack").nth(1)).toContainText("$200");
  await page.getByTestId("settings-pack").nth(1).getByTestId("settings-pack-request").click();
  await expect(page.getByTestId("settings-credits-note")).toContainText("Requested.");
  expect(writes.at(-1)).toEqual({ url: "/api/workspaces/topups", method: "POST", body: { packId: "team" } });
  /* Statement months are objects on the wire; each opens the printable statement, with its CSV beside it. */
  await page.getByTestId("settings-fold-statements-toggle").click();
  await expect(page.getByTestId("settings-statement")).toHaveCount(2);
  await expect(page.getByTestId("settings-statement").first()).toContainText("2026-09");
  await expect(page.getByTestId("settings-statement").first().getByRole("link", { name: "Open" })).toHaveAttribute("href", "/statements/2026-09");

  /* Usage. */
  await page.getByTestId("settings-fold-usage-toggle").click();
  await expect(page.getByTestId("settings-usage-row")).toHaveCount(2);
  await expect(page.getByTestId("settings-usage-row").first()).toContainText("Seedance 2.5");
  await expect(page.getByTestId("settings-usage-total")).toContainText("312 cr settled");

  /* Engines (Advanced › Models). */
  await page.goto("/suites?view=workspace&tab=engines");
  await page.getByTestId("settings-engines-show").click();
  await expect(page.getByTestId("settings-engine")).toHaveCount(2);
  await expect(page.getByTestId("settings-engine").first()).toContainText("Available");
  await expect(page.getByTestId("settings-engine").nth(1)).toContainText("Unavailable");
  await expect(page.getByTestId("settings-engines")).not.toContainText("Verify checks");
  /* The Higgsfield sign-in is retired: no grant held and nothing running, so no account row, and no developer-API check. */
  await expect(page.getByTestId("engine-xai")).toContainText("Connected · grok-4.6");
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  await expect(page.getByTestId("connected-account-connect")).toHaveCount(0);
  await expect(page.getByTestId("engine-developer-api")).toHaveCount(0);

  /* Security (Team). */
  await page.goto("/suites?view=workspace&tab=security");
  await expect(page.getByTestId("settings-two-step")).toContainText("On");
  await expect(page.getByTestId("settings-sessions")).toContainText("2 sessions");
  await expect(page.getByTestId("settings-sessions")).toContainText("Safari on iPhone");
  await expect(page.getByTestId("settings-audit")).toContainText("Changed member access");
  /* Off the shell: the account's own security page (where a password is typed) and a month's printable statement. */
  await page.goto("/suites?view=workspace&tab=credits&open=statements");
  const hrefs = await page.getByTestId("settings-view").locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs.filter((h) => h && h.startsWith("/statements/") && !h.includes("csv"))).toEqual(["/statements/2026-09", "/statements/2026-08"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Engines: nothing connects the Higgsfield account, and an old sign-in return link shows no row and no message", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  let asked = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/higgsfield/consumer/") || request.url().startsWith("https://clerk.higgsfield.ai")) asked++; });
  await page.route("https://clerk.higgsfield.ai/**", (route) => route.abort());
  const { errors } = await open(page, "/suites?view=workspace&tab=engines&higgsfield=retired");
  await expect(page.getByTestId("settings-engines")).toBeVisible();
  /* The shell's own URL keeps only its params, so a reload does not repeat it. */
  await expect.poll(() => new URL(page.url()).searchParams.get("higgsfield")).toBeNull();
  await page.getByTestId("settings-engines-show").click();
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  await expect(page.getByTestId("connected-account-connect")).toHaveCount(0);
  await expect(page.getByTestId("engine-developer-api")).toHaveCount(0);
  expect(asked).toBe(0);
  expect(errors).toEqual([]);
});

test("Prompt rules: the team's rules edit here, the platform's switch off; a removal takes a second press", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, ruleWrites } = await open(page, "/suites?view=workspace&tab=general");
  const card = page.getByTestId("settings-prompt-rules");
  await expect(card.getByTestId("settings-rule-row")).toHaveCount(1);
  await expect(card.getByRole("textbox", { name: "Rule", exact: true })).toHaveValue("Our brand never shows logos in the first frame.");
  /* The platform's rules are folded away; the count says they exist. */
  await expect(page.getByTestId("settings-rules-inherited")).toHaveText("Show 2 inherited");
  await page.getByTestId("settings-rules-inherited").click();
  const inherited = card.locator("[data-testid='settings-rule-row'][data-source='platform']");
  await expect(inherited).toHaveCount(2);
  await inherited.first().getByRole("switch").click();
  await expect(page.getByTestId("settings-rules-inherited")).toHaveText("Hide 2 inherited · 1 off");
  await expect(inherited.first().getByRole("switch")).toHaveAttribute("aria-checked", "false");

  await page.getByTestId("settings-rule-text").fill("Keep every take under ten seconds.");
  await page.getByTestId("settings-rule-add").click();
  await expect(card.locator("[data-testid='settings-rule-row'][data-source='workspace']")).toHaveCount(2);
  await expect(page.getByTestId("settings-rule-text")).toHaveValue("");

  const own = card.locator("[data-testid='settings-rule-row'][data-source='workspace']").first();
  await own.getByRole("combobox", { name: "Scope" }).selectOption("video");
  await expect(own.getByRole("combobox", { name: "Scope" })).toHaveValue("video");
  await own.getByTestId("settings-rule-remove").click();
  await expect(own.getByTestId("settings-rule-remove")).toHaveText("Remove it");
  expect(ruleWrites.filter((w) => w.method === "DELETE")).toEqual([]);
  await own.getByTestId("settings-rule-remove").click();
  await expect(card.locator("[data-testid='settings-rule-row'][data-source='workspace']")).toHaveCount(1);
  expect(ruleWrites).toEqual([
    { url: "/api/rules/pr_light", method: "PATCH", body: { on: false } },
    { url: "/api/rules", method: "POST", body: { text: "Keep every take under ten seconds.", scope: "all", apply: "prompt" } },
    { url: "/api/rules/rule_own", method: "PATCH", body: { scope: "video" } },
    { url: "/api/rules/rule_own", method: "DELETE", body: null },
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("a rename holds across sections and reaches the header; Engines has no connected-account row to disconnect", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  /* /api/me answers with the workspace's name as the platform now has it: the old one until the rename lands. */
  let saved: string | null = null;
  await page.route("**/api/me", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (saved && json.workspace) json.workspace.name = saved;
    return route.fulfill({ response, json });
  });
  const { errors, writes } = await open(page, "/suites?view=workspace&tab=general");
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    saved = route.request().postDataJSON().name;
    writes.push({ url: "/api/workspaces", method: "PATCH", body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true, workspace: { id: "w", name: saved, slug: "w" } } });
  });
  await expect(page.getByTestId("settings-ws-name-field")).toBeVisible();
  await page.getByTestId("settings-ws-name-field").fill("Harbour Studio");
  await page.getByTestId("settings-ws-name-save").click();
  await expect(page.getByTestId("settings-ws-note")).toHaveText("Renamed.");
  expect(writes).toEqual([{ url: "/api/workspaces", method: "PATCH", body: { name: "Harbour Studio" } }]);
  /* The header reads /api/me again at once, not on its 30s poll (a phone has no header avatar: its Settings page is under the phone header). */
  if (!isCompact(info)) await expect(page.getByTestId("workspace-avatar")).toHaveAttribute("aria-label", "Workspace and account: Harbour Studio");
  /* Moving between sections in the app (a reload reads the server's own name, and the rename here is answered by a stand-in). */
  await page.getByTestId("settings-section-team").click();
  await expect(page.getByTestId("settings-title")).toHaveText("Team");
  await page.getByTestId("settings-section-advanced").click();
  await page.getByTestId("settings-fold-workspace-toggle").click();
  await expect(page.getByTestId("settings-ws-name-field")).toHaveValue("Harbour Studio");
  await expect(page.getByTestId("settings-ws-name-save")).toBeDisabled();

  /* Even with a grant the connection route (mocked) would say is held, Engines has no connected-account row and asks nothing. */
  const posts: unknown[] = [];
  await page.route("**/api/higgsfield/consumer/connection", (route) => {
    posts.push(route.request().method());
    return route.fulfill({ json: { connected: true, requiresReconnect: false, capacity: { limit: 4, active: 0, mine: [] } } });
  });
  await page.goto("/suites?view=workspace&tab=engines");
  await expect(page.getByTestId("settings-engines")).toBeVisible();
  await page.getByTestId("settings-engines-show").click();
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  await expect(page.getByTestId("connected-account-disconnect")).toHaveCount(0);
  await expect(page.getByTestId("engine-developer-api")).toHaveCount(0);
  expect(posts).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

/* A route handler still reading a real response when a test ends would throw "Response has been disposed". */
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });
