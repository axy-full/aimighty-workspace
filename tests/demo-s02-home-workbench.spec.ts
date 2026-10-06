import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { readFileSync, mkdirSync } from "node:fs";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInWithNewInterface } from "./helpers/newInterface";
import { forbidPaidWork, generation, mockMedia } from "./helpers/workspaceFixtures";
import { screenplayPdf } from "./helpers/screenplayPdf";
import { dimLabels, lastRowClearsPinned, smallTargets, smallText } from "./phoneFloors";
import { newProject, type Project } from "../lib/workbench/studio";

const S02_SHOTS = process.env.S02_SHOTS || join(tmpdir(), "claude-s02-shots");
mkdirSync(S02_SHOTS, { recursive: true });

/**
 * Home (design/particl-graphite/README.md § 1.1; the master's `?view=home`): "What are we making?", the
 * templates, and the person's projects, behind the new interface. Real routes for projects and uploads on
 * the local ENGINE_MOCK server; the jobs tray and one card's picture are served here. Nothing is paid for.
 *
 * Until the shell's switch PR mounts Home, `S02_HOME_URL` points the spec at a local harness that mounts
 * HomeView in the same providers and header.
 */
const HOME = process.env.S02_HOME_URL || "/suites?view=home";
const DESKTOP = "workbench-1440x900";
const COARSE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
/**
 * The viewports where the shell mounts the phone app instead of the desktop Home (lib/shell/use-compact.ts: narrower than 768 px, or a
 * touch screen no taller than 500 px, so 844x390 is a phone). The phone's Home is "Needs you", then "Projects" (README § 3.6, SOW § 2.8):
 * it draws no box, no chips, no templates, no "+ New project", no "Show all". Tests of those skip there and say what covers the phone.
 */
const COMPACT = COARSE;
const isCompact = (info: { project: { name: string } }) => COMPACT.includes(info.project.name);
const NO_BOX_ON_A_PHONE = "the phone's Home has no box, chips, templates or New project (it is Needs you, then Projects); what it does draw is held by 'phone Home as drawn' below and demo-s10-phone-workbench 'phone Home: what needs you first…'";

/** A fresh local workspace. On Studio unless asked: the Invite plan holds one project (lib/plans.ts), and most tests need several. */
async function account(page: Page, plan: "studio" | "invite" = "studio") {
  const signed = await signInWithNewInterface(page.request);
  if (plan === "studio") {
    const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try { await db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [signed.workspace.id] }); } finally { db.close(); }
  }
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  return { scope, headers: { "X-Workbench-Scope": scope } };
}

async function saveProject(page: Page, headers: Record<string, string>, name: string): Promise<Project> {
  const project = newProject(name);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return project;
}

/** The header's jobs tray, as GET /api/jobs?view=tray answers it: one take rendering in `draftId`. */
async function trayRendering(page: Page, draftId: string | null) {
  await page.route((url) => url.pathname === "/api/jobs" && url.searchParams.get("view") === "tray", (route) => route.fulfill({
    json: {
      pollAfterSeconds: 60,
      jobs: draftId ? [{ id: "job-home-1", source: "engine", kind: "video", name: "Shot 1", stage: "rendering", label: "Rendering", tone: "blue", createdAt: Date.now() - 30_000, draftId, projectName: null, price: null, action: null }] : [],
    },
  }));
}

/** One project's newest take, for its card's picture; every other project's library is left to the real route. */
async function pictureFor(page: Page, projectId: string) {
  await page.route((url) => url.pathname === "/api/workbench/library" && url.searchParams.get("projectId") === projectId, (route) => {
    const source = new URL(route.request().url()).searchParams.get("source");
    return route.fulfill({ json: source === "generations" ? { generations: [generation({ id: "gen_home_cover", title: "Wide on the water" })], nextPageCursor: null } : { uploads: [], nextCursor: null } });
  });
}

async function openHome(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(HOME);
  await expect(page.getByTestId("home")).toBeVisible({ timeout: 60_000 });
  return errors;
}

/** The created project as the page sent it (PUT /api/workbench/projects, revision 0). */
function createdBy(page: Page) {
  return page.waitForRequest((r) => r.method() === "PUT" && new URL(r.url()).pathname === "/api/workbench/projects" && (r.postDataJSON() as { revision?: number })?.revision === 0)
    .then((r) => (r.postDataJSON() as { project: Project & { boardKind?: string } }).project);
}

