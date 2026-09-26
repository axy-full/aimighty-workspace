import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { dimLabels, smallTargets, smallText } from "./phoneFloors";

/**
 * Crew in the browser (design/particl-suites/CREW_ADDENDUM.md), against the
 * real routes of a local ENGINE_MOCK server: the tab after Atomik, Room ·
 * Members · Sessions, a round that streams in with its price on the button,
 * solutions that route onward, the role card, and the phone floors.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const GOAL = "Open the film without dialogue and still make the product unmistakable inside the first four seconds.";

async function open(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const project = { ...newProject("Dune Studies"), brief: "One kitchen, one rainy dawn. The bottle is never held up to camera.", script: "INT. KITCHEN - DAWN\n\nRain on the window." };
  expect((await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } })).ok()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText("Dune Studies");
  return { errors, project, headers };
}

test("Crew is the sixth tab; a round streams in at the price on the button and leaves three solutions", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, project, headers } = await open(page);
  const suites = page.getByRole("tablist", { name: "Suites" });
  await expect(suites.getByRole("tab")).toHaveText(["Studio", "Gen", "Business", "Viral", "Atomik", "Crew"]);
  await suites.getByRole("tab", { name: "Crew" }).click();
  await expect(page.getByTestId("suite-mark")).toHaveText("CREW");
  expect(new URL(page.url()).searchParams.get("view")).toBe("crew");
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button")).toHaveText([/^01\s*Room$/, /^02\s*Members$/, /^03\s*Sessions$/]);
  await expect(page.getByTestId("crew-engine")).toContainText("multi-agent · xAI key connected");

  /* The default five, the Producer in the chair; no goal, so the button says why. */
  const roster = page.getByTestId("crew-roster");
  await expect(roster.locator("[data-member]")).toHaveCount(5);
  await expect(roster.locator("[data-member='Producer']")).toContainText("chair · medium effort");
  await expect(page.getByTestId("crew-run")).toBeDisabled();
  await expect(page.getByTestId("crew-run-reason")).toHaveText("Write the goal.");

  /* Mute one member: the price is for four, and four speak. */
  await roster.getByRole("switch", { name: "Editor speaks next round" }).click();
  await expect(roster.getByRole("switch", { name: "Editor speaks next round" })).toHaveAttribute("aria-checked", "false");
  await page.getByTestId("crew-goal").fill(GOAL);
  await expect(page.getByTestId("crew-run")).toHaveText(/^Run round · \d+ cr$/);
  await page.getByTestId("crew-run").click();

  const messages = page.getByTestId("crew-message");
  await expect(messages).toHaveCount(9, { timeout: 30_000 });
  await expect(page.getByTestId("crew-transcript")).toContainText("Round 1 · Propose");
  await expect(page.getByTestId("crew-transcript")).toContainText("Round 1 · Challenge");
  await expect(page.getByTestId("crew-transcript")).toContainText("Round 1 · Converge");
  await expect(messages.filter({ hasText: "↳ to " })).toHaveCount(4);
  await expect(messages.last()).toHaveAttribute("data-phase", "converge");
  await expect(messages.last()).toContainText("Chair");
  await expect(messages.filter({ hasText: "Pacing & assembly" })).toHaveCount(0);
  const panel = page.getByTestId("crew-panel");
  await expect(page.getByTestId("crew-solutions").locator(".cw-solution")).toHaveCount(3);
  await expect(panel).toContainText(/\d+ cr settled/);
  await expect(panel).toContainText("1 of 6");
  await expect(page.getByTestId("toast")).toContainText(/Round 1 complete · \d+ cr settled/);

  /* An interjection joins the transcript; Pin adds a fourth solution. */
  await page.getByTestId("crew-say").fill("Keep the tin out of frame.");
  await page.getByTestId("crew-say").press("Enter");
  await expect(messages).toHaveCount(10);
  await expect(messages.last()).toContainText("Producer’s desk");
  await messages.first().getByRole("button", { name: "Pin" }).click();
  await expect(page.getByTestId("crew-solutions").locator(".cw-solution")).toHaveCount(4);

  /* → Brief writes to the saved project and says so, with an Open to Studio › Brief; the room stays put. */
  await page.getByTestId("crew-solutions").locator(".cw-solution").first().getByRole("button", { name: "→ Brief" }).click();
  await expect(page.getByTestId("toast")).toContainText("Added to the Brief");
  await expect(page.getByTestId("crew-solutions").locator(".cw-solution").first().getByTestId("crew-solution-status")).toHaveText("Added to the Brief");
  await page.getByTestId("toast-open").click();
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  const saved = (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project;
  expect(saved.brief).toContain("Crew · Locked dawn frame — ");

  /* Coming back reopens the same room; Sessions lists it. */
  await suites.getByRole("tab", { name: "Crew" }).click();
  await expect(messages).toHaveCount(10);
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Sessions/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Sessions");
  await expect(page.locator(".cw-session")).toHaveCount(1);
  await expect(page.locator(".cw-session")).toContainText("1 round · 4 solutions");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal page scroll").toBe(true);
  expect(errors).toEqual([]);
});

