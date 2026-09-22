import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * FINAL_SPEC §5: Atomik › Skills lists the eight packs with Install; the six
 * Workspace tabs are Graphite over the routes that already serve them —
 * General saves through /api/settings (with the enhancer selector), People
 * reads /api/team and invites, Plans reads /api/billing, Usage draws bars
 * from /api/usage, Engines lists /api/workspaces/keys plus the xAI row,
 * Security reads /api/account/security. No tab links out to a legacy page.
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
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PATCH") { patches.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, changed: Object.keys(route.request().postDataJSON()) } }); }
    return route.fulfill({ json: { settings: { promptEnhancer: "higgsfield", approvalRule: "always", editOutputFormat: "mp4" }, defaults: { promptEnhancer: "higgsfield", approvalRule: "always", shotCapCredits: "40", editOutputFormat: "mp4" }, models: null } });
  });
  await page.route("**/api/team", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ json: { code: "inv_abc123", email: "m@example.test", name: "Maya", role: "member" } });
    return route.fulfill({ json: { canSeeRoles: true, users: [{ id: "u1", email: "a@example.test", name: "Akshay Panchal", role: "admin", standing: "owner", permanent: true, disabled: false, locked: false, lastSeen: Date.now(), clips: 12 }, { id: "u2", email: "j@example.test", name: "Jordan Lee", role: "member", standing: "member", disabled: false, locked: true, lastSeen: null, clips: 0 }], invites: [] } });
  });
  await page.route("**/api/billing", (route) => route.fulfill({ json: { canManage: true, plans: [{ id: "studio", label: "Studio" }], packs: [{ id: "starter", label: "Starter", credits: 500, bonus: 0, total: 500, usd: 50 }, { id: "team", label: "Team", credits: 2000, bonus: 200, total: 2200, usd: 200 }], subscription: { plan: "studio", status: "active" }, credits: { balance: 1300 } } }));
  await page.route("**/api/statements", (route) => route.fulfill({ json: { months: ["2026-09", "2026-08"] } }));
  await page.route("**/api/usage", (route) => route.fulfill({ json: { unit: "credits", spentCredits: 312, models: [{ model: "seedance-2.5", engine: "byteplus", kind: "video", n: 6, credits: 240 }, { model: "nano-banana-2", engine: "google", kind: "image", n: 9, credits: 72 }] } }));
  await page.route("**/api/workspaces/keys", (route) => route.fulfill({ json: { keys: [{ name: "ark", label: "Connected video account", does: "Seedance video · prompt writer", set: true, masked: "ark_••••1234" }, { name: "openai", label: "Connected language account", does: "Thinking models", set: false, masked: null }, { name: "xai", label: "xAI · Grok", does: "Crew", set: true, masked: "xai_••••" }] } }));
  await page.route("**/api/crew/status", (route) => route.fulfill({ json: { connected: true, priced: true, model: "grok-4.6" } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.request().method() === "POST"
    ? route.fulfill({ json: { probe: { reachable: true, balance: 1234, unit: "credits" } } })
    : route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  await page.route("**/api/account/security", (route) => route.fulfill({ json: { sessions: [{ id: "s1", current: true, lastSeen: Date.now(), agent: "Chrome" }], mfa: { enabled: false, required: false } } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return { errors, patches };
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

test("Workspace tabs are Graphite over the real routes; General saves the enhancer; nothing links to a legacy page", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, patches } = await open(page, "/suites?view=workspace&tab=general");
  await expect(page.getByTestId("ws-general")).toBeVisible();
  await expect(page.getByTestId("ws-enhancer-higgsfield")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("ws-enhancer-claude").click();
  await page.getByTestId("ws-approval").selectOption("cap");
  await page.getByTestId("ws-save").click();
  await expect(page.getByTestId("ws-note")).toHaveText("Saved.");
  expect(patches).toEqual([{ promptEnhancer: "claude", approvalRule: "cap" }]);

  const tabs = page.getByRole("tablist", { name: "Workspace sections" });
  await tabs.getByRole("tab", { name: "People" }).click();
  await expect(page.getByTestId("ws-member")).toHaveCount(2);
  await expect(page.getByTestId("ws-member").nth(1)).toContainText("locked");
  await expect(page.getByTestId("ws-member").nth(1).getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(page.getByTestId("ws-member").nth(1).getByRole("button", { name: "Promote" })).toBeVisible();
  await page.getByTestId("ws-invite-name").fill("Maya");
  await page.getByTestId("ws-invite-email").fill("m@example.test");
  await page.getByTestId("ws-invite").click();
  await expect(page.getByTestId("ws-invite-link")).toContainText("/invite/inv_abc123");

  await tabs.getByRole("tab", { name: "Plans & credits" }).click();
  await expect(page.getByTestId("workspace-balance")).toBeVisible();
  /* No pack list: there is no purchase route behind one, so it is not shown. */
  await expect(page.getByTestId("ws-pack")).toHaveCount(0);
  await expect(page.getByTestId("ws-plans")).not.toContainText("$200");
  await expect(page.getByTestId("ws-plans")).toContainText("Studio plan · active");

  await tabs.getByRole("tab", { name: "Usage" }).click();
  await expect(page.getByTestId("ws-usage-bar")).toHaveCount(2);
  await expect(page.getByTestId("ws-usage-bar").first()).toContainText("seedance-2.5");
  await expect(page.getByTestId("ws-usage")).toContainText("312 cr");

  await tabs.getByRole("tab", { name: "Engines" }).click();
  await expect(page.getByTestId("ws-engine")).toHaveCount(2);
  await expect(page.getByTestId("engine-xai")).toContainText("Connected · grok-4.6");
  /* The developer API: one free read with the account's grant, the answer said plainly. */
  await expect(page.getByTestId("engine-developer-api")).toContainText("Same grant as the connected account");
  await page.getByTestId("developer-api-verify").click();
  await expect(page.getByTestId("developer-api-result")).toContainText("Reachable with this account's grant · balance 1,234 credits");

  await tabs.getByRole("tab", { name: "Security" }).click();
  await expect(page.getByTestId("ws-security")).toContainText("1 signed in");
  await expect(page.getByTestId("ws-security")).toContainText("Two-step sign-in");
  /* The only href off the shell is the account's own security page, where a password is typed. */
  const hrefs = await page.getByTestId("workspace-view").locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs.filter((h) => h && !h.startsWith("/api/") && !h.startsWith("http"))).toEqual(["/account/security"]);
  expect(errors).toEqual([]);
});
