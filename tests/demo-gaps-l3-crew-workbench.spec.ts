import { test, expect, type Page } from "@playwright/test";
import { floors, noBannedNames } from "./helpers/r1-gaps";
import { desktop, json, seedCut, shoot, watchErrors } from "./helpers/gaps-l3";

/*
 * Gap screens, lane 3 · Crew review, the internal part (Gaps A frames). In the board's docked panel: the notes the team (and a
 * client, when a review link has been used) have on the take, Add a note, Approve, and Reject with a reason (chips and a free
 * line). All free, all a signed-in person's, and nothing is made. Copy client link and the client's view are another part of the
 * panel (a seam is left, drawing nothing). The board is the desktop's; phone widths open the project's Record, so they skip.
 */
const NAMED_PHONE = "the canvas and its docked Crew review are the desktop's; phone widths open the project's Record (the phone's own review is its own spec)";

async function open(page: Page) {
  const seeded = await seedCut(page, "Crew Tester");
  const errors = watchErrors(page);
  const patches: { path: string; body: { reviewState?: string } }[] = [];
  const notes: { genId?: string; text?: string }[] = [];
  await page.route(/\/api\/jobs\/tk-s3$/, (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { reviewState?: string };
    patches.push({ path: new URL(route.request().url()).pathname, body });
    /* The library answers from the spec: it keeps what the review trail was told. */
    const g = seeded.generations.find((x) => x.id === "tk-s3");
    if (g) Object.assign(g, { reviewState: body.reviewState ?? "", reviewBy: "Tester", approvedBy: body.reviewState === "approved" ? "Tester" : null, approvedAt: body.reviewState === "approved" ? Date.now() : null });
    return json(route, { ok: true, review: { reviewState: body.reviewState ?? "" } });
  });
  /* A client's comment from a review link reads beside the team's, on the take. */
  await page.route(/\/api\/notes\?genId=tk-s3/, async (route) => {
    try {
      const response = await route.fetch();
      const body = await response.json() as { notes: Record<string, unknown>[] };
      body.notes.push({ id: "client-1", text: "Love the light. Can the walk be slower?", author: "A client", userId: "", createdAt: Date.now() - 60_000, guest: true, mentions: [] });
      await route.fulfill({ response, json: body });
    } catch { /* the test ended while this read was in flight */ }
  });
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/notes") notes.push(r.postDataJSON()); });
  const say = await page.request.post("/api/notes", { headers: { "X-Workbench-Scope": seeded.scope }, data: { genId: "tk-s3", text: "Hold one beat longer before she turns." } });
  expect(say.ok(), await say.text()).toBe(true);
  await page.goto(`/suites?project=${seeded.project.id}&view=board&frame=m`);
  const dock = page.getByTestId("board-agent-dock");
  await expect(async () => {
    if ((await dock.getAttribute("data-open")) !== "true") await dock.getByTestId("agent-rail").click({ timeout: 3000 });
    await expect(dock).toHaveAttribute("data-open", "true", { timeout: 3000 });
    await expect(page.getByTestId("crew-take")).toBeVisible({ timeout: 8000 });
  }).toPass({ timeout: 90_000 });
  return { ...seeded, errors, patches, notes, take: page.getByTestId("crew-take") };
}

test("the take under review: its notes (a client's marked), who weighed in, Approve and Reject; no client link of ours", async ({ page }, info) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { take, paid } = await open(page);
  await expect(take.getByTestId("crew-take-sub")).toHaveText("Shot 3 · v1 · 2 reviewers");
  await expect(take.getByTestId("crew-take-notes").locator("li")).toHaveCount(2);
  await expect(take.getByTestId("crew-take-notes")).toContainText("Hold one beat longer before she turns.");
  await expect(take.getByTestId("crew-take-notes")).toContainText("Client · via link");
  await expect(take.getByTestId("crew-take-reviewer")).toHaveCount(2);
  await expect(take.getByTestId("crew-take-approve")).toHaveText("Approve Shot 3");
  await expect(take.getByTestId("crew-take-reject")).toHaveText("Reject with a reason");
  await expect(take.getByTestId("crew-take-earlier")).toHaveCount(0);
  await expect(take).not.toContainText(/client link/i);
  await noBannedNames(page, '[data-testid="crew-take"]');
  await floors(page, '[data-testid="board-agent-panel"]', false);
  await shoot(page, info.project.name, "crew");
  expect(paid).toEqual([]);
});

test("Add a note files it on the take, free, by name", async ({ page }) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { take, notes } = await open(page);
  await take.getByTestId("crew-take-note-input").fill("The reflection is too hot. Bring it down a stop.");
  await expect(take.getByTestId("crew-take-note-add")).toHaveText("Add note · free");
  await take.getByTestId("crew-take-note-add").click();
  await expect(take.getByTestId("crew-take-notes")).toContainText("The reflection is too hot. Bring it down a stop.", { timeout: 20_000 });
  expect(notes.at(-1)).toMatchObject({ genId: "tk-s3", text: "The reflection is too hot. Bring it down a stop." });
});

test("Reject needs a reason (chips and a free line), is recorded as a note and spends nothing; Approve is free too", async ({ page }, info) => {
  test.skip(!desktop(page), NAMED_PHONE);
  const { take, patches, notes, paid } = await open(page);
  await take.getByTestId("crew-take-reject").click();
  const panel = page.getByTestId("take-reject-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("take-reject-confirm")).toHaveText("Reject · spends nothing");
  await panel.getByTestId("take-reject-confirm").click();
  await expect(panel.getByTestId("take-reason-hint")).toBeVisible();
  expect(patches).toEqual([]);
  await panel.getByTestId("take-reject-chip").first().click();
  await panel.getByTestId("take-reason").fill("The feet slide");
  await shoot(page, info.project.name, "crew-reject");
  await panel.getByTestId("take-reject-confirm").click();
  await expect.poll(() => patches.map((p) => p.body.reviewState)).toEqual(["changes"]);
  await expect.poll(() => notes.at(-1)?.text ?? "").toMatch(/Off the brief; The feet slide/);
  await expect(take.getByTestId("crew-take-reject")).toHaveText("Rejected");
  await take.getByTestId("crew-take-approve").click();
  await expect.poll(() => patches.map((p) => p.body.reviewState)).toEqual(["changes", "approved"]);
  await expect(take.getByTestId("crew-take-approve")).toHaveText("Shot 3 approved");
  expect(paid, "judging never spends").toEqual([]);
});