/** Where a template sends its new project: the board of its kind, or (until the board lands) today's page for that kind. */
const BOARD: Record<string, RegExp> = {
  studio: /view=board(?!.*kind=)|page=rig/,
  ads: /kind=ads|suite=moleculr/,
  social: /kind=social|suite=subatomik/,
  script: /start=script|page=brief/,
};

async function noSideScroll(page: Page) {
  const widths = await page.evaluate(() => {
    const home = document.querySelector<HTMLElement>(".gx-hm");
    return { doc: document.documentElement.scrollWidth, view: innerWidth, home: home ? home.scrollWidth - home.clientWidth : 0 };
  });
  expect(widths.doc, "the page scrolls sideways").toBeLessThanOrEqual(widths.view + 1);
  expect(widths.home, "Home scrolls sideways").toBeLessThanOrEqual(1);
}

test("Home as drawn: the box, its chips, the templates and the projects, every line from the workspace", async ({ page }, info) => {
  test.skip(isCompact(info), `${NO_BOX_ON_A_PHONE}; the projects' cards are the twin's`);
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await mockMedia(page);
  const older = await saveProject(page, headers, "Harbour light test");
  const newer = await saveProject(page, headers, "Kitchen at dawn");
  await trayRendering(page, newer.id);
  await pictureFor(page, newer.id);
  const errors = await openHome(page);

  await expect(page.getByTestId("page-title")).toHaveText("What are we making?");
  await expect(page.getByTestId("home-brief")).toHaveAttribute("placeholder", /^A 15-second fashion film/);
  await expect(page.getByTestId("home-attach")).toHaveText("Attach a brief");
  await expect(page.getByTestId("home-add-refs")).toHaveText("Add references");
  await expect(page.getByTestId("home-aspect")).toHaveText(["16:9", "9:16", "1:1"]);
  await expect(page.getByTestId("home-length")).toHaveText(["6 s", "15 s", "30 s", "60 s"]);
  await expect(page.locator('[data-testid="home-aspect"][aria-pressed="true"]')).toHaveText("16:9");
  await expect(page.locator('[data-testid="home-length"][aria-pressed="true"]')).toHaveText("15 s");
  await expect(page.getByTestId("home-templates").getByRole("button")).toHaveText(["Film", "Ad campaign", "Social clips", "Start from a script"]);

  const projects = page.getByTestId("home-projects");
  await expect(projects.getByRole("heading", { name: "Your projects" })).toBeVisible();
  await expect(page.getByTestId("home-new-project")).toHaveText("+ New project");
  const cards = page.getByTestId("home-project");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toHaveAttribute("data-project", newer.id);
  await expect(cards.first()).toContainText("Kitchen at dawn");
  await expect(cards.first()).toContainText(/Edited (just now|\d+ min ago)/);
  await expect(cards.first().getByTestId("home-project-needs")).toHaveText("1 rendering");
  /* A card's picture is read once the card nears the screen (on a short screen, after a scroll). */
  await cards.first().scrollIntoViewIfNeeded();
  await expect(cards.first().locator(".gx-hm-cover")).toHaveAttribute("data-cover", "image");
  await page.locator(`[data-project="${older.id}"]`).scrollIntoViewIfNeeded();
  await expect(page.locator(`[data-project="${older.id}"] .gx-hm-cover`)).toHaveAttribute("data-cover", "swatch");
  await page.evaluate(() => { document.querySelector<HTMLElement>(".gx-hm")!.scrollTop = 0; });
  /* Once the shared queue is read, a project with nothing waiting says so (the master's quiet line). */
  await expect(page.locator(`[data-project="${older.id}"]`).getByTestId("home-project-needs")).toHaveText("Nothing waiting");

  /* Waiting for you is left out while nothing waits; the sample entry waits for its own production. */
  await expect(page.getByText(/Waiting for you/i)).toHaveCount(0);
  await expect(page.getByTestId("home-sample")).toHaveCount(0);
  await expect(page.getByText(/\bquoted\b/i)).toHaveCount(0);

  await noSideScroll(page);
  expect(await smallText(page, ".gx-header, .gx-toast"), "text under 12px").toEqual([]);
  /* The last card clears the bottom edge at full scroll. */
  const last = await page.evaluate(() => {
    const home = document.querySelector<HTMLElement>(".gx-hm")!;
    home.scrollTop = home.scrollHeight;
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="home-project"]'));
    return { bottom: cards.at(-1)!.getBoundingClientRect().bottom, view: innerHeight };
  });
  expect(last.bottom).toBeLessThanOrEqual(last.view);
  expect(errors).toEqual([]);
  const size = info.project.name.replace("workbench-", "");
  await page.screenshot({ path: `${S02_SHOTS}/home-${size}-end.png`, animations: "disabled" });
  await page.evaluate(() => { document.querySelector<HTMLElement>(".gx-hm")!.scrollTop = 0; });
  await page.screenshot({ path: `${S02_SHOTS}/home-${size}.png`, animations: "disabled" });
});

