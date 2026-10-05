import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Production › Delivery (owner's brief, 23 September): the cut downloads as an
 * EDL, FCPXML (Final Cut Pro, Resolve) or Final Cut Pro 7 XML (Premiere), and
 * the delivery spec is edited in place — a new frame rate retimes the cut, the
 * old "Change the spec in Studio" dead end is gone.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const asset = (id: string, kind: Asset["kind"], name: string, mime: string): Asset => ({ id, name, kind, mime, category: "Shot", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
const fixture = (): Project => ({
  ...newProject("Harbour cut"), id: "ws-deliver", productionProjectId: "prod-deliver", shotMappings: {}, fps: 24,
  assets: [asset("gen-wide", "video", "Wide on the ice", "video/mp4"), asset("gen-still", "image", "Mara at the window", "image/png")],
  shots: [{ id: "s1", name: "01 — The crossing", assetId: "gen-wide", duration: 48, sourceIn: 0, note: "" }, { id: "s2", name: "02 — The window", assetId: "gen-still", duration: 72, sourceIn: 0, note: "" }],
});

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/higgsfield/consumer/audio-tools?**", (route) => route.fulfill({ json: { connection: { connected: false, requiresReconnect: false }, capabilities: { voice: false, dubbing: false, analysis: false, reframe: false, languages: [] }, jobs: [] } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=deliver");
  await expect(page.getByTestId("project-name")).toHaveText("Harbour cut");
  return { errors, store };
}


test("export names come from the workspace template for renders in this workspace only", async ({ request }) => {
  const account = await signInLocally(request);
  const { createClient } = await import("@libsql/client");
  const { localPlatformDbUrl } = await import("./helpers/workbenchLocal");
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
  platform.close();
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const id = `gen_name_${Date.now().toString(36)}`;
  try {
    await tenant.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", args: [`prj_${id}`, "Nike AW26", Date.now()] });
    await tenant.execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", args: [id, `prj_${id}`, "dreamina-seedance-2-5-260628", "x", "{}", "succeeded", 3, Date.now(), Date.now()] });
  } finally { tenant.close(); }
  const answer = await request.post("/api/workbench/export-names", { data: { generationIds: [id, "gen_not_here", "../bad"] } });
  expect(answer.ok(), await answer.text()).toBe(true);
  const { names } = await answer.json();
  expect(names[id]).toMatch(/^NikeAW26_.*v3/);
  expect(names[id]).not.toMatch(/\.[a-z0-9]+$/);
  expect(Object.keys(names).sort()).toEqual([id, "gen_not_here"].sort());
  expect(names["gen_not_here"]).toBe("gen_not_here");
});
