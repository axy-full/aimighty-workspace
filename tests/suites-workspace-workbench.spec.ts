import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * FINAL_SPEC §5: Atomik › Skills lists the eight packs with Install; the
 * Workspace tabs are Graphite over the routes that already serve them —
 * General saves through /api/settings in the vocabulary the gate reads (and
 * renames through /api/workspaces), People reads /api/team and invites,
 * disables and revokes, Plans reads /api/billing, /api/statements and
 * /api/workspaces/topups, Usage draws bars from /api/usage, Engines lists
 * /api/workspaces/keys, the account connection and the xAI row, Security
 * reads /api/account/security and /api/workspaces/audit. The one page a tab
 * opens is a month's printable statement.
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
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.request().method() === "POST"
    ? route.fulfill({ json: { probe: { reachable: true, balance: 1234, unit: "credits" } } })
    : route.fulfill({ json: { connected: true, requiresReconnect: false } }));
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

test("Atomik › Skills lists the eight packs with Install", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?suite=atomik&page=skills&sp=skills");
  await expect(page.getByTestId("skills-view")).toBeVisible();
  await expect(page.getByTestId("skill-row")).toHaveCount(8);
  await expect(page.getByTestId("skill-row").first()).toContainText("higgsfield-generate");
  await expect(page.getByTestId("skill-row").first().getByRole("link", { name: "Install" })).toHaveAttribute("href", "https://github.com/higgsfield-ai/skills/tree/main/higgsfield-generate");
  expect(errors).toEqual([]);
});

test("Workspace tabs are Graphite over the real routes and speak their vocabulary; the one page they open is a month's statement", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, patches, writes } = await open(page, "/suites?view=workspace&tab=general");
  await expect(page.getByTestId("ws-general")).toBeVisible();
  /* The rule in force is shown: the stored "anyone" reads as "Members render freely", not the first option. */
  await expect(page.getByTestId("ws-approval")).toHaveValue("anyone");
  await expect(page.getByTestId("ws-approval").locator("option")).toHaveText(["Members render freely", "An admin presses past the per-shot cap", "A producer signs off on every take"]);
  /* A stored "webm" was always delivered as mp4; the container select says so and offers only what the reader knows. */
  await expect(page.getByTestId("ws-format")).toHaveValue("mp4");
  await expect(page.getByTestId("ws-format").locator("option")).toHaveText(["MP4", "MOV"]);
  await expect(page.getByTestId("ws-enhancer-higgsfield")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("ws-enhancer-claude").click();
  await page.getByTestId("ws-approval").selectOption("cap");
  await page.getByTestId("ws-cap-warn").selectOption("90");
  await page.getByTestId("ws-name").fill("Harbour Studio");
  await page.getByTestId("ws-save").click();
  await expect(page.getByTestId("ws-note")).toHaveText("Saved.");
  expect(patches).toEqual([{ promptEnhancer: "claude", approvalRule: "cap", capWarnPct: "90" }]);
  expect(writes).toEqual([{ url: "/api/workspaces", method: "PATCH", body: { name: "Harbour Studio" } }]);
  await expect(page.getByTestId("ws-export").getByRole("link")).toHaveCount(2);

  const tabs = page.getByRole("tablist", { name: "Workspace sections" });
  await tabs.getByRole("tab", { name: "People" }).click();
  await expect(page.getByTestId("ws-member")).toHaveCount(2);
  const member = page.getByTestId("ws-member").nth(1);
  await expect(member).toContainText("locked");
  await expect(member.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(member.getByRole("button", { name: "Promote" })).toBeVisible();
  /* The owner's own row carries no action that would be refused. */
  await expect(page.getByTestId("ws-member").first().getByRole("button")).toHaveCount(0);
  await member.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByTestId("ws-people-note")).toContainText("Jordan Lee is disabled; their work stays.");
  await page.getByTestId("ws-invite-revoke").click();
  await expect(page.getByTestId("ws-people-note")).toContainText("no longer works");
  expect(writes.slice(1)).toEqual([{ url: "/api/team/u2", method: "PATCH", body: { disabled: true } }, { url: "/api/team/invites/inv_old", method: "DELETE", body: null }]);
  await page.getByTestId("ws-invite-name").fill("Maya");
  await page.getByTestId("ws-invite-email").fill("m@example.test");
  await page.getByTestId("ws-invite").click();
  await expect(page.getByTestId("ws-invite-link")).toContainText("/invite/inv_abc123");

  await tabs.getByRole("tab", { name: "Plans & credits" }).click();
  await expect(page.getByTestId("workspace-balance")).toBeVisible();
  await expect(page.getByTestId("ws-plan-line")).toHaveText("Studio plan · active · renews Oct 1");
  /* Statement months are objects on the wire; each opens the printable statement, with its CSV beside it. */
  await expect(page.getByTestId("ws-statement")).toHaveText(["2026-09", "2026-08"]);
  await expect(page.getByTestId("ws-statement").first()).toHaveAttribute("href", "/statements/2026-09");
  /* The packs the request flow sells, priced; Request pack queues one for the platform. */
  await expect(page.getByTestId("ws-pack")).toHaveCount(2);
  await expect(page.getByTestId("ws-pack").nth(1)).toContainText("2,200 cr · $200 · 200 free");
  await page.getByTestId("ws-pack").nth(1).getByTestId("ws-pack-request").click();
  await expect(page.getByTestId("ws-plans-note")).toContainText("Requested.");
  expect(writes.at(-1)).toEqual({ url: "/api/workspaces/topups", method: "POST", body: { packId: "team" } });

  await tabs.getByRole("tab", { name: "Usage" }).click();
  await expect(page.getByTestId("ws-usage-bar")).toHaveCount(2);
  await expect(page.getByTestId("ws-usage-bar").first()).toContainText("Seedance 2.5");
  await expect(page.getByTestId("ws-usage")).toContainText("Settled spend · 312 cr");

  await tabs.getByRole("tab", { name: "Engines" }).click();
  await expect(page.getByTestId("ws-engine")).toHaveCount(2);
  await expect(page.getByTestId("ws-engine").first()).toContainText("connected");
  await expect(page.getByTestId("ws-engine").nth(1)).toContainText("platform key");
  await expect(page.getByTestId("ws-engines")).not.toContainText("Verify checks");
  /* The account every "Connect … in Workspace › Engines" points at is connected here. */
  await expect(page.getByTestId("engine-connected-account")).toContainText("Connected");
  await expect(page.getByTestId("connected-account-connect")).toHaveText("Reconnect");
  await expect(page.getByTestId("engine-xai")).toContainText("Connected · grok-4.6");
  await expect(page.getByTestId("engine-developer-api")).toContainText("Same grant as the connected account");
  await page.getByTestId("developer-api-verify").click();
  await expect(page.getByTestId("developer-api-result")).toHaveText("Reachable with this account's grant · balance 1,234 credits.");

  await tabs.getByRole("tab", { name: "Security" }).click();
  await expect(page.getByTestId("ws-security")).toContainText("2 signed in");
  await expect(page.getByTestId("ws-two-step")).toHaveText("On");
  await expect(page.getByTestId("ws-session")).toHaveText([/^This browser · since /, /^Safari on iPhone · since /]);
  await expect(page.getByTestId("ws-audit")).toContainText("Changed member access");
  /* Off the shell: the account's own security page (where a password is typed) and a month's printable statement. */
  await tabs.getByRole("tab", { name: "Plans & credits" }).click();
  await expect(page.getByTestId("ws-statement")).toHaveCount(2);
  const hrefs = await page.getByTestId("workspace-view").locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs.filter((h) => h && !h.startsWith("/api/") && !h.startsWith("http"))).toEqual(["/statements/2026-09", "/statements/2026-08"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Engines: the owner connects the account from here, and the sign-in's outcome is said on return", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "/suites?view=workspace&tab=engines&higgsfield=connected");
  await expect(page.getByTestId("connected-account-outcome")).toHaveText("Account connected.");
  /* The shell's own URL keeps only its params, so a reload does not repeat the outcome. */
  await expect.poll(() => new URL(page.url()).searchParams.get("higgsfield")).toBeNull();
  let authorize: string | null = null;
  await page.route("**/api/higgsfield/consumer/connect", (route) => route.fulfill({ json: { url: "https://clerk.higgsfield.ai/oauth/authorize?state=unit" } }));
  await page.route("https://clerk.higgsfield.ai/**", (route) => { authorize = route.request().url(); return route.fulfill({ contentType: "text/html", body: "<p>account sign-in</p>" }); });
  await page.getByTestId("connected-account-connect").click();
  await expect.poll(() => authorize).toBe("https://clerk.higgsfield.ai/oauth/authorize?state=unit");
  expect(errors).toEqual([]);
});

