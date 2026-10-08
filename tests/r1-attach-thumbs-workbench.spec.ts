import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, readFileSync } from "node:fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInWithNewInterface } from "./helpers/newInterface";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * Release 1: a file added to "What are we making?" shows under the box as its Library tile (components/graphite/AttachThumbs,
 * the Library drawer's own tile and picture, components/graphite/LibraryTile), one per file, in a row that wraps. Pressing a
 * tile ("Remove <name>") takes that file out of what the box sends. Home's box (desktop Home, and the phone's Home) holds files
 * on this device until a template or Start uploads them; the empty board's box holds uploads already in the project's Library.
 * Nothing here is paid for: uploads and a template's project are free, and every paid route is refused (forbidPaidWork).
 */
const SHOTS = process.env.ATTACH_THUMBS_SHOTS || join(tmpdir(), "particl-attach-thumbs");
mkdirSync(SHOTS, { recursive: true });
const HOME = "/suites?view=home";
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const onPhone = (info: { project: { name: string } }) => PHONES.includes(info.project.name);
const size = (page: Page) => `${page.viewportSize()!.width}x${page.viewportSize()!.height}`;
const still = () => readFileSync("public/campaign/hero.webp");

async function account(page: Page) {
  const signed = await signInWithNewInterface(page.request);
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [signed.workspace.id] }); } finally { db.close(); }
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  return { scope, headers: { "X-Workbench-Scope": scope } };
}

async function quiet(page: Page) {
  await page.route((url) => url.pathname === "/api/jobs" && url.searchParams.get("view") === "tray", (route) => route.fulfill({ json: { jobs: [], pollAfterSeconds: 60 } }));
  await page.route((url) => url.pathname === "/api/control-room/approvals", (route) => route.fulfill({ json: { items: [], decided: [], inCredits: true } }));
}

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "the page scrolls sideways").toBeLessThanOrEqual(0);
}

