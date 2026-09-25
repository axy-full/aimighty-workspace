import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

/**
 * A held take in the Suites Rig (lib/held.ts). With every slot taken, Generate
 * parks the take as held; it may never start, so the Inspector says what it
 * waits for and offers Discard, which ends it as cancelled at no charge.
 * Real local routes against an ENGINE_MOCK server; nothing is intercepted.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const ENGINE = "dreamina-seedance-2-5-260628";

/* Test fixtures only: one shot, and a workspace whose single render slot is taken. */
async function seeded(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const platform = createClient({ url: localPlatformDbUrl() });
  let tenantUrl = "";
  try {
    await platform.execute({ sql: "UPDATE workspaces SET concurrency=1 WHERE id=?", args: [signed.workspace.id] });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally {
    platform.close();
  }
  expect(tenantUrl).toMatch(/^file:/);
  const tenant = createClient({ url: tenantUrl });
  try {
    await tenant.execute({
      sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [`gen_slot_${Date.now()}`, "image", "fixture", "Occupies the only slot", "{}", "running", Date.now(), Date.now()],
    });
  } finally {
    tenant.close();
  }
  const shot: CanvasNode = {
    id: "held-a", title: "Held opening", type: "scene", x: 100, y: 100, width: 344, linked: [], role: "Director", status: "draft", mode: "Video",
    operations: [{ id: "op-held-a", kind: "direction", enabled: true, values: { note: "Wide. Hold still." } }],
    engine: ENGINE, durationS: 5, ratio: "16:9", resolution: "720p",
  };
  const project: Project = { ...newProject("Held fixture"), nodes: [shot] };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  return { project, scope };
}

test("a held take says what it waits for and can be discarded at no charge", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the Inspector's version history is a desktop surface");
  test.setTimeout(180_000);
  const { project, scope } = await seeded(page);
  const patches: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname.startsWith("/api/jobs/")) patches.push(request.postDataJSON());
  });
  await page.goto(`/workspace?project=${project.id}&suite=particl&page=rig&sel=shot:held-a`);
  await expect(page.getByTestId("inspector-title")).toHaveText("Held opening");

  const generate = page.locator('[data-row="page"]').getByRole("button", { name: /^Generate · \d[\d,]* cr$/ });
  await expect(generate).toBeEnabled();
  await generate.click();

  await page.getByRole("button", { name: /^Versions/ }).click();
  const held = page.locator(".pxw-insp-version").filter({ hasText: "Held · waiting for a slot" });
  await expect(held).toHaveCount(1, { timeout: 30_000 });
  await held.getByTestId("rig-discard-held").click();
  await expect(page.getByText("Discarded · nothing was charged")).toBeVisible();
  expect(patches).toEqual([{ discard: true }]);
  // The row reads as what it now is at once, without waiting for the next jobs poll.
  await expect(page.locator(".pxw-insp-version").filter({ hasText: "Cancelled · not billed" })).toHaveCount(1, { timeout: 2_000 });

  const jobs = await page.request.get("/api/jobs?sync=0&limit=20", { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json());
  const take = (jobs.generations ?? []).find((g: { model: string }) => g.model === ENGINE);
  expect(take).toMatchObject({ status: "cancelled" });
  await expect(page.locator(".pxw-insp-version").filter({ hasText: "Cancelled · not billed" })).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("rig-discard-held")).toHaveCount(0);
});
