import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { joinLocallyAsMember } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";

/**
 * Settings › Connections, a token's monthly ceiling (owner, 20 Oct 2026, Q1 "B": "An admin sets a ceiling per token in credits per
 * month; … a token with no ceiling can only prepare and price"). An admin sets or clears the ceiling of their own and the other
 * members' tokens that can generate, in credits, blank for none, with Undo; makes a token that can generate with its ceiling; and a
 * member sees none of it. GET, POST /api/tokens and PATCH /api/tokens/:id/ceiling answer in their real shapes, mocked; nothing spends.
 * The five sizes of rule 7: no horizontal page scroll, no text under 12 px, 44 px targets on a phone.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-ceiling", productionProjectId: "prod-ceiling", shotMappings: {} });
const compact = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768 || (page.viewportSize()?.height ?? 900) <= 500;

async function floors(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${where}: no horizontal page scroll`).toBe(true);
  expect(await smallText(page, ".gx-header, header"), `${where}: text under 12px`).toEqual([]);
  if (compact(page)) expect(await smallTargets(page, ".gs"), `${where}: targets under 44×44`).toEqual([]);
}

type Token = { id: string; name: string; scope: string; lastUsed: number | null; createdAt: number; spendThisMonth: number; capCredits: number | null; legacyCeiling?: boolean; owner?: string };

async function open(page: Page, opts: { member?: APIRequestContext } = {}) {
  if (opts.member) await joinLocallyAsMember(opts.member, page.request);
  else await signInWithNewInterface(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  const writes: { url: string; method: string; body: unknown }[] = [];
  const tokens: Token[] = [
    { id: "tk1", name: "Claude on my laptop", scope: "render", lastUsed: Date.now() - 7_200_000, createdAt: 1, spendThisMonth: 0, capCredits: null },
    { id: "tk2", name: "Studio script", scope: "prepare", lastUsed: null, createdAt: 2, spendThisMonth: 0, capCredits: null },
  ];
  const others: Token[] = [{ id: "tk9", name: "Edit bay agent", scope: "render", lastUsed: null, createdAt: 3, spendThisMonth: 40, capCredits: null, legacyCeiling: false, owner: "Jordan Lee" }];
  await page.route(/\/api\/tokens(\/[a-z0-9]+(\/ceiling)?)?$/, async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const method = route.request().method();
    if (method === "PATCH" && parts[4] === "ceiling") {
      if (opts.member) return route.fulfill({ status: 403, json: { error: "Admins only" } });
      const body = route.request().postDataJSON() as { capCredits: number | null };
      writes.push({ url: `/api/tokens/${parts[3]}/ceiling`, method, body });
      const row = [...tokens, ...others].find((t) => t.id === parts[3]);
      if (row) row.capCredits = body.capCredits;
      return route.fulfill({ json: { id: parts[3], capCredits: body.capCredits } });
    }
    if (method === "POST" && parts.length === 3) {
      const body = route.request().postDataJSON() as { name: string; scope: string; capCredits?: number };
      writes.push({ url: "/api/tokens", method, body });
      tokens.push({ id: "tk3", name: body.name, scope: body.scope, lastUsed: null, createdAt: 4, spendThisMonth: 0, capCredits: body.capCredits ?? null });
      return route.fulfill({ status: 201, json: { id: "tk3", name: body.name, scope: body.scope, capCredits: body.capCredits ?? null, capUsd: null, token: "pk_secret_once_456" } });
    }
    if (method === "GET") return route.fulfill({ json: { unit: "cr", tokens, ...(opts.member ? {} : { others }) } });
    return route.fallback();
  });
  await page.route("**/api/prepared-jobs", (route) => route.fulfill({ json: { jobs: [] } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?view=workspace&tab=connections");
  await expect(page.getByTestId("settings-title")).toHaveText("Connections");
  return { errors, writes };
}

