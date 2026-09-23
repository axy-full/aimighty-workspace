import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Production › Beats (owner's brief, 23 September): the chosen agent breaks the
 * approved script into scenes, beats and shots; the director edits beats and
 * shots by hand (saved on the project); the agent redrafts the script to play
 * the edited beats, the draft is reviewed and approved in Brief & Script, and
 * the beat sheet then says the script has moved on. Real local routes, mock engine.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n\nINT. HARBOUR MASTER'S HUT - CONTINUOUS\n\nMARA watches through the window.\n\nMARA\nNot tonight.\n";

async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl() });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Beats test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Beats ${randomUUID().slice(0, 6)}`);
  project.brief = "A fox and a harbour master.";
  project.script = SCRIPT;
  project.production = { scriptApproval: { at: new Date().toISOString(), source: "hand", sha256: createHash("sha256").update(SCRIPT).digest("hex") } };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/workbench/development") && request.method() === "POST") bodies.push(request.postDataJSON()); });
  await page.goto(`/suites?suite=studio&page=brief&sp=beats&project=${project.id}`);
  await expect(page.getByTestId("beats-stage")).toBeVisible();
  const saved2 = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project;
  return { project, errors, bodies, saved: saved2 };
}

test("Beats: the agent breaks the script down, the director edits, the agent redrafts from the beats, the new draft is approved", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(120_000);
  const { errors, bodies, saved } = await setup(page);
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Beats/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("page-title")).toHaveText("Beats & Shots");
  await expect(page.getByTestId("primary-action")).toHaveCount(0);

  /* The breakdown is priced, then run. */
  await page.getByTestId("beats-breakdown-estimate").click();
  await expect(page.getByTestId("beats-breakdown-quote")).toContainText(/\d+ sections? · \d+ agent steps/);
  expect(bodies.at(-1)).toMatchObject({ kind: "screenplay", quoteOnly: true });
  await page.getByTestId("beats-breakdown-start").click();
  const scenes = page.getByTestId("beat-scene");
  await expect(scenes).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("beats-counts")).toHaveText("2 scenes · 4 beats · 2 shots");

  /* The beat board: acts as header tiles, scenes as cards. */
  await expect(page.getByTestId("beat-act")).toHaveText([/Act One\s*Scenes 1 · 1 shots/, /Act Two\s*Scenes 2 · 1 shots/]);

  /* Hand edits inside an opened card: a shot, a deleted beat; then a new shot in scene 2, and scene 2 moved up. */
  await scenes.nth(0).click();
  await page.getByLabel("Shot 1.1 description").fill("Wide: the fox on the ice, the hut's lamp far off");
  await page.getByLabel("Shot 1.1 seconds").fill("6");
  await page.getByLabel("Delete beat 2").click();
  await page.getByTestId("beat-close").click();
  await scenes.nth(1).click();
  await scenes.nth(1).getByTestId("add-shot").click();
  await page.getByLabel("Shot 2.2 description").fill("Close: Mara's breath fogs the glass");
  await page.getByLabel("Scene 2 act").selectOption("1");
  await page.getByLabel("Move scene 2 up").click();
  await expect(page.getByTestId("beats-counts")).toHaveText("2 scenes · 3 beats · 3 shots");
  await expect.poll(async () => {
    const beats = (await saved()).production?.beats;
    return beats ? { first: beats.scenes[0].shots.length, second: beats.scenes[1].shots[0].description, seconds: beats.scenes[1].shots[0].duration } : null;
  }, { timeout: 15_000 }).toEqual({ first: 2, second: "Wide: the fox on the ice, the hut's lamp far off", seconds: 6 });

  await page.getByTestId("beat-close").click();
  await page.getByTestId("beat-board").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("board.png") });
  /* The agent redrafts the script from these beats; the draft is reviewed in Brief & Script. */
  await page.getByTestId("beats-notes").fill("Keep it wordless.");
  await page.getByTestId("beats-redraft-estimate").click();
  await expect(page.getByTestId("beats-redraft-quote")).toContainText("3 agent steps");
  expect(bodies.at(-1)).toMatchObject({ kind: "write", fromBeats: true, instructions: "Keep it wordless.", quoteOnly: true });
  await page.getByTestId("beats-redraft-start").click();
  await page.getByTestId("beats-review-redraft").click({ timeout: 60_000 });
  await expect(page.getByTestId("brief-stage")).toBeVisible();
  await expect(page.getByTestId("brief-review")).toContainText("plays the beat sheet's 2 scenes");
  await expect(page.getByTestId("brief-screenplay")).toContainText("INT. HARBOUR MASTER'S HUT - CONTINUOUS");
  await page.getByTestId("brief-approve").click();
  await expect(page.getByTestId("brief-approved")).toBeVisible();

  /* Back on Beats: the approved script has moved on from this breakdown. */
  await page.getByTestId("brief-to-beats").click();
  await expect(page.getByTestId("beats-breakdown")).toContainText("The script changed after this breakdown.");
  await page.screenshot({ path: info.outputPath("beats.png") });
  expect(errors).toEqual([]);
});
