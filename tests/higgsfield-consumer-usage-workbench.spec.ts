import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { workbenchScopeFor } from "../lib/workbench/request-scope";

const usage = {
  purchasedUsd: 50, spentUsd: 12.34, spentCredits: 123, remainingUsd: 37.66,
  totalGenerations: 8, succeeded: 6, failed: 1, pending: 1, totalTokens: 0,
  avgCostUsd: 2.056, promptSpendUsd: 0, promptCount: 0,
  vendors: [], storage: null, byProject: [], byPerson: [], timing: [], refines: [], byMonth: [], recent: [],
};
const group = (completed = [0, 0], pending = [0, 0], uncertain = [0, 0], failed = [0, 0]) => ({
  completed: { jobs: completed[0], quoteCredits: completed[1] },
  pending: { jobs: pending[0], quoteCredits: pending[1] },
  uncertain: { jobs: uncertain[0], quoteCredits: uncertain[1] },
  failed: { jobs: failed[0], quoteCredits: failed[1] },
});
const activity = {
  creditUnit: "higgsfield_credits", basis: "approved_quotes", scope: "own_account",
  totals: group([2, 150], [1, 75], [3, 225], [4, 300]),
  projects: [
    { draftId: "bottle-campaign", name: "Bottle campaign", available: true, totals: group([2, 150], [1, 75], [2, 150]) },
    { draftId: "deleted-campaign", name: null, available: false, totals: group([0, 0], [0, 0], [1, 75], [4, 300]) },
  ],
  projectLimit: 100, projectsTruncated: false,
};

async function fixture(page: Page, options: { initialError?: boolean; truncated?: boolean } = {}) {
  const { workspace } = await signInLocally(page.request);
  // Only this newly-created local fixture workspace changes unit. No keys are read or configured.
  const db = createClient({ url: localPlatformDbUrl(), timeout: 2_000 });
  try { await db.execute({ sql: "UPDATE workspaces SET uses_platform_keys = 0 WHERE id = ?", args: [workspace.id] }); }
  finally { db.close(); }
  const me = await page.request.get("/api/me").then(response => response.json());
  const scope = workbenchScopeFor(me.workspace.id, me.id);
  const consumer: { path: string; method: string; scope: string | undefined }[] = [];
  const unexpected: string[] = [], external: string[] = [], errors: string[] = [];
  let error = !!options.initialError, activityReads = 0;
  let release: (() => void) | undefined, gate: Promise<void> | undefined;
  page.on("pageerror", reason => errors.push(reason.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return route.continue();
    external.push(url.href); return route.abort("blockedbyclient");
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path.startsWith("/api/higgsfield/consumer/")) {
      const call = { path, method: request.method(), scope: request.headers()["x-workbench-scope"] };
      consumer.push(call); expect(call.scope).toBe(scope);
      if (path === "/api/higgsfield/consumer/activity" && request.method() === "GET") {
        activityReads++; await gate;
        return error ? json({ error: "Saved the connected account activity is temporarily unavailable." }, 503)
          : json({ ...activity, projectsTruncated: !!options.truncated });
      }
      unexpected.push(`${request.method()} ${path}`);
      return json({ error: "No provider operations permitted in this fixture." }, 409);
    }
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return json({ error: "No mutations permitted." }, 409); }
    if (path === "/api/me") return json(me);
    if (path === "/api/usage") return json(usage);
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/engines") return json({ engines: [], models: [] });
    if (path === "/api/settings") return json({ settings: {}, defaults: {} });
    return json({});
  });
  return {
    consumer, unexpected, external, errors,
    get activityReads() { return activityReads; },
    setError(value: boolean) { error = value; },
    hold() { gate = new Promise<void>(resolve => { release = resolve; }); },
    release() { release?.(); },
  };
}
const activityTab = (page: Page) => page.getByRole("button", { name: "My connected-account activity", exact: true });
const activityPanel = (page: Page) => page.getByRole("region", { name: "My connected-account activity", exact: true });
const standardSpend = (page: Page) => page.locator(".management-stat").filter({ hasText: "Recorded spend · all time" });