/** A tile's picture really painted (a still with pixels), not an empty box. */
async function painted(tile: Locator) {
  await expect.poll(() => tile.locator(".bd-tile-media img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
}

test("Home's box: each added file shows under the box as its Library tile, and pressing one removes it from what is sent", async ({ page }, info) => {
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await quiet(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(HOME);
  await expect(page.getByTestId(onPhone(info) ? "phone-home" : "home")).toBeVisible({ timeout: 60_000 });
  const box = page.getByTestId("home-box");
  await expect(page.getByTestId("home-files")).toHaveCount(0);

  await page.getByTestId("home-attach-input").setInputFiles({ name: "brief.txt", mimeType: "text/plain", buffer: Buffer.from("A lighthouse keeper's last night.") });
  await page.getByTestId("home-refs-input").setInputFiles([
    { name: "look-one.webp", mimeType: "image/webp", buffer: still() },
    { name: "look-two.webp", mimeType: "image/webp", buffer: still() },
  ]);
  const files = page.getByTestId("home-files");
  await expect(files.getByTestId("attach-thumb")).toHaveCount(3);
  for (const name of ["brief.txt", "look-one.webp", "look-two.webp"]) await expect(files.getByRole("button", { name: `Remove ${name}`, exact: true })).toBeVisible();
  /* Under the box, not inside it. */
  const boxAt = (await box.boundingBox())!, filesAt = (await files.boundingBox())!;
  expect(filesAt.y).toBeGreaterThanOrEqual(boxAt.y + boxAt.height);
  /* The Library's look: a still is the picture; a text file is the tile's plain black, with its name. */
  const two = page.getByTestId("home-ref").nth(1);
  await painted(two);
  await expect(page.getByTestId("home-brief-file").locator(".bd-tile-media img")).toHaveCount(0);
  await expect(page.getByTestId("home-brief-file")).toContainText("brief.txt");
  /* The local pictures are object URLs on this device, not uploads. */
  expect(await two.locator("img").getAttribute("src")).toMatch(/^blob:/);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/home-thumbs-${size(page)}.png` });

  /* × shows on hover (desktop) and always on a touch screen. */
  const x = two.locator(".gx-at-x");
  if (!onPhone(info)) { await two.getByRole("button").hover(); }
  await expect.poll(() => x.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);

  /* A press removes that file. */
  const removedSrc = await two.locator("img").getAttribute("src");
  await page.getByRole("button", { name: "Remove look-two.webp" }).click();
  await expect(page.getByTestId("home-ref")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove look-two.webp" })).toHaveCount(0);
  /* Its object URL was let go. */
  expect(await page.evaluate((src) => fetch(src!).then(() => "alive", () => "revoked"), removedSrc)).toBe("revoked");

  /* From the keyboard too: the brief's tile is reachable and Enter removes it. */
  await page.getByRole("button", { name: "Remove look-one.webp" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Remove brief.txt" })).toBeFocused();
  await expect.poll(() => page.getByTestId("home-brief-file").locator(".gx-at-x").evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("home-brief-file")).toHaveCount(0);
  await expect(files.getByTestId("attach-thumb")).toHaveCount(1);

  /* What a template sends: only the file still shown is filed into the new project. */
  const made = page.waitForRequest((r) => r.method() === "PUT" && new URL(r.url()).pathname === "/api/workbench/projects" && (r.postDataJSON() as { revision?: number })?.revision === 0)
    .then((r) => (r.postDataJSON() as { project: Project }).project);
  await page.getByTestId("home-template-film").click();
  const project = await made;
  await expect(page).toHaveURL(new RegExp(`project=${project.id}`), { timeout: 60_000 });
  const filed = async () => {
    const library = await page.request.get(`/api/workbench/library?projectId=${encodeURIComponent(project.id)}&source=uploads`, { headers }).then((r) => r.json());
    return (library.uploads as { filename: string }[]).map((u) => u.filename);
  };
  await expect.poll(filed, { timeout: 30_000 }).toEqual(["look-one.webp"]);
  expect(errors).toEqual([]);
});

test("the empty board's box: an attached file shows under the box as its Library tile, and pressing it takes it out", async ({ page }, info) => {
  test.skip(onPhone(info), "a phone opens a project's Record, not the canvas; the phone's box is Home's (above)");
  const { scope, headers } = await account(page);
  await forbidPaidWork(page);
  await quiet(page);
  const project = newProject("Attach fixture");
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await page.goto(`/suites?project=${project.id}&view=board`);
  const empty = page.getByTestId("board-empty");
  await expect(empty.getByRole("heading", { name: "What are we making?" })).toBeVisible({ timeout: 60_000 });

  await empty.locator('input[type="file"]').setInputFiles([
    { name: "frame.webp", mimeType: "image/webp", buffer: still() },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Wide on the water.") },
  ]);
  const files = page.getByTestId("board-attached");
  await expect(files.getByTestId("attach-thumb")).toHaveCount(2, { timeout: 30_000 });
  /* The tile replaces the old count line: nothing says it twice. */
  await expect(empty.getByText(/files? attached/)).toHaveCount(0);
  const frame = files.getByRole("button", { name: "Remove frame.webp" });
  /* Already an upload: the tile shows the Library's own stored picture. */
  expect(await frame.locator("img").getAttribute("src")).toMatch(/^\/api\/uploads\//);
  await painted(frame);
  await expect(files.getByRole("button", { name: "Remove notes.txt" }).locator("img")).toHaveCount(0);
  const boxAt = (await empty.locator(".bd-empty-box").boundingBox())!, filesAt = (await files.boundingBox())!;
  expect(filesAt.y).toBeGreaterThanOrEqual(boxAt.y + boxAt.height);
  await noSideScroll(page);
  await page.screenshot({ path: `${SHOTS}/board-thumbs-${size(page)}.png` });

  await frame.click();
  await expect(files.getByRole("button", { name: "Remove frame.webp" })).toHaveCount(0);
  await files.getByRole("button", { name: "Remove notes.txt" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("board-attached")).toHaveCount(0);
  await expect(empty.getByText(/files? attached/)).toHaveCount(0);
});
