import { test } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaid, projectWithShots, noHorizontalOverflow } from "./helpers/appPagesAudit";

/**
 * The app-pages audit, in a real browser against a local ENGINE_MOCK=1 server:
 * The changed pages at every size: nothing scrolls sideways. Nothing here submits paid work. The audit is split across files so
 * each CI shard's dev server compiles only some of these pages.
 */

test("changed pages do not scroll sideways", async ({ page }) => {
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);
  await page.addInitScript((id) => localStorage.setItem("aw_project", id), project.id);
  for (const path of [
    `/projects/${project.id}`,
    `/projects/${project.id}/rig/elements`,
    `/productions/${project.productionId}/${project.id}/media`,
    "/atomik/shots",
    "/studio/shot",
    "/suites?view=workspace",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {});
    await noHorizontalOverflow(page);
  }
});