test("the minutes can be filed in the Library once a round exists; nothing to file is said inline", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  await page.goto(page.url() + "&view=crew");
  const file = page.getByTestId("crew-file-minutes");
  await expect(file).toBeVisible();
  await expect(file).toHaveText("File minutes in the Library · free");
  await expect(file).toBeDisabled();
  expect(errors).toEqual([]);
});

test("a role card edits the agent; Members seats a preset; the chair moves", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name) && info.project.name !== "workbench-390x844", "one desktop pair and one phone");
  const { errors } = await open(page);
  await page.goto(page.url() + "&view=crew&cp=members");
  await expect(page.getByTestId("page-title")).toHaveText("Members");
  await expect(page.locator(".cw-rolecard")).toHaveCount(7);
  await expect(page.locator("[data-preset='producer']").getByRole("button")).toHaveText("In the room");
  await page.locator("[data-preset='continuity']").getByRole("button", { name: "Seat in room" }).click();
  await expect(page.getByTestId("crew-roster").locator("[data-member]")).toHaveCount(6);

  await page.getByRole("button", { name: "Continuity supervisor role card" }).click();
  const panel = page.getByTestId("crew-panel");
  await expect(panel).toContainText("Stance · system prompt");
  await panel.getByRole("radio", { name: "High" }).click();
  await expect(panel.getByRole("radio", { name: "High" })).toHaveAttribute("aria-checked", "true");
  await panel.getByRole("button", { name: "Make chair" }).click();
  await expect(panel.getByRole("button", { name: "Chairs the room — writes the solutions" })).toBeVisible();
  const roster = page.getByTestId("crew-roster");
  await expect(roster.locator("[data-member='Continuity supervisor']")).toContainText("chair · high effort");
  await expect(roster.locator("[data-member='Producer']")).not.toContainText("chair");
  await panel.getByRole("button", { name: "Remove from crew" }).click();
  await expect(roster.locator("[data-member]")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("Crew keeps the phone floors", async ({ page }, info) => {
  test.skip(WIDE.includes(info.project.name) || !SIZES.includes(info.project.name), "the three phone viewports");
  await open(page);
  await page.goto(page.url() + "&view=crew");
  await page.getByTestId("crew-goal").fill(GOAL);
  await expect(page.getByTestId("crew-run")).toHaveText(/^Run round · \d+ cr$/);
  await page.getByTestId("crew-run").click();
  await expect(page.getByTestId("crew-message")).toHaveCount(11, { timeout: 30_000 });
  await expect(page.getByTestId("crew-run")).toHaveText(/^Run round · \d+ cr$/);
  await page.getByTestId("crew-view").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  expect(await smallText(page), "text under 12px").toEqual([]);
  expect(await smallTargets(page, ".cw, .cw-strip"), "targets under 44×44").toEqual([]);
  expect(await dimLabels(page, ".cw"), "labels under #7C7C84").toEqual([]);
});