test("a template makes the project at once with what the box holds, then opens the board of its kind", async ({ page }, info) => {
  test.skip(isCompact(info), NO_BOX_ON_A_PHONE);
  test.skip(info.project.name !== DESKTOP, "one desktop");
  await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await openHome(page);

  await page.getByTestId("home-brief").fill("A kettle on a stove. Steam rises into the light.");
  await expect(page.getByTestId("home-box")).toHaveAttribute("data-filled", "");
  await page.locator('[data-testid="home-aspect"][data-value="9:16"]').click();
  await page.locator('[data-testid="home-length"][data-value="30 s"]').click();
  await expect(page.locator('[data-testid="home-aspect"][aria-pressed="true"]')).toHaveText("9:16");

  const sent = createdBy(page);
  await page.getByTestId("home-template-ads").click();
  const project = await sent;
  expect(project).toMatchObject({ name: "A kettle on a stove", brief: "A kettle on a stove. Steam rises into the light.", aspect: "9:16", deliverables: "30 s", boardKind: "ads" });
  await expect(page).toHaveURL(new RegExp(`project=${project.id}`));
  await expect(page).toHaveURL(BOARD.ads);
  await expect(page.getByTestId("toast")).toContainText("A kettle on a stove is open");
  /* The board is up (it replaces Home on screen); back on Home the box is empty again, chips back to their defaults. */
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  await openHome(page);
  await expect(page.getByTestId("home-brief")).toHaveValue("");
  await expect(page.locator('[data-testid="home-aspect"][aria-pressed="true"]')).toHaveText("16:9");
});

test("the same template pressed again with an empty box reopens the project it made, untouched, instead of another", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "one desktop");
  await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await openHome(page);
  let puts = 0;
  page.on("request", (r) => { if (r.method() === "PUT" && new URL(r.url()).pathname === "/api/workbench/projects") puts++; });

  const sent = createdBy(page);
  await page.getByTestId("home-template-film").click();
  const film = await sent;
  expect(film).toMatchObject({ name: "Untitled film", aspect: "16:9", deliverables: "15 s", boardKind: "studio" });
  await expect(page).toHaveURL(BOARD.studio);
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  await page.goto(HOME);
  await expect(page.locator(`[data-project="${film.id}"]`)).toBeVisible();
  await page.getByTestId("home-template-film").click();
  await expect(page).toHaveURL(new RegExp(`project=${film.id}`));
  expect(puts).toBe(1);

  /* Another template is another project; Start from a script opens where the script goes. (The board replaced Home on screen: back to Home first.) */
  await page.goto(HOME);
  await expect(page.getByTestId("home")).toBeVisible({ timeout: 60_000 });
  const script = createdBy(page);
  await page.getByTestId("home-template-script").click();
  expect(await script).toMatchObject({ name: "Untitled script", boardKind: "studio" });
  await expect(page).toHaveURL(BOARD.script);
});

test("+ New project makes an untitled Studio project", async ({ page }, info) => {
  test.skip(isCompact(info), NO_BOX_ON_A_PHONE);
  test.skip(info.project.name !== DESKTOP, "one desktop");
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await saveProject(page, headers, "Existing one");
  await openHome(page);
  const sent = createdBy(page);
  await page.getByTestId("home-new-project").click();
  expect(await sent).toMatchObject({ name: "Untitled project", boardKind: "studio" });
  await expect(page).toHaveURL(BOARD.studio);
});

test("a project the plan can't hold is refused under the templates, in the server's words, and the box keeps its words", async ({ page }, info) => {
  test.skip(isCompact(info), NO_BOX_ON_A_PHONE);
  test.skip(info.project.name !== DESKTOP, "one desktop");
  const { headers } = await account(page, "invite");
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await saveProject(page, headers, "The one project");
  await openHome(page);
  await page.getByTestId("home-brief").fill("A second idea");
  await page.getByTestId("home-template-social").click();
  await expect(page.getByTestId("home-problem")).toHaveText(/^The Invite plan allows 1 project\./);
  await expect(page.getByTestId("home-brief")).toHaveValue("A second idea");
  await expect(page.getByTestId("home-template-social")).toBeEnabled();
  await expect(page.getByTestId("home-project")).toHaveCount(1);
});

