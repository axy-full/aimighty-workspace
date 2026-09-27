import { test } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaid, projectWithShots, noHorizontalOverflow } from "./helpers/appPagesAudit";

/**
 * Part of the app-pages audit, in a real browser against a local ENGINE_MOCK=1
 * server: the changed Atomik, shot builder and Workspace pages at every size:
 * nothing scrolls sideways. Nothing here submits paid work. The audit is
 * spread over files whose names sort apart, because CI shards take contiguous
 * runs of files and each legacy page costs its dev server gigabytes to
 * compile.
 */

test("changed Atomik, shot builder and Workspace pages do not scroll sideways", async ({ page }) => {
  await forbidPaid(page);
  await signInLocally(page.request);
  const project = await projectWithShots(page);
  await page.addInitScript((id) => localStorage.setItem("aw_project", id), project.id);
  for (const path of [
    "/atomik/shots",
    "/studio/shot",
    "/suites?view=workspace",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {});
    await noHorizontalOverflow(page);
  }
});
