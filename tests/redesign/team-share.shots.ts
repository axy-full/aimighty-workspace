import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openBoard } from "../helpers/boardV12";
import { localPlatformDbUrl, signInLocally } from "../helpers/workbenchLocal";
import { mockMedia } from "../helpers/workspaceFixtures";

/*
 * "Share with team" (owner, 12 Oct 2026; PR for #667): the one item in the board's ⋯ menu and in its right-click menu on Home, and a teammate's
 * view-only shared board. The new interface is desktop-only, so these are the desktop sizes (the phone app has no ⋯ board menu and is unchanged).
 * App only: the prototype has no such item yet (the owner adds it in the next design round). Neutral names of the test workspaces' own.
 */
test("share with team: the ⋯ menu, the right-click menu, and a teammate's view-only board", async ({ browser, page }) => {
  test.setTimeout(300_000);
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  const tag = `${size.width}x${size.height}`;
  const shot = async (p: typeof page, name: string) => {
    const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${tag}-app.png`), await p.screenshot({ animations: "disabled" }));
  };
  const made = await openBoard(page, "/suites?view=board&stage=shots");
  const owner = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string }; name: string };
  await mockMedia(page);

  /* The ⋯ menu: Share with team, with its hover. */
  await page.getByTestId("v12-board-menu").click();
  const item = page.getByTestId("v12-menu-share-team");
  await expect(item).toHaveText("Share with team");
  await item.hover();
  await expect(page.getByTestId("v12-tooltip")).toHaveText("Editing together is coming next — for now teammates can view.");
  await shot(page, "team-share-board-menu");
  await item.click();
  await expect(page.getByText(/^Shared with team/).first()).toBeVisible();
  await page.waitForTimeout(600);
  await page.getByTestId("v12-board-menu").click();
  await expect(page.getByTestId("v12-menu-share-team")).toHaveText("Stop sharing with team");
  await shot(page, "team-share-board-menu-shared");
  await page.keyboard.press("Escape");

  /* The right-click menu on Home. */
  await page.goto("/suites?view=home");
  const card = page.getByTestId("v12-home-board").first();
  await expect(card).toBeVisible({ timeout: 90_000 });
  await card.click({ button: "right" });
  await expect(page.getByTestId("v12-menu-share-team")).toHaveText("Stop sharing with team");
  await page.getByTestId("v12-menu-share-team").hover();
  await expect(page.getByTestId("v12-tooltip")).toHaveText("Editing together is coming next — for now teammates can view.");
  await shot(page, "team-share-context-menu");
  await page.keyboard.press("Escape");

  /* A teammate: Home lists the shared board with its maker; it opens view-only. */
  const context = await browser.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4561", viewport: size });
  const mate = await context.newPage();
  try {
    await signInLocally(mate.request, "Teammate Viewer");
    const me = await mate.request.get("/api/me").then((r) => r.json()) as { id: string };
    const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try { await db.execute({ sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,?,?)", args: [owner.workspace.id, me.id, "member", 0, Date.now()] }); } finally { db.close(); }
    expect((await mate.request.post("/api/workspaces/switch", { data: { id: owner.workspace.id } })).ok()).toBe(true);
    await expect.poll(async () => ((await (await mate.request.get("/api/me")).json()) as { workspace?: { newInterface?: boolean } }).workspace?.newInterface ?? false, { timeout: 30_000 }).toBe(true);
    await mockMedia(mate);
    await mate.goto("/suites?view=home");
    const section = mate.getByTestId("v12-home-team-boards");
    await expect(section).toBeVisible({ timeout: 90_000 });
    await mate.mouse.move(0, 0);
    await shot(mate, "team-share-teammate-home");
    await section.getByTestId("v12-home-board").first().click();
    await expect(mate.getByTestId("v12-view-only")).toBeVisible({ timeout: 90_000 });
    await expect(mate.getByTestId("v12-stage-rail")).toBeVisible();
    await mate.waitForTimeout(1500);
    await shot(mate, "team-share-teammate-board");
    expect(made.project.id).toBeTruthy();
  } finally { await context.close(); }
});
