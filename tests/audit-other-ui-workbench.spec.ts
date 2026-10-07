import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { projectName } from "./helpers/projectName";

/**
 * Make's References well keeps the files that arrived when one fails (audit, outside the suites). The rest of this file
 * asserted the old Library wall, Generate, the Rig phone board, Astra's history and the New asset sheet, whose address
 * redirects now and whose sheet only the dead Composer mounts (Q15, old pages): removed.
 * Real local routes, mock engine; nothing here reaches a provider.
 */
const DESKTOP = ["workbench-1440x900"];

const png = (fill: string) => sharp({ create: { width: 320, height: 320, channels: 3, background: fill } }).png().toBuffer();
async function account(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  return { workspaceId: signed.workspace.id as string, me, scope, headers: { "X-Workbench-Scope": scope } };
}

test("Prompt attach keeps the files that arrived when one fails", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "one desktop");
  const { workspaceId, headers } = await account(page);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 500, "Attach audit", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Attach audit ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.route("**/api/uploads/finish", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.filename === "broken.png") return route.fulfill({ status: 422, json: { error: "The store refused this file." } });
    return route.fallback();
  });

  await page.goto(`/suites?make=video&project=${project.id}`);
  await expect(projectName(page)).toHaveText(project.name);
  /* Release 1: the old Gen composer's attach button is gone; Make's References well takes device files by drop (components/graphite/make/Compose.tsx
     > dropOnWell > dropToIds > the same uploadFilesToProject), so the files arrive as a drop on the well. */
  const files = [
    { name: "look.png", mime: "image/png", data: (await png("#2b6a4a")).toString("base64") },
    { name: "broken.png", mime: "image/png", data: (await png("#6a2b2b")).toString("base64") },
  ];
  await page.getByTestId("gen-well").evaluate((well, list) => {
    const transfer = new DataTransfer();
    for (const f of list) transfer.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.mime }));
    well.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, files);
  await expect(page.getByTestId("gen-well").getByTestId("make-reference")).toContainText("look.png", { timeout: 30_000 });
  await expect(page.getByTestId("gen-well").getByRole("alert")).toContainText("broken.png could not be uploaded (The store refused this file)");
});
