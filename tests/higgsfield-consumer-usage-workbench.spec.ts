import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
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
  await signInLocally(page.request);
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
/**
 * /usage with the Higgsfield sign-in off for Release 1 (lib/higgsfield-consumer/retired.ts › SIGN_IN_OFF):
 * no tab for the connected account's own credits, and its activity is never read. The workspace's own
 * views are unchanged.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];

test("/usage has no connected-account tab and never reads the connected account's activity", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const state = await fixture(page);
  await page.goto("/usage");
  await expect(page.locator('[aria-label="Usage views"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /connected-account/i })).toHaveCount(0);
  await expect(page.getByText(/connected credits|connected-account activity/i)).toHaveCount(0);
  expect(state.consumer).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.external).toEqual([]);
  expect(state.errors).toEqual([]);
});
