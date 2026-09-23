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

test("Delivery: EDL, FCPXML and Premiere XML download; the frame rate is changed in place and retimes the cut", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  const { errors, store } = await open(page);
  await expect(page.getByText("Change the spec in Studio")).toHaveCount(0);
  const grab = async (testid: string) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId(testid).click()]);
    return { name: download.suggestedFilename(), text: await readFile((await download.path())!, "utf8") };
  };
  const edl = await grab("deliver-edl");
  expect(edl.name).toBe("Harbour_cut.edl");
  expect(edl.text).toContain("FCM: NON-DROP FRAME");
  const fcp = await grab("deliver-fcpxml");
  expect(fcp.name).toBe("Harbour_cut.fcpxml");
  expect(fcp.text).toContain('<fcpxml version="1.10">');
  expect(fcp.text).toContain('name="02 — The window" offset="86448/24s"');
  const xml = await grab("deliver-xml");
  expect(xml.name).toBe("Harbour_cut.xml");
  expect(xml.text).toContain('<xmeml version="4">');
  await expect(page.getByRole("status").filter({ hasText: "XML downloaded" })).toBeVisible();

  /* 25 fps: the same seconds, re-counted — saved on the project. */
  await page.getByTestId("deliver-fps").selectOption("25");
  await expect.poll(() => store.current.fps, { timeout: 10_000 }).toBe(25);
  expect(store.current.shots.map((s) => s.duration)).toEqual([50, 75]);
  const retimed = await grab("deliver-fcpxml");
  expect(retimed.text).toContain('frameDuration="1/25s"');
  expect(errors).toEqual([]);
});
