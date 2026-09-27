import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { handoffKey } from "../lib/composeHandoff";
import { DESKTOP, forbidPaid, projectWithShots } from "./helpers/appPagesAudit";

/**
 * Part of the app-pages audit, in a real browser against a local ENGINE_MOCK=1
 * server: the shot builder hands its subject line to Generate. Nothing here
 * submits paid work. The audit is spread over files whose names sort apart,
 * because CI shards take contiguous runs of files and each legacy page costs
 * its dev server gigabytes to compile.
 */

test("the shot builder hands its subject line to Generate and keeps the picks", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "One hand-off pass.");
  await forbidPaid(page);
  await signInLocally(page.request);
  /* Generate composes into a saved Studio project, remembered for this workspace and person. */
  const production = await projectWithShots(page);
  const me = await (await page.request.get("/api/me")).json();
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const saved = { ...newProject("Hand-off film"), productionProjectId: production.id };
  const put = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project: saved, revision: 0 } });
  expect(put.ok(), await put.text()).toBe(true);
  /* The builder is scoped to that production, and Generate remembers no project: only the builder's own lookup can open the right one. */
  await page.addInitScript((production) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("aw_project", production); sessionStorage.setItem("seeded", "1"); } }, production.id);

  await page.goto("/studio/shot");
  await expect(page.getByRole("navigation", { name: "Studio" }).getByRole("link", { name: "Cast", exact: true })).toHaveAttribute("href", "/suites?suite=particl&page=cast");
  /* The drafts are kept per project selection; let it settle before typing. */
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByLabel("Subject line").fill("A courier runs through the rain");
  await page.getByRole("button", { name: "Open in Generate" }).click();
  /* Opened on this production's own Studio project. */
  await expect(page).toHaveURL(new RegExp(`/generate\\?mode=video&project=${saved.id}`));
  await expect.poll(() => page.locator("textarea").evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value).join("\n"))).toContain("A courier runs through the rain");
  /* Taken once: a second visit to Generate does not paste it again. */
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("particl:compose-handoff")).length)).toBe(0);
  await page.goto("/studio/shot");
  await expect(page.getByLabel("Subject line")).toHaveValue("A courier runs through the rain");

  /* Words written for another production wait rather than render, bill and file here. */
  await page.evaluate(({ key, at }) => sessionStorage.setItem(key, JSON.stringify({ prompt: "A second courier", kind: "video", at, productionProjectId: "prj_elsewhere" })), { key: handoffKey(me.workspace.id, me.email), at: Date.now() });
  await page.goto(`/generate?mode=video&project=${saved.id}`);
  await expect(page.getByText("Your Setup is for another production. Choose its project to use it.")).toBeVisible();
  expect(await page.locator("textarea").evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value).join("\n"))).not.toContain("A second courier");
});