test("an admin sets and clears a token's monthly ceiling in credits, with Undo, for their own token and a member's", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, writes } = await open(page);
  const mine = page.getByTestId("settings-token").filter({ hasText: "Claude on my laptop" });
  await expect(mine).toContainText("Can generate · 0 cr this month · no ceiling · prepares and prices only");
  /* A prepare token spends nothing and takes no ceiling. */
  await expect(page.getByTestId("settings-token").filter({ hasText: "Studio script" }).getByTestId("settings-token-ceiling")).toHaveCount(0);
  await floors(page, "Connections, no ceiling");

  await mine.getByTestId("settings-token-ceiling").click();
  await expect(page.getByTestId("settings-token-ceiling-edit")).toContainText("Monthly ceiling (cr), empty for none");
  await page.getByTestId("settings-token-ceiling-field").fill("300");
  await floors(page, "Connections, ceiling field open");
  await page.getByTestId("settings-token-ceiling-save").click();
  await expect.poll(() => writes.at(-1)).toEqual({ url: "/api/tokens/tk1/ceiling", method: "PATCH", body: { capCredits: 300 } });
  await expect(mine).toContainText("0 cr of 300 cr this month");
  /* Undo puts the one before back: none. */
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => writes.at(-1)).toEqual({ url: "/api/tokens/tk1/ceiling", method: "PATCH", body: { capCredits: null } });
  await expect(mine).toContainText("no ceiling · prepares and prices only");
  /* A figure that is not whole credits is refused on the page, and nothing is sent. */
  await mine.getByTestId("settings-token-ceiling").click();
  await page.getByTestId("settings-token-ceiling-field").fill("2.5");
  const sent = writes.length;
  await page.getByTestId("settings-token-ceiling-save").click();
  await expect(page.getByTestId("settings-tokens-note")).toContainText("whole credits");
  expect(writes.length).toBe(sent);
  await mine.getByTestId("settings-token-ceiling").click();

  /* A member's token that can generate, listed to the admin to set its ceiling; revoking stays its maker's. */
  await expect(page.getByTestId("settings-tokens-others")).toBeVisible();
  const theirs = page.getByTestId("settings-token-other");
  await expect(theirs).toHaveCount(1);
  await expect(theirs).toContainText("Jordan Lee’s · Can generate · 40 cr this month · no ceiling");
  await expect(theirs.getByTestId("settings-token-revoke")).toHaveCount(0);
  await theirs.getByTestId("settings-token-ceiling").click();
  await page.getByTestId("settings-token-ceiling-field").fill("1,000");
  await page.getByTestId("settings-token-ceiling-save").click();
  await expect.poll(() => writes.at(-1)).toEqual({ url: "/api/tokens/tk9/ceiling", method: "PATCH", body: { capCredits: 1000 } });
  await expect(theirs).toContainText("40 cr of 1,000 cr this month");
  await floors(page, "Connections, member's token capped");
  expect(errors).toEqual([]);
});

test("an admin makes a token that can generate with its ceiling in credits; blank is none", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, writes } = await open(page);
  await page.getByTestId("settings-token-make").click();
  await page.getByTestId("settings-token-name").fill("Render bot");
  await page.getByTestId("settings-token-scope-render").click();
  await expect(page.getByTestId("settings-token-scope-render")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("settings-token-ceiling-new")).toHaveValue("500");
  await expect(page.getByTestId("settings-token-scope-note")).toContainText("up to this ceiling a month. Empty: it only prepares and prices.");
  await floors(page, "New token, can generate");
  await page.getByTestId("settings-token-ceiling-new").fill("250");
  await page.getByTestId("settings-token-create").click();
  await expect(page.getByTestId("settings-token-secret")).toHaveText("pk_secret_once_456");
  expect(writes.find((w) => w.url === "/api/tokens")?.body).toEqual({ name: "Render bot", scope: "render", capCredits: 250 });
  await expect(page.getByTestId("settings-token-fresh")).toContainText("Generates within its ceiling");
  await page.getByTestId("settings-token-done").click();
  await expect(page.getByTestId("settings-token").filter({ hasText: "Render bot" })).toContainText("0 cr of 250 cr this month");
  expect(errors).toEqual([]);
});

test("a member sees no ceiling field, no members' tokens and no way to make a token that can generate", async ({ page, request }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, writes } = await open(page, { member: request });
  await expect(page.getByTestId("settings-token").filter({ hasText: "Claude on my laptop" })).toContainText("no ceiling · prepares and prices only");
  await expect(page.getByTestId("settings-token-ceiling")).toHaveCount(0);
  await expect(page.getByTestId("settings-tokens-others")).toHaveCount(0);
  await page.getByTestId("settings-token-make").click();
  await expect(page.getByTestId("settings-token-scope-prepare")).toBeVisible();
  await expect(page.getByTestId("settings-token-scope-render")).toHaveCount(0);
  await expect(page.getByTestId("settings-token-ceiling-new")).toHaveCount(0);
  await floors(page, "Member, new token");
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
