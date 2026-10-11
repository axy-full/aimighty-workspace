import { expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { newProject } from "../../lib/workbench/studio";
import { signInToRedesign } from "./newInterface";
import { localPlatformDbUrl } from "./workbenchLocal";

/**
 * A redesign session with boards saved in it (today's create route, PUT /api/workbench/projects), for the header's
 * specs: the boards' ids, newest last. On Studio, as tests/demo-s02-home-workbench.spec.ts does: the Invite plan holds
 * one project (lib/plans.ts). Local mock servers only (signInToRedesign checks).
 */
export async function redesignWithBoards(page: Page, names: readonly string[], who = "Header Tester") {
  const signed = await signInToRedesign(page.request, who);
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [signed.workspace.id] }); } finally { db.close(); }
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  const ids: string[] = [];
  for (const name of names) {
    const project = newProject(name);
    const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
    expect(saved.ok(), await saved.text()).toBe(true);
    ids.push(project.id);
  }
  return { ...signed, scope, ids };
}

/** Opens each board once, so each has its tab, then lands on `then`. */
export async function openAsTabs(page: Page, ids: readonly string[], then = "/suites?view=home") {
  for (const id of ids) {
    await page.goto(`/suites?view=board&project=${encodeURIComponent(id)}`);
    await expect(page.locator(`[data-testid="v12-tab-board"][data-id="${id}"]`)).toBeVisible({ timeout: 45_000 });
  }
  await page.goto(then);
  await expect(page.getByTestId("v12-header")).toBeVisible();
}
