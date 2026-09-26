import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";

const DESKTOPS = ["workbench-1440x900"];
const png = async (fill: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${fill}"/></svg>`)).png().toBuffer();

async function setup(page: Page, shape: (p: Project) => void = () => {}) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Attach test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Attach ${randomUUID().slice(0, 6)}`);
  project.brief = "A fox crosses a frozen harbour at dusk; an old harbour master keeps watch.";
  shape(project);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as Project;
  return { project, errors, read };
}
const hydrated = (target: Locator) => expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);

/**
 * Owner, 25 September: an edit made in the Rig, then straight away one on
 * another Studio stage — the second was sometimes shown but never saved. The
 * Rig's edit went out through the shared canvas as the page changed and was
 * written from an older copy while the stage saved from the same copy; one of
 * the two saves was refused and its edit dropped. Now a save that another
 * save beat is merged into the newer version (lib/workbench/merge.ts) and
 * saved again: both edits are kept, whichever lands first.
 */
async function rigThenCast(page: Page, how: "strip" | "reload") {
  const { project, errors, read } = await setup(page, (p) => {
    p.nodes = [{ id: "n1", title: "Opening", type: "scene", x: 0, y: 0, width: 238, linked: [], role: "Director", status: "draft", mode: "Video", durationS: 5, ratio: "16:9", resolution: "720p" } as Project["nodes"][number]];
    p.production = { cast: { entries: [{ id: "cast-1", kind: "character", name: "Mara", description: "", prompt: "", takes: [] }] } as NonNullable<Project["production"]>["cast"] };
  });
  await page.goto(`/suites?suite=studio&page=rig&project=${project.id}`);
  const row = page.locator(".pxw-rig-row[data-shot-id='n1']");
  await hydrated(row);
  await row.click();
  await page.getByTestId("rig-prompt-attach-file").setInputFiles({ name: "blocking.png", mimeType: "image/png", buffer: await png("#224466") });
  /* A cold dev server compiles the upload route on first use. */
  await expect(page.getByTestId("rig-prompt-attach-note")).toContainText("blocking.png is an input of Opening", { timeout: 60_000 });

  /* Straight to Cast, with the Rig's edit not yet saved. */
  if (how === "strip") await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Cast/ }).click();
  else await page.goto(`/suites?suite=studio&page=cast&sp=cast&project=${project.id}`);
  const mara = page.getByTestId("cast-entry").first();
  await mara.getByTestId("cast-prompt-attach-file").setInputFiles({ name: "mara.png", mimeType: "image/png", buffer: await png("#775544") });
  await expect(mara.getByTestId("cast-reference")).toContainText("mara.png", { timeout: 60_000 });

  /* Both are saved: the Cast reference and the Rig's input. */
  await expect.poll(async () => {
    const p = await read();
    return { cast: Boolean(p.production?.cast?.entries[0]?.referenceAssetId), rigInput: p.assets.some((a) => a.name === "blocking.png") && (p.nodes.find((n) => n.id === "n1")?.linked.length ?? 0) > 0 };
  }, { timeout: 20_000 }).toEqual({ cast: true, rigInput: true });
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 15_000 });
  expect(errors).toEqual([]);
}

test("Rig, then Cast through the stage strip: both edits are saved", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop");
  test.setTimeout(120_000);
  await rigThenCast(page, "strip");
});

test("Rig, then Cast on a fresh page load: both edits are saved", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop");
  test.setTimeout(120_000);
  await rigThenCast(page, "reload");
});
