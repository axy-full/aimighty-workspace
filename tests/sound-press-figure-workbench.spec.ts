import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";

/**
 * Owner, 21 Oct 2026, 22:15 IST: "a person's audio or dubbing press carries the figure that was on its button, like the Director
 * press (#860)." (lib/pressFigure.ts)
 *
 * Edit & Sound's sound form sends the figure its button shows as `maxCredits`. When the price moved between the quote and the press,
 * the server refuses the press with the new figure (409, `price_moved`, nothing charged); the form says so, the button then shows the
 * new figure, and the next press carries exactly that figure.
 *
 * The audio routes, the job feed and the project save are mocked at the browser (no paid call, no engine), as in
 * tests/edit-sound-workbench.spec.ts. The prices here are synthetic. The board and its Edit & Sound are the desktop's (the phone's Cut
 * is watch-and-approve only and presses no sound), so the phone sizes check only that this spec has nothing to press there.
 */
type Submission = { key: string | undefined; body: Record<string, unknown> };
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];
/** Synthetic prices: what the button first shows, and what the server says after the price moved. */
const SHOWN = 8, MOVED = 10;

async function openEffect(page: Page, projectId: string) {
  await page.goto(`/suites?project=${projectId}&view=board&region=cut`);
  await expect(page.getByTestId("cut-card")).toBeVisible();
  await expect(async () => {
    await page.getByTestId("cut-open-edit").click({ timeout: 3_000 });
    await expect(page.getByTestId("edit-sound")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
  const opener = page.getByTestId("es-new-effect");
  if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
  const panel = page.getByTestId("es-compose").getByRole("region", { name: "Generate sound" });
  await expect(panel).toBeVisible();
  return panel;
}

test("a sound press carries the figure on its button; a moved price is refused with the new figure, shown on the button, and pressed at it", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "the board and its Edit & Sound are the desktop's; the phone presses no sound");
  await signInLocally(page.request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const me = await page.request.get("/api/me").then((r) => r.json()),
    scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...seedProject(), id: "press-figure-" + randomUUID().slice(0, 8), name: "Press figure test", productionProjectId: "production-fixture", shotMappings: {} };
  project.shots = project.shots.slice(0, 2).map((s) => ({ ...s, duration: 72 }));
  let revision = 1;
  const mappings: Record<string, string> = {};
  const submissions: Submission[] = [];
  /* The server's price now: the button's figure until the first press, the moved one after. */
  let price = SHOWN;

  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(value) });
    if (path === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        project = { ...request.postDataJSON().project, productionProjectId: "production-fixture", shotMappings: { ...mappings } };
        return json({ revision: ++revision, productionProjectId: "production-fixture", shotMappings: { ...mappings } });
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        if (body.action !== "map-shot") return json({ error: "unexpected action " + body.action }, 400);
        mappings[body.nodeId] ??= "shot-" + body.nodeId;
        return json({ productionProjectId: "production-fixture", shotId: mappings[body.nodeId] });
      }
      return json({ project: { ...project, shotMappings: { ...mappings } }, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === "/api/audio" && request.method() === "GET")
      return json({ configured: true, speechModels: [{ id: "mock-speech", label: "Mock speech", note: "Local test" }], defaultSpeechModel: "mock-speech", voices: [], voicesError: null, account: null });
    if (path === "/api/audio/voices") return json({ configured: true, voices: [{ id: "mockvoice01", name: "Avery", category: "premade" }] });
    if (path === "/api/audio" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.quoteOnly) return json({ estimatedCredits: price, price, unit: "cr" });
      submissions.push({ key: request.headers()["idempotency-key"], body });
      /* As the route answers (lib/pressFigure.ts): a press under today's price is refused inside its claim, with the new figure. */
      if (submissions.length === 1) {
        price = MOVED;
        return json({ error: `The price is now ${MOVED} cr. Press again to approve it.`, code: "price_moved", quoteChanged: true, estimatedCredits: MOVED, price: MOVED, unit: "cr", charged: 0 }, 409, { "Idempotency-Status": "complete" });
      }
      return json({ id: "mock-audio-" + submissions.length, status: "running", estimatedCredits: price });
    }
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (request.method() !== "GET") throw new Error(`Unexpected paid/mutating browser request: ${request.method()} ${path}`);
    return route.fallback();
  });

  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const panel = await openEffect(page, project.id);
  await panel.getByRole("group", { name: "Sound type" }).getByRole("button", { name: "Sound effect", exact: true }).click();
  await panel.getByLabel("Describe the sound", { exact: true }).fill("Rain on a tin roof, no music.");
  await panel.getByLabel("Length in seconds", { exact: true }).fill("3");
  const generate = panel.locator("[data-sound-generate]");
  await expect(generate).toContainText(`Generate sound effect · ${SHOWN} cr`);

  /* The first press carries the figure on the button; the price moved, so it is refused with the new figure and nothing runs. */
  await generate.click();
  await expect(panel.getByRole("alert")).toContainText(`The price is now ${MOVED} cr. Press again to approve it.`);
  expect(submissions).toHaveLength(1);
  expect(submissions[0].body).toMatchObject({ task: "sound", durationSeconds: 3, maxCredits: SHOWN });
  /* The button now shows the new figure, and the next press carries exactly it, under a new key. */
  await expect(generate).toContainText(`Generate sound effect · ${MOVED} cr`);
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(panel.getByRole("status")).toContainText("Sound effect submitted");
  expect(submissions).toHaveLength(2);
  expect(submissions[1].body).toMatchObject({ task: "sound", durationSeconds: 3, maxCredits: MOVED });
  expect(submissions[1].key).toBeTruthy();
  expect(submissions[1].key).not.toBe(submissions[0].key);
  /* Every press sent a whole-number figure, never none. */
  expect(submissions.every((s) => Number.isInteger(s.body.maxCredits))).toBe(true);

  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("sound-press-figure.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
