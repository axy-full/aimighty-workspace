import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { openBoard } from "./helpers/boardV12";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { mockMedia } from "./helpers/workspaceFixtures";

/**
 * Teammates' boards in the new interface (owner, 12 Oct 2026): a board is private until its author shares it, from one item in the board's ⋯ menu and
 * its right-click menu on Home ("Share with team", saved with Undo, the author's alone). Home then lists the boards teammates shared under the person's own, each saying whose it
 * is; one opens view-only ("<name>'s board · view only"), refuses every edit, and sends not one save. Desktop with the switch on; the phone
 * app is unchanged (no list of teammates' boards there). Local ENGINE_MOCK server.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow").toBe(true);
}

test("desktop: Home lists a teammate's board with its maker; it opens view-only and nothing is saved", async ({ browser, page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  /* The maker: a workspace with a board. */
  const made = await openBoard(page, "/suites?view=board&stage=shots");
  const owner = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string }; name: string };
  /* A teammate: their own account, made a member of the maker's workspace, and switched into it. */
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: info.project.use.viewport });
  const mate = await context.newPage();
  try {
    await signInLocally(mate.request, "Teammate Viewer");
    const me = await mate.request.get("/api/me").then((r) => r.json()) as { id: string };
    const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try { await db.execute({ sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,?,?)", args: [owner.workspace.id, me.id, "member", 0, Date.now()] }); } finally { db.close(); }
    expect((await mate.request.post("/api/workspaces/switch", { data: { id: owner.workspace.id } })).ok()).toBe(true);
    await expect.poll(async () => ((await (await mate.request.get("/api/me")).json()) as { workspace?: { newInterface?: boolean } }).workspace?.newInterface ?? false, { timeout: 30_000 }).toBe(true);
    await mockMedia(mate);
    const saves: string[] = [];
    mate.on("request", (request) => { if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/workbench/projects") saves.push(request.url()); });

    /* Private until shared: the teammate's Home has no teammates' boards, and the board is not theirs to read. */
    await mate.goto("/suites?view=home");
    await expect(mate.getByTestId("v12-home-bar")).toBeVisible({ timeout: 90_000 });
    await expect(mate.getByTestId("v12-home-team-boards")).toHaveCount(0);
    expect((await (await mate.request.get(`/api/workbench/projects?id=${made.project.id}`, { headers: { "X-Workbench-Scope": `particl-active-${owner.workspace.id}-${me.id}` } })).json() as { project: unknown }).project ?? null).toBeNull();

    /* The author shares from the board's ⋯ menu: one item, with its one-line hover, saved at once, with Undo. */
    await page.getByTestId("v12-board-menu").click();
    const shareItem = page.getByTestId("v12-menu-share-team");
    await expect(shareItem).toHaveText("Share with team");
    /* The one-line tooltip (the new interface's, not a native title): on hover, and on keyboard focus. */
    const TIP = "Editing together is coming next — for now teammates can view.";
    await expect(shareItem).not.toHaveAttribute("title", /.+/);
    await shareItem.hover();
    await expect(page.getByTestId("v12-tooltip")).toHaveText(TIP);
    await page.mouse.move(0, 0);
    await expect(page.getByTestId("v12-tooltip")).toHaveCount(0);
    await page.keyboard.press("End");
    await expect(shareItem).toBeFocused();
    await expect(page.getByTestId("v12-tooltip")).toHaveText(TIP);
    await shareItem.click();
    await expect(page.getByText(/^Shared with team/).first()).toBeVisible();
    await expect.poll(async () => ((await (await page.request.get(`/api/workbench/projects?id=${made.project.id}`, { headers: { "X-Workbench-Scope": `particl-active-${owner.workspace.id}-${owner.id}` } })).json()) as { project: { teamShared?: boolean } }).project.teamShared, { timeout: 30_000 }).toBe(true);
    await page.getByTestId("v12-board-menu").click();
    await expect(page.getByTestId("v12-menu-share-team")).toHaveText("Stop sharing with team");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-menu-share-team")).toHaveCount(0);

    await mate.goto("/suites?view=home");
    const section = mate.getByTestId("v12-home-team-boards");
    await expect(section).toBeVisible({ timeout: 90_000 });
    const card = section.getByTestId("v12-home-board");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(`${owner.name}’s board · view only`);
    await noOverflow(mate);

    /* Opened: the board, with whose it is in the stage header; every edit says no. */
    await card.click();
    await expect(mate.getByTestId("v12-view-only")).toHaveText(`${owner.name}’s board · view only`, { timeout: 90_000 });
    await expect(mate.getByTestId("v12-stage-primary")).toHaveCount(0);
    /* Sharing is the author's: a teammate's ⋯ menu has no such item. */
    await mate.getByTestId("v12-board-menu").click();
    await expect(mate.getByRole("menu").getByRole("menuitem").first()).toBeVisible();
    await expect(mate.getByTestId("v12-menu-share-team")).toHaveCount(0);
    await mate.keyboard.press("Escape");
    await expect(mate.getByTestId("v12-stage-rail")).toBeVisible();
    /* The tools that make something are off, and a note cannot be put down (on a stage that draws the canvas: Storyboard is a page now). */
    await mate.locator('[data-testid="v12-stage-row"][data-stage="elements"] .v12-rail-btn').click();
    await expect(mate.getByTestId("v12-board-tools").getByRole("button", { name: /^Note/ })).toBeDisabled();
    await mate.waitForTimeout(2_500);
    expect(saves, "a teammate's board is never saved").toEqual([]);
    /* The server says the same to a save, whoever asks. */
    const scope = `particl-active-${owner.workspace.id}-${me.id}`;
    const seen = await (await mate.request.get(`/api/workbench/projects?id=${made.project.id}`, { headers: { "X-Workbench-Scope": scope } })).json() as { project: { id: string; name: string }; viewOnly?: { owner: { id: string } } };
    expect(seen.viewOnly?.owner.id).toBe(owner.id);
    const refused = await mate.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope, "Content-Type": "application/json" }, data: { project: { ...seen.project, name: "Renamed" }, revision: 0 } });
    expect(refused.status()).toBe(403);
    await noOverflow(mate);

    /* The maker's own Home lists the teammate's boards, none of its own twice, and the maker's board stays editable. */
    await page.goto("/suites?view=home");
    await expect(page.getByTestId("v12-home-board").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-home-team-boards")).toHaveCount(0);
    /* The board card's right-click menu carries the same one item, in its other state, and Undo takes the change back. */
    await page.getByTestId("v12-home-board").first().click({ button: "right" });
    const stop = page.getByTestId("v12-menu-share-team");
    await expect(stop).toHaveText("Stop sharing with team");
    await stop.hover();
    await expect(page.getByTestId("v12-tooltip")).toHaveText("Editing together is coming next — for now teammates can view.");
    await stop.click();
    await expect(page.getByTestId("v12-toast")).toContainText("No longer shared with the team");
    await expect.poll(async () => ((await (await mate.request.get(`/api/workbench/projects?id=${made.project.id}`, { headers: { "X-Workbench-Scope": scope } })).json()) as { project: unknown }).project ?? null, { timeout: 30_000 }).toBeNull();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => ((await (await mate.request.get(`/api/workbench/projects?id=${made.project.id}`, { headers: { "X-Workbench-Scope": scope } })).json()) as { project: unknown }).project ? true : false, { timeout: 30_000 }).toBe(true);
  } finally { await context.close(); }
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("today's phone app: no team list, no sideways scroll", async ({ page }) => {
    await openBoard(page, "/suites?view=board");
    await expect(page.getByTestId("v12-home-team-boards")).toHaveCount(0);
    await noOverflow(page);
  });
});