test("Attach a brief reads a PDF or a text file on this device into the box; anything else is refused", async ({ page }, info) => {
  test.skip(isCompact(info), NO_BOX_ON_A_PHONE);
  test.skip(info.project.name !== DESKTOP, "one desktop");
  await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await openHome(page);
  const input = page.getByTestId("home-attach-input");

  await page.getByTestId("home-brief").fill("Typed first.");
  await input.setInputFiles({ name: "brief.txt", mimeType: "text/plain", buffer: Buffer.from("A lighthouse keeper's last night.\nWind on the glass.") });
  await expect(page.getByTestId("home-brief")).toHaveValue("Typed first.\n\nA lighthouse keeper's last night.\nWind on the glass.");
  await expect(page.getByTestId("home-brief-file")).toContainText("brief.txt");
  await page.locator('[data-testid="home-aspect"][data-value="9:16"]').click();
  await expect(page.locator('[data-testid="home-aspect"][aria-pressed="true"]')).toHaveText("9:16");
  await expect(page.getByTestId("home-brief")).toHaveValue(/^Typed first\./);
  await page.screenshot({ path: `${S02_SHOTS}/home-${info.project.name.replace("workbench-", "")}-brief.png`, animations: "disabled" });

  await page.getByTestId("home-brief-file").getByRole("button", { name: "Remove brief.txt" }).click();
  await page.getByTestId("home-brief").fill("");
  await input.setInputFiles({ name: "treatment.pdf", mimeType: "application/pdf", buffer: screenplayPdf([["INT. LIGHTHOUSE - NIGHT", "The lamp turns."]]) });
  await expect(page.getByTestId("home-brief")).toHaveValue(/INT\. LIGHTHOUSE - NIGHT[\s\S]*The lamp turns\./, { timeout: 30_000 });
  await expect(page.getByTestId("home-brief-file")).toContainText("treatment.pdf");

  await input.setInputFiles({ name: "brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("PK\u0003\u0004") });
  await expect(page.getByTestId("home-box-status")).toHaveText("Use a PDF or text file.");
  await noSideScroll(page);
});

test("references added on Home are filed into the project a template makes, before its board opens", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "one desktop");
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await openHome(page);
  const still = readFileSync("public/campaign/hero.webp");
  await page.getByTestId("home-refs-input").setInputFiles([
    { name: "look-one.webp", mimeType: "image/webp", buffer: still },
    { name: "look-two.webp", mimeType: "image/webp", buffer: still },
  ]);
  await expect(page.getByTestId("home-ref")).toHaveCount(2);
  await page.getByRole("button", { name: "Remove look-two.webp" }).click();
  await expect(page.getByTestId("home-ref")).toHaveCount(1);

  const filed: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/workbench/library") filed.push(String((r.postDataJSON() as { projectId?: string }).projectId)); });
  const sent = createdBy(page);
  await page.getByTestId("home-template-film").click();
  const project = await sent;
  /* The board opens only once the files are filed. */
  await expect(page).toHaveURL(BOARD.studio, { timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`project=${project.id}`));
  expect(filed).toEqual([project.id]);
  const library = await page.request.get(`/api/workbench/library?projectId=${encodeURIComponent(project.id)}&source=uploads`, { headers }).then((r) => r.json());
  expect((library.uploads as { filename: string }[]).map((u) => u.filename)).toEqual(["look-one.webp"]);
  await expect(page.getByTestId("home-ref")).toHaveCount(0);
});

