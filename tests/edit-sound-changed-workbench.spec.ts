import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";

/**
 * A stage page that saves through the shared draft store (Edit & Sound): another window saved a different value for the same setting this page also
 * changed. Nothing is saved over theirs; the page says so and waits for Reload or Keep my version. The project routes are mocked at the browser (no
 * engine, no paid call).
 */
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];

test("Edit & Sound holds a same-setting change from another window until the person chooses", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "the board and its Edit & Sound are the desktop's");
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()), scope = `particl-active-${me.workspace.id}-${me.id}`;
  const base: Project = { ...seedProject(), id: "edit-sound-" + randomUUID().slice(0, 8), name: "Edit & Sound test", productionProjectId: "production-fixture", shotMappings: {} };
  base.shots = base.shots.slice(0, 2).map((s) => ({ ...s, duration: 72 }));
  let project: Project = base;
  let revision = 1;
  let rival = false;
  const puts: Project[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        const sent = request.postDataJSON().project as Project;
        /* The first save finds another window's save ahead of it, on the setting this page changed. */
        if (rival) { rival = false; project = { ...project, clipAudio: true }; revision++; return json({ error: "changed", code: "revision_conflict" }, 409); }
        puts.push(sent);
        project = { ...sent, productionProjectId: "production-fixture", shotMappings: {} };
        return json({ revision: ++revision, productionProjectId: "production-fixture", shotMappings: {} });
      }
      return json({ project, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null });
    if (request.method() !== "GET") throw new Error(`Unexpected mutating browser request: ${request.method()} ${path}`);
    return route.fallback();
  });
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: base.id });
  await page.goto(`/suites?project=${base.id}&view=board&region=cut`);
  await expect(async () => {
    await page.getByTestId("cut-open-edit").click({ timeout: 3_000 });
    await expect(page.getByTestId("edit-sound")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
  const toggle = page.getByTestId("es-clip-audio");
  await expect(toggle).toBeChecked();
  rival = true;
  await toggle.uncheck();
  const note = page.getByTestId("es-changed");
  await expect(note).toBeVisible({ timeout: 30_000 });
  await expect(note).toContainText("is kept until you choose");
  expect(puts, "nothing was written over theirs").toHaveLength(0);
  expect(project.clipAudio).toBe(true);
  await page.getByTestId("es-changed-keep").click();
  await expect(note).toHaveCount(0);
  await expect.poll(() => puts.length, { timeout: 30_000 }).toBe(1);
  expect(puts[0].clipAudio).toBe(false);
});
