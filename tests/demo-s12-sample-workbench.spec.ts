import { test, expect } from "@playwright/test";
import { seedFinishedProduction, watchPaidRequests, PRICES } from "./helpers/s12-sample";

/*
 * The sample production, end to end on the local ENGINE_MOCK server (lead decisions 38 and 41): the signed-in person owns
 * the workspace, so they mark their own finished production as the explore-only sample; their copy opens as a draft;
 * the board's data is the ledger's recorded prices, the owner's cast wording and his cut; nothing is generated, charged
 * or sent. At every viewport the sample's copy opens without a console error or sideways scroll, and no paid request
 * leaves the page. Undoing hides the mark and keeps every row.
 */
const overflow = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("mark, read, open and undo; the copy opens on every viewport without a console error, sideways scroll or paid request", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|favicon|net::ERR/i.test(message.text())) problems.push(message.text()); });
  const paid = watchPaidRequests(page);
  const made = await seedFinishedProduction(page);
  const call = (data: Record<string, unknown>) => page.request.post("/api/demo/sample", { headers: made.headers, data });

  /* Before the mark there is no sample, and opening has nothing to open. */
  expect(await (await page.request.get("/api/demo/sample")).json()).toEqual({ board: null });
  expect((await call({ action: "open" })).status()).toBe(404);
  /* The wrong workspace scope is refused before anything is read. */
  expect((await page.request.post("/api/demo/sample", { headers: { "X-Workbench-Scope": "particl-active-other-account" }, data: { action: "mark", draftId: made.project.id } })).status()).toBe(409);

  const marked = await call({ action: "mark", draftId: made.project.id });
  expect(marked.status(), await marked.text()).toBe(200);
  expect((await marked.json()).sample).toMatchObject({ projectId: made.productionId, name: "Fixture film" });

  const { board } = await (await page.request.get("/api/demo/sample")).json();
  expect(board.line).toBe("Sample production · nothing here spends credits");
  expect(board.plan.steps.map((s: { title: string; credits: number }) => [s.title, s.credits])).toEqual([["Shot 1", PRICES[0]], ["Shot 2", PRICES[1]], ["Shot 3", PRICES[2]]]);
  expect(board.plan.steps.reduce((n: number, s: { credits: number }) => n + s.credits, 0)).toBe(93);
  expect(board.plan.steps[0].meta).toBe("Seedance 2.5 · 5 s · 1080p");
  expect(board.plan.steps[2].meta).toBe("Kling 3.0 · 5 s · 1080p");
  expect(board.cast.map((c: { line: string }) => c.line)).toEqual(["Lead · ivory suit, short dark bob"]);
  expect(board.cut).toMatchObject({ approved: 2, approvedSeconds: 10, seconds: 15, waiting: 1 });
  expect(JSON.stringify(board)).not.toMatch(/cost|usd|margin|0\.5\b/i);

  /* Their own copy: a draft in this workspace, once. */
  const opened = await (await call({ action: "open" })).json();
  expect(opened).toMatchObject({ created: true });
  expect(opened.project.id).toMatch(/^sample-/);
  expect(opened.project.productionProjectId).toBe(made.productionId);
  expect((await (await call({ action: "open" })).json()).project.id).toBe(opened.project.id);

  /* The copy opens in the app at this viewport. */
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope: made.scope, id: opened.project.id });
  await page.goto(`/suites?project=${opened.project.id}`);
  await expect(page.locator(".gx")).toBeVisible();
  await page.waitForTimeout(800);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  /* Undo hides the mark; the rows stay, and the copy is no longer served as the current sample. */
  expect(await (await call({ action: "undo" })).json()).toEqual({ undone: true });
  expect(await (await page.request.get("/api/demo/sample")).json()).toEqual({ board: null });
  expect((await call({ action: "open" })).status()).toBe(404);

  expect(paid).toEqual([]);
  expect(problems).toEqual([]);
});