test("a card opens its project; with many projects the first nine show, then Show all", async ({ page }, info) => {
  test.skip(isCompact(info), "the phone lists every project with no Show all; a card opening its project's Record is 'phone Home: every project is listed and a card opens its Record' below, and demo-s10-phone-record 'the board's address opens that project's Record on a phone, and a project card opens it too'");
  test.skip(info.project.name !== DESKTOP, "one desktop");
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  const made: Project[] = [];
  for (let i = 1; i <= 11; i++) made.push(await saveProject(page, headers, `Project ${String(i).padStart(2, "0")}`));
  await openHome(page);

  await expect(page.getByTestId("home-project")).toHaveCount(9);
  await expect(page.getByTestId("home-show-all")).toHaveText("Show all · 11");
  await page.getByTestId("home-show-all").click();
  await expect(page.getByTestId("home-project")).toHaveCount(11);
  await expect(page.getByTestId("home-show-all")).toHaveCount(0);

  const target = made[0];
  await page.locator(`[data-project="${target.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`project=${target.id}`));
  await noSideScroll(page);
});

test("a workspace with no projects shows the box and the templates; a list that fails to read says so with Try again", async ({ page }, info) => {
  test.skip(isCompact(info), "the phone has no box or templates; its empty workspace and its failed read are 'phone Home: a workspace with no projects, and a list that fails to read' below");
  test.skip(info.project.name !== DESKTOP, "one desktop");
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await openHome(page);
  await expect(page.getByTestId("home-templates")).toBeVisible();
  await expect(page.getByTestId("home-projects")).toHaveCount(0);

  await saveProject(page, headers, "Back again");
  let fail = true;
  await page.route((url) => url.pathname === "/api/workbench/projects", (route) =>
    route.request().method() === "GET" && fail ? route.fulfill({ status: 500, json: { error: "Projects could not be loaded." } }) : route.fallback());
  await page.goto(HOME);
  await expect(page.getByTestId("home-projects-error")).toContainText("Projects could not be loaded.");
  await expect(page.getByTestId("home-projects-error-retry")).toHaveText("Try again");
  fail = false;
  await page.getByTestId("home-projects-error-retry").click();
  await expect(page.getByTestId("home-project")).toHaveCount(1);
});

test("an open right panel never covers Home: the column moves clear of it", async ({ page }, info) => {
  test.skip(!["workbench-1440x900", "workbench-1920x1080"].includes(info.project.name), "desktop widths");
  await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await openHome(page);
  /* The shell sets this while Make (440 + 1) is open; Home reads nothing else. */
  await page.evaluate(() => document.querySelector<HTMLElement>(".gx")!.style.setProperty("--gx-overlay-right", "441px"));
  await expect.poll(() => page.evaluate(() => {
    const col = document.querySelector<HTMLElement>(".gx-hm-col")!.getBoundingClientRect();
    return Math.round(innerWidth - col.right);
  })).toBeGreaterThanOrEqual(441 + 24);
  await noSideScroll(page);
});

test("the box's focus is drawn around the whole box, and every control is reachable by keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "one desktop");
  await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await openHome(page);
  await page.getByTestId("home-brief").focus();
  await expect(page.getByTestId("home-box")).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("home-attach")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("home-add-refs")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-testid="home-aspect"][data-value="16:9"]')).toBeFocused();
  await expect(page.locator('[data-testid="home-aspect"][data-value="16:9"]')).toHaveCSS("outline-style", "solid");
});


/* ── The phone's Home: the same workspace, drawn by the phone app (components/graphite/phone/HomeScreen.tsx) ───────────────────────
   The desktop tests above skip at COMPACT widths; these run only there. They keep every line the phone draws from the workspace and
   every floor; nothing here is priced or spent (the waiting items' prices are in demo-s02-waiting-workbench 'phone Home: …'). */

async function openPhoneHome(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(HOME);
  await expect(page.getByTestId("phone-home")).toBeVisible({ timeout: 60_000 });
  return errors;
}

async function phoneFloors(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${where}: the page scrolls sideways`).toBe(true);
  expect(await smallText(page), `${where}: text under 12px`).toEqual([]);
  expect(await smallTargets(page, ".ph-app"), `${where}: targets under 44×44`).toEqual([]);
  expect(await dimLabels(page, ".ph-app"), `${where}: labels under the floor`).toEqual([]);
  expect(await lastRowClearsPinned(page), `${where}: the last row clears the tabs`).toEqual([]);
}

test("phone Home as drawn: Needs you, then each project's card with what is happening in it, every line from the workspace", async ({ page }, info) => {
  test.skip(!isCompact(info), "desktop widths draw the box and the templates: 'Home as drawn' above");
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await mockMedia(page);
  await saveProject(page, headers, "Harbour light test");
  const newer = await saveProject(page, headers, "Kitchen at dawn");
  await trayRendering(page, newer.id);
  await pictureFor(page, newer.id);
  const errors = await openPhoneHome(page);

  await expect(page.getByTestId("phone-title")).toHaveText("Particl");
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  /* The take rendering is what needs a person's eye; with one row there, the quiet line is not drawn. */
  await expect(page.getByTestId("phone-render-row")).toHaveCount(1);
  await expect(page.getByTestId("phone-render-row")).toContainText("Shot 1");
  await expect(page.getByTestId("phone-render-row").getByTestId("phone-notify")).toHaveText("Notify me");
  await expect(page.getByTestId("phone-approval-row")).toHaveCount(0);
  await expect(page.getByTestId("phone-nothing")).toHaveCount(0);

  const cards = page.getByTestId("phone-project");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Kitchen at dawn");
  await expect(cards.first()).toContainText("1 rendering");
  /* A card's picture is read once the card nears the screen: the newest take for one, the swatch for the other. */
  await cards.first().scrollIntoViewIfNeeded();
  await expect(cards.first().locator(".ph-project-pic img")).toHaveCount(1);
  await cards.nth(1).scrollIntoViewIfNeeded();
  await expect(cards.nth(1)).toContainText("Harbour light test");
  await expect(cards.nth(1).locator(".ph-project-pic img, .ph-project-pic video")).toHaveCount(0);
  /* Once the shared queue is read, a project with nothing waiting says so. */
  await expect(cards.nth(1)).toContainText("Nothing waiting");
  await expect(page.getByText(/\bquoted\b/i)).toHaveCount(0);

  await phoneFloors(page, "Home");
  expect(errors).toEqual([]);
  const size = info.project.name.replace("workbench-", "");
  await page.screenshot({ path: `${S02_SHOTS}/phone-home-${size}.png`, animations: "disabled" });
});

test("phone Home: every project is listed and a card opens its Record", async ({ page }, info) => {
  test.skip(!isCompact(info), "desktop widths show nine, then Show all: 'a card opens its project…' above");
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  const made: Project[] = [];
  for (let i = 1; i <= 11; i++) made.push(await saveProject(page, headers, `Project ${String(i).padStart(2, "0")}`));
  const errors = await openPhoneHome(page);

  /* The phone draws no Show all: every project is a card, newest first. */
  const cards = page.getByTestId("phone-project");
  await expect(cards).toHaveCount(11);
  await expect(cards.first()).toContainText("Project 11");
  await expect(page.getByTestId("home-show-all")).toHaveCount(0);

  const target = made[0];
  await cards.filter({ hasText: "Project 01" }).click();
  await expect(page).toHaveURL(new RegExp(`project=${target.id}`));
  await expect(page.getByTestId("phone-record")).toBeVisible();
  await expect(page.getByTestId("phone-title")).toHaveText("Project 01");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "the page scrolls sideways").toBe(true);
  expect(errors).toEqual([]);
});

