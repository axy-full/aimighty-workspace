import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { saveSchema } from "../lib/workbench/studio-schema";
import { atomikFramesKey } from "../lib/workbench/atomik-video-frames";
import { referenceAdFrameTimes } from "../lib/workbench/atomik-reference-types";
import { legacyShell } from "./helpers/legacyShell";

/**
 * Review stills a video already has are reused, but a still can be removed
 * from the library later. When the estimate refuses a saved still, the dialog
 * forgets that video's stills and prepares fresh ones once, instead of
 * offering the same missing IDs until 60 other videos push them out.
 */
async function open(page: Page, refuse: (uploadIds: string[]) => boolean) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const asset = {
    ...seedProject().assets[0], id: "original-ad", uploadId: "original-ad", generationId: undefined,
    name: "Original advertisement", url: "/api/uploads/original-ad", kind: "video" as const, mime: "video/mp4",
  };
  let project: Project = {
    ...seedProject(), id: "stale-stills", name: "Stale stills campaign", productionProjectId: "stale-production", assets: [asset],
    moleculr: {
      ...EMPTY_MOLECULR, productName: "Our bottle",
      creative: { kind: "video", path: "prompt", category: "motion", aspect: "16:9", direction: "A product reveal.", seconds: 15 },
      referenceAd: { assetId: asset.id, notes: "An observation.", direction: "A direction." },
    },
  };
  // What the dialog keys its stills by: the selected asset as it serialises them (no generationId), for reference-ad sampling.
  const { id, name, kind, url, version, uploadId } = asset;
  const key = atomikFramesKey(scope, project.id, { id, name, kind, url, version, uploadId } as typeof asset, true);
  const cached = referenceAdFrameTimes(1.5).map((timeSeconds, i) => ({ assetId: asset.id, uploadId: `gone-${i}`, timeSeconds, durationSeconds: 1.5 }));
  await page.addInitScript(([k, v]) => window.localStorage.setItem("particl:atomik-video-frames:v1", JSON.stringify([[k, v]])), [key, cached] as const);
  let revision = 1;
  const saved: string[] = [], quoted: string[][] = [], paid: unknown[] = [], errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => (["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort("blockedbyclient")));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/me") return json(me);
    if (path.startsWith("/api/uploads/")) return route.fulfill({ path: "tests/fixtures/astra-source.mp4", contentType: "video/mp4" });
    if (path === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        project = saveSchema.parse(request.postDataJSON()).project as Project;
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} });
      }
      return json({ project, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === "/api/workbench/atomik/frames") {
      saved.push(`fresh-${saved.length}`);
      return json({ id: saved.at(-1) });
    }
    if (path === "/api/workbench/atomik") {
      if (request.method() === "GET")
        return json({ configured: true, models: [{ id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", vision: true, efforts: [] }], jobs: [] });
      const body = request.postDataJSON();
      if (!body.quoteOnly) { paid.push(body); return json({ error: "No run in this spec." }, 409); }
      const ids = body.videoFrames.map((f: { uploadId: string }) => f.uploadId);
      quoted.push(ids);
      if (refuse(ids)) return json({ error: "A sampled frame is unavailable in this workspace." }, 404);
      return json({ model: "anthropic/claude-sonnet-4.6", estimateCredits: 7, visualCount: 12 });
    }
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/workbench/development") return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/atomik") return json({ chats: [], models: { featured: [], rest: [] }, engines: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/engines") return json({ engines: [], models: [], vendors: [] });
    if (request.method() !== "GET") return json({ error: "No other mutation permitted." }, 409);
    return json({});
  });
  await page.goto(await legacyShell(page, "/workbench?project=stale-stills&suite=moleculr&page=variants"));
  const panel = page.getByRole("region", { name: "Reference ad", exact: true });
  await panel.getByRole("button", { name: "Analyze reference ad", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Analyze reference ad", exact: true });
  return { dialog, saved, quoted, paid, errors, stored: () => page.evaluate(() => window.localStorage.getItem("particl:atomik-video-frames:v1") ?? "") };
}

test("a removed review still is replaced once: the estimate loads on fresh stills", async ({ page }) => {
  const run = await open(page, (ids) => ids.some((id) => id.startsWith("gone-")));
  await expect(run.dialog.getByRole("button", { name: "Run · 7 cr estimated", exact: true })).toBeEnabled();
  // The cached stills were offered first and refused; one fresh set was saved and quoted.
  expect(run.quoted[0].every((id) => id.startsWith("gone-"))).toBe(true);
  expect(run.saved).toHaveLength(12);
  expect(run.quoted.at(-1)).toEqual(run.saved);
  await expect(run.dialog.getByText("A sampled frame is unavailable in this workspace.")).toHaveCount(0);
  expect(await run.stored()).toContain("fresh-0");
  expect(await run.stored()).not.toContain("gone-0");
  expect(run.paid).toEqual([]);
  expect(run.errors).toEqual([]);
});

test("stills the estimate still refuses after one fresh set show the error instead of saving more", async ({ page }) => {
  const run = await open(page, () => true);
  await expect(run.dialog.getByText("A sampled frame is unavailable in this workspace.")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(run.saved).toHaveLength(12);
  expect(run.paid).toEqual([]);
  expect(run.errors).toEqual([]);
});