test("The connected account quote commitments load only on demand and stay separate from dollar usage", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/usage");
  await expect(standardSpend(page)).toContainText("$12.34");
  await expect(activityTab(page)).toBeVisible();
  expect(state.consumer).toEqual([]);
  await activityTab(page).click();
  const panel = activityPanel(page);
  await expect(panel.getByText("Approved quote commitments for your own account in this workspace.", { exact: true })).toBeVisible();
  for (const [label, credits, jobs] of [["Completed", 150, 2], ["Pending", 75, 1], ["Uncertain", 225, 3], ["Failed", 300, 4]] as const) {
    const stat = panel.locator(".management-stat").filter({ has: page.getByText(label, { exact: true }) });
    await expect(stat).toContainText(`${credits} connected credits`);
    await expect(stat).toContainText(`${jobs} jobs`);
  }
  await expect(panel).toContainText(/not an invoice|not a provider invoice/i);
  await expect(panel).toContainText(/live balance/i);
  await expect(panel.getByText("Bottle campaign", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Bottle campaign", exact: true })).toHaveAttribute("href", "/workbench?project=bottle-campaign&suite=moleculr&page=marketing#variants");
  await expect(panel.getByText("Deleted or unavailable project", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: /deleted/i })).toHaveCount(0);
  await expect(standardSpend(page)).toHaveCount(0);
  // Next development Strict Mode may replay a mount's read-only effect.
  const mountedReads = state.activityReads;
  expect(mountedReads).toBeGreaterThanOrEqual(1);
  expect(mountedReads).toBeLessThanOrEqual(2);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("higgsfield-consumer-activity.png") });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity ledger", exact: true })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(standardSpend(page)).toContainText("$12.34");
  expect(state.activityReads).toBe(mountedReads);
  expect(state.consumer.every(call => call.method === "GET" && call.path === "/api/higgsfield/consumer/activity")).toBe(true);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("activity errors need an explicit retry and never trigger provider discovery or generation", async ({ page }) => {
  const state = await fixture(page, { initialError: true });
  await page.goto("/usage");
  await activityTab(page).click();
  await expect(activityPanel(page).getByRole("alert")).toContainText("Saved the connected account activity is temporarily unavailable.");
  const failedReads = state.activityReads;
  expect(failedReads).toBeGreaterThanOrEqual(1);
  expect(failedReads).toBeLessThanOrEqual(2);
  state.setError(false);
  await page.getByRole("button", { name: "Retry activity", exact: true }).click();
  await expect(activityPanel(page).getByText("Bottle campaign", { exact: true })).toBeVisible();
  expect(state.activityReads).toBe(failedReads + 1);
  await expect(activityPanel(page).getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(standardSpend(page)).toContainText("$12.34");
  expect(state.consumer.every(call => call.method === "GET" && call.path === "/api/higgsfield/consumer/activity")).toBe(true);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("leaving activity ignores an in-flight response and reopens with a new scoped read", async ({ page }) => {
  const state = await fixture(page, { truncated: true });
  state.hold();
  await page.goto("/usage");
  await activityTab(page).click();
  await expect.poll(() => state.activityReads).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  state.release();
  await expect(page.getByRole("heading", { name: "Activity ledger", exact: true })).toBeVisible();
  await expect(activityPanel(page)).toHaveCount(0);
  const previousReads = state.activityReads;
  await activityTab(page).click();
  await expect(activityPanel(page).getByText("Bottle campaign", { exact: true })).toBeVisible();
  await expect(activityPanel(page)).toContainText(/100/);
  expect(state.activityReads).toBeGreaterThan(previousReads);
  expect(state.activityReads).toBeLessThanOrEqual(previousReads + 2);
  expect(state.consumer.every(call => call.method === "GET" && call.path === "/api/higgsfield/consumer/activity")).toBe(true);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});
