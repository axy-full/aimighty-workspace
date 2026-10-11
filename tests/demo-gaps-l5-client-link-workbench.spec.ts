import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { seedBoard } from "./helpers/s03-board";
import { SIZES, desktop, floors, shot, tenantDb, watchErrors, watchPaid } from "./helpers/l5";

/*
 * Lane 5 · Crew review's client link and the client's own view (Gaps A). Real local ENGINE_MOCK=1 server and routes:
 * an owner copies a client link from Crew review; the link opens, signed out, this production's review set and
 * nothing else; the client approves or asks for changes with a comment; the production reads it back. The takes are
 * fixture rows in the workspace's own local database (a test may not render); their bytes are answered by the
 * browser. Nothing paid is sent. Neutral names only.
 */
const clip = readFileSync(path.resolve("tests/fixtures/astra-source.mp4"));

async function seed(page: Page) {
  const board = await seedBoard(page);
  const me = await (await page.request.get("/api/me")).json() as { id: string; workspace: { id: string } };
  const productionId = board.productionId!;
  expect(productionId).toBeTruthy();
  const db = await tenantDb(me.workspace.id);
  try {
    const at = Date.now() - 60_000;
    const gen = (id: string, project: string, state: string, shot: string | null) => ({
      sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,project_id,shot_id,version,review_state,deleted)
            VALUES(?,'video','mock','mock-model',?,'{}','succeeded',?,?,?,?,?,1,?,0)`,
      args: [id, `PRIVATE PROMPT ${id}`, me.id, at, at, project, shot, state],
    });
    await db.batch([
      { sql: "INSERT INTO projects(id,name,description,created_at) VALUES(?,?,?,?)", args: ["prod-l5-other", "Another production", "", at] },
      { sql: "INSERT INTO shots(id,project_id,code,title,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", args: ["shot-l5-1", productionId, "Shot 1", "Opening", 1, at, at] },
      { sql: "INSERT INTO shots(id,project_id,code,title,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", args: ["shot-l5-3", productionId, "Shot 3", "Close", 3, at, at] },
      gen("gen-l5-approved", productionId, "approved", "shot-l5-1"),
      gen("gen-l5-review", productionId, "picked", "shot-l5-3"),
      gen("gen-l5-unjudged", productionId, "", null),
      gen("gen-l5-other", "prod-l5-other", "picked", null),
      { sql: "INSERT INTO notes(id,gen_id,user_id,text,created_at) VALUES(?,?,?,?,?)", args: ["note-l5", "gen-l5-review", me.id, "Is the walk speed right for you?", at] },
    ], "write");
  } finally { db.close(); }
  return { ...board, me, productionId };
}

async function mint(page: Page, headers: Record<string, string>, productionId: string): Promise<string> {
  const made = await page.request.post("/api/review-links", { headers, data: { projectId: productionId } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json() as { url: string }).url;
}

test("Copy client link in Crew review: one production's review set, its expiry, withdrawn in place; nothing paid", async ({ page, context }, info) => {
  test.skip(!SIZES.includes(info.project.name) || !desktop(page), "Crew review is in the board's docked panel, desktop only");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { project, paid } = await seed(page);
  const errors = watchErrors(page);
  await page.goto(`/suites?project=${project.id}&view=board&frame=m`);
  const link = page.getByTestId("crew-review").getByTestId("client-link");
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link.getByTestId("client-link-count")).toHaveText("No live link. Copy one to share the review.");
  await link.getByTestId("client-link-copy").click();
  await expect(link.getByTestId("client-link-url")).toHaveText(/\/review\/rv_[A-Za-z0-9_-]{43}$/);
  const url = await link.getByTestId("client-link-url").innerText();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await expect(link.getByTestId("client-link-count")).toHaveText("1 live link · this production’s review only");
  await expect(link.getByTestId("client-link-expiry")).toHaveText(/^No sign-in · expires \d{1,2} \w{3} \d{4}$/);
  await link.scrollIntoViewIfNeeded();
  await floors(page, "Crew review, client link");
  await shot(page, "crew-link", info);

  /* What the client says comes back to the panel. */
  const token = url.split("/review/")[1];
  const said = await page.request.post(`/api/review/${token}/verdict`, { data: { genId: "gen-l5-review", verdict: "changes", name: "The client", text: "Can the walk be slower?" } });
  expect(said.status()).toBe(201);
  await page.reload();
  await expect(link.getByTestId("client-said-row").first()).toContainText("The client · Shot 3 · v1 · asked for changes");
  await expect(link.getByTestId("client-said-row").first()).toContainText("Can the walk be slower?");
  await link.scrollIntoViewIfNeeded();
  await shot(page, "crew-link-said", info);

  /* Withdrawn in place: the link stops at once. */
  await link.getByTestId("client-link-withdraw").click();
  await expect(link.getByTestId("client-link-count")).toHaveText("No live link. Copy one to share the review.");
  expect((await page.request.get(`/api/review/${token}`)).status()).toBe(404);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("The client's view, signed out: the review set only, approve or ask for changes with a comment, at every size", async ({ page, context }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { headers, productionId } = await seed(page);
  const url = await mint(page, headers, productionId);
  await context.clearCookies();
  const paid = watchPaid(page);
  const errors = watchErrors(page);
  await page.route("**/api/review/*/media/**", (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: clip }));
  await page.goto(new URL(url).pathname);
  const view = page.getByTestId("client-review");
  await expect(view).toBeVisible();
  await expect(view).toContainText("No sign-in needed");
  await expect(page.getByTestId("client-take")).toHaveCount(2);
  await expect(page.getByTestId("client-take").nth(0)).toContainText("Shot 1 · v1Approved");
  await expect(page.getByTestId("client-take").nth(1)).toContainText("Shot 3 · v1Needs your review");
  await expect(page.getByTestId("client-take-name")).toHaveText("Shot 3 · v1");
  /* The team's own notes stay inside the workspace (review of #558, L2). */
  await expect(view).not.toContainText("Is the walk speed right for you?");
  await expect(page.getByTestId("client-expiry")).toHaveText(/^Shared by the production · expires \d{1,2} \w{3} \d{4}$/);
  /* Nothing else: no other production, no prompts, no person's name, no balance, no app chrome. */
  const text = await page.locator("body").innerText();
  for (const leak of ["Another production", "PRIVATE PROMPT", "Board Tester", "credits", " cr", "Top up", "Make", "Atomik", "Settings"]) expect(text, leak).not.toContain(leak);
  await floors(page, "Client view", "[data-testid=client-review]");
  await shot(page, "client", info);

  await page.getByTestId("client-name").fill("The client");
  await page.getByTestId("client-comment").fill("Love the light.");
  await page.getByTestId("client-approve").click();
  await expect(page.getByTestId("client-said")).toHaveText("Shot 3 · v1 approved · the production is told");
  await expect(page.getByTestId("client-take").nth(1)).toContainText(/You approved this · \d{1,2} \w{3} \d{4}/);
  await shot(page, "client-approved", info);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});