test("General › Prompt rules: the team's rules edit here, the platform's switch off; a removal takes a second press", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, ruleWrites } = await open(page, "/suites?view=workspace&tab=general");
  const card = page.getByTestId("ws-rules");
  await expect(card.getByTestId("ws-rule")).toHaveCount(1);
  await expect(card.getByRole("textbox", { name: "Rule", exact: true })).toHaveValue("Our brand never shows logos in the first frame.");
  /* The platform's rules are folded away; the count says they exist. */
  await expect(page.getByTestId("ws-rules-inherited")).toHaveText("Show 2 inherited");
  await page.getByTestId("ws-rules-inherited").click();
  const inherited = card.locator("[data-testid='ws-rule'][data-source='platform']");
  await expect(inherited).toHaveCount(2);
  await inherited.first().getByRole("switch").click();
  await expect(page.getByTestId("ws-rules-inherited")).toHaveText("Hide 2 inherited · 1 off");
  await expect(inherited.first().getByRole("switch")).toHaveAttribute("aria-checked", "false");

  await page.getByTestId("ws-rule-text").fill("Keep every take under ten seconds.");
  await page.getByTestId("ws-rule-add").click();
  await expect(card.locator("[data-testid='ws-rule'][data-source='workspace']")).toHaveCount(2);
  await expect(page.getByTestId("ws-rule-text")).toHaveValue("");

  const own = card.locator("[data-testid='ws-rule'][data-source='workspace']").first();
  await own.getByRole("combobox", { name: "Scope" }).selectOption("video");
  await expect(own.getByRole("combobox", { name: "Scope" })).toHaveValue("video");
  await own.getByTestId("ws-rule-remove").click();
  await expect(own.getByTestId("ws-rule-remove")).toHaveText("Remove it");
  expect(ruleWrites.filter((w) => w.method === "DELETE")).toEqual([]);
  await own.getByTestId("ws-rule-remove").click();
  await expect(card.locator("[data-testid='ws-rule'][data-source='workspace']")).toHaveCount(1);
  expect(ruleWrites).toEqual([
    { url: "/api/rules/pr_light", method: "PATCH", body: { on: false } },
    { url: "/api/rules", method: "POST", body: { text: "Keep every take under ten seconds.", scope: "all", apply: "prompt" } },
    { url: "/api/rules/rule_own", method: "PATCH", body: { scope: "video" } },
    { url: "/api/rules/rule_own", method: "DELETE", body: null },
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