test("phone Home: a workspace with no projects says nothing waits and draws no card", async ({ page }, info) => {
  test.skip(!isCompact(info), "desktop widths draw the box and the templates: 'a workspace with no projects…' above");
  await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  const errors = await openPhoneHome(page);
  await expect(page.getByTestId("phone-nothing")).toHaveText("Nothing waiting");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByTestId("phone-project")).toHaveCount(0);
  await phoneFloors(page, "Empty Home");
  expect(errors).toEqual([]);
});

test("phone Home: a projects list that fails to read says so, in the server's words, with Try again", async ({ page }, info) => {
  test.skip(!isCompact(info), "desktop widths: 'a workspace with no projects shows the box… Try again' above");
  /* Product gap found by this twin, not an owner question: components/graphite/phone/HomeScreen.tsx draws no read failure for the
     projects list (PhoneApp receives data.status and data.error but passes them only to Make), so a failed read looks like an empty
     workspace. The fix is one row there (phone-projects-error, a Try again calling data.retry); until it lands this stays fixme. */
  test.fixme(true, "product gap: the phone's Home shows no failure for a projects list that cannot be read (HomeScreen.tsx); needs phone-projects-error with Try again");
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await trayRendering(page, null);
  await saveProject(page, headers, "Back again");
  let fail = true;
  await page.route((url) => url.pathname === "/api/workbench/projects", (route) =>
    route.request().method() === "GET" && fail ? route.fulfill({ status: 500, json: { error: "Projects could not be loaded." } }) : route.fallback());
  await openPhoneHome(page);
  await expect(page.getByTestId("phone-projects-error")).toContainText("Projects could not be loaded.");
  await expect(page.getByTestId("phone-projects-error-retry")).toHaveText("Try again");
  fail = false;
  await page.getByTestId("phone-projects-error-retry").click();
  await expect(page.getByTestId("phone-project")).toHaveCount(1);
});
