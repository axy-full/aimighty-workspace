import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { desktop, seedBoard } from "./helpers/s03-board";
import { assetLinkHref } from "../lib/shell/asset-link";

/*
 * Port of "workspace switch drains saves and a refused switch retains editing" (tests/customer.spec.ts, old shell).
 * TENANCY guard. Every board save carries the scope of the workspace it was made in (X-Workbench-Scope), so a save sent
 * after the switch is refused and the edit is lost. Release 1's switch (lib/shell/switch-workspace.ts, behind the avatar
 * menu's "Switch to <workspace>" and a link to another workspace's take) saves the board's pending edit first
 * (RigProvider › drain), asks the route only once that saved, and leaves the page only once the route agreed.
 *
 * A real local server and a real second workspace: the route's own refusal ("Not a workspace of yours.") is real, made by
 * taking the membership away after the page loaded. Only the board's save is held or failed, by intercepting its PUT.
 * The board's canvas is desktop only (phones draw the project's Record, which edits nothing, and the phone's header has no
 * avatar menu), so the save-drain checks run at the desktop sizes; the switch a phone does have, on a link to another of
 * your workspaces' takes, is checked at every size.
 */

const FIRST = "First edit before the workspace switch";
const FINAL = "Final edit before the workspace switch";
const AFTER = "Still editable after the refused switch";
const MARKERS = [FIRST, FINAL, AFTER, "Edit that could not be saved", "Edit saved on the second try"];

type Person = { userId: string; workspaceId: string; other: { id: string; name: string } };

async function platform<T>(run: (db: ReturnType<typeof createClient>) => Promise<T>) {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return await run(db); } finally { db.close(); }
}
const addMember = (workspaceId: string, userId: string) => platform((db) => db.execute({
  sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,?,?)", args: [workspaceId, userId, "member", 0, Date.now()],
}));
const removeMember = (workspaceId: string, userId: string) => platform((db) => db.execute({
  sql: "DELETE FROM memberships WHERE workspace_id=? AND account_id=?", args: [workspaceId, userId],
}));

/** Someone else's workspace, which this person is also a member of: the one the switch offers. */
async function secondWorkspace(page: Page, workspaceId: string): Promise<Person> {
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const owner = await playwrightRequest.newContext({ baseURL: process.env.PW_BASE_URL });
  try {
    const { workspace } = await signInLocally(owner, "Second Owner");
    await addMember(workspace.id, me.id);
    return { userId: me.id, workspaceId, other: { id: workspace.id, name: workspace.name } };
  } finally { await owner.dispose(); }
}

/**
 * The board's draft saves, in the order the server answered them (`save:<edit>:<status>`), and every switch request
 * (`switch`) and its answer (`switched:<status>`), in one list. `hold` keeps the next save from the server until `release`; `fail` answers saves 503.
 */
async function watch(page: Page) {
  const state = { events: [] as string[], hold: false, held: false, fail: false, release: () => {}, holdSwitch: false, releaseSwitch: () => {} };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/workspaces/switch") state.events.push("switch");
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/workspaces/switch") state.events.push(`switched:${response.status()}`);
  });
  /* `holdSwitch` keeps the switch request from the server until `releaseSwitch`: the time the route takes to answer. */
  await page.route((url) => url.pathname === "/api/workspaces/switch", async (route) => {
    if (state.holdSwitch) await new Promise<void>((resolve) => { state.releaseSwitch = resolve; });
    await route.continue();
  });
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") return route.fallback();
    const body = request.postData() ?? "";
    const edit = MARKERS.find((marker) => body.includes(marker)) ?? "other";
    if (state.hold) {
      state.hold = false;
      state.held = true;
      await new Promise<void>((resolve) => { state.release = resolve; });
    }
    if (state.fail) {
      state.events.push(`failed:${edit}`);
      return route.fulfill({ status: 503, json: { error: "Saving is temporarily unavailable." } });
    }
    const response = await route.fetch();
    state.events.push(`save:${edit}:${response.status()}`);
    await route.fulfill({ response });
  });
  return state;
}

async function openBoardList(page: Page, projectId: string) {
  await page.goto(`/suites?project=${projectId}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("board-list-toggle").click();
  const action = page.getByTestId("board-shotlist").getByRole("textbox", { name: "Shot 1 action" });
  await expect(action).toBeEditable();
  return action;
}

const settingsMenu = (page: Page) => page.getByTestId("settings-menu");
/** A tap beside the menu closes it, as on the board (the veil covers the screen while it is open). */
async function closeSettings(page: Page) {
  await page.getByTestId("settings-veil").click({ position: { x: 8, y: 300 } });
  await expect(settingsMenu(page)).toHaveCount(0);
}
async function openSettings(page: Page) {
  if (!(await settingsMenu(page).isVisible())) await page.getByTestId("workspace-avatar").click();
  await expect(settingsMenu(page)).toBeVisible();
}

test("the switch waits for the board's pending save, and a refused switch keeps the board editable", async ({ page }) => {
  test.skip(!desktop(page), "the board's canvas and the avatar menu are desktop only; the phone's switch is the last test's");
  const { project, paid } = await seedBoard(page, [], { beats: true });
  const me = await (await page.request.get("/api/me")).json() as { workspace: { id: string } };
  const person = await secondWorkspace(page, me.workspace.id);
  const state = await watch(page);
  const action = await openBoardList(page, project.id);

  /* Two edits: the first one's save is held at the server's door; the second waits behind it. */
  state.hold = true;
  await action.fill(FIRST);
  await expect.poll(() => state.held).toBe(true);
  await action.fill(FINAL);

  /* Switch: the board's save goes first, so the route is not asked while it is out. */
  await openSettings(page);
  const item = settingsMenu(page).getByRole("menuitem", { name: `Switch to ${person.other.name}`, exact: true });
  await item.click();
  /* Busy, and nothing under the veil takes a press or a key while it runs (the shell is inert): the menu stays open. */
  await expect(page.getByTestId("switching-veil")).toHaveText("Switching…");
  const busy = page.getByTestId(`settings-switch-${person.other.id}`);
  await expect(busy).toHaveText(`Switching to ${person.other.name}…`);
  await expect(busy).toBeDisabled();
  await expect(busy).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("settings-sign-out")).toBeDisabled();
  /* A second press while it saves does nothing of its own. */
  await busy.click({ force: true });
  await page.keyboard.press("Escape");
  await expect(settingsMenu(page)).toBeVisible();
  await page.waitForTimeout(1500);
  expect(state.events, "no switch request while the board's save is held").toEqual([]);

  /* The route will refuse (the membership is gone by the time it is asked); the held save is let through. */
  await removeMember(person.other.id, person.userId);
  state.release();
  await expect.poll(() => state.events.filter((e) => e === "switch").length).toBe(1);
  const switchAt = state.events.indexOf("switch");
  const saves = state.events.slice(0, switchAt);
  expect(saves.at(-1), "the final edit was saved, and answered, before the switch was asked").toBe(`save:${FINAL}:200`);
  expect(saves.every((e) => e.endsWith(":200"))).toBe(true);
  await page.waitForTimeout(500);
  expect(state.events.filter((e) => e === "switch"), "one press, one switch request").toHaveLength(1);
  await expect(page.getByTestId("switching-veil")).toHaveCount(0);

  /* Refused: it says the route's reason, nothing switched, the menu is not busy any more, and the board is still this
     workspace's and editable. (The account read every 30 s may already have dropped the workspace from the menu.) */
  await expect(settingsMenu(page).getByRole("alert")).toHaveText("Not a workspace of yours.");
  await expect(settingsMenu(page).getByRole("menuitem", { name: /^Switching to/ })).toHaveCount(0);
  await expect(settingsMenu(page).getByRole("menuitem", { name: "Sign out", exact: true })).toBeEnabled();
  expect(((await (await page.request.get("/api/me")).json()) as { workspace: { id: string } }).workspace.id).toBe(person.workspaceId);
  await closeSettings(page);
  await action.fill(AFTER);
  await expect.poll(() => state.events.at(-1)).toBe(`save:${AFTER}:200`);

  /* Allowed again (read afresh, the page opened again: nothing is left to save): the switch goes through, and the shell opens in the other workspace. */
  await addMember(person.other.id, person.userId);
  await page.reload();
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible({ timeout: 60_000 });
  await openSettings(page);
  await settingsMenu(page).getByRole("menuitem", { name: `Switch to ${person.other.name}`, exact: true }).click();
  await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace: { id: string } }).workspace.id, { timeout: 30_000 }).toBe(person.other.id);
  await expect(page).toHaveURL(/\/suites/);
  expect(state.events.filter((e) => e.startsWith("failed:"))).toEqual([]);
  expect(paid).toEqual([]);
});

test("a board save that fails: no switch is asked, it says so, and the board stays editable", async ({ page }) => {
  test.skip(!desktop(page), "the board's canvas and the avatar menu are desktop only; the phone's switch is the last test's");
  const { project, paid } = await seedBoard(page, [], { beats: true });
  const me = await (await page.request.get("/api/me")).json() as { workspace: { id: string } };
  const person = await secondWorkspace(page, me.workspace.id);
  const state = await watch(page);
  const action = await openBoardList(page, project.id);

  state.fail = true;
  await action.fill("Edit that could not be saved");
  await expect.poll(() => state.events.some((e) => e.startsWith("failed:"))).toBe(true);
  await openSettings(page);
  const item = settingsMenu(page).getByRole("menuitem", { name: `Switch to ${person.other.name}`, exact: true });
  await item.click();
  await expect(settingsMenu(page).getByRole("alert")).toHaveText("Your last edit could not be saved. Try again before switching.");
  await expect(item).toBeEnabled();
  /* Failing again, it says what to do rather than "try again". */
  await item.click();
  await expect(settingsMenu(page).getByRole("alert")).toHaveText("Your last edit could not be saved. Copy it somewhere safe, then reload.");
  await expect(item).toBeEnabled();
  expect(state.events.filter((e) => e === "switch"), "no switch request after a failed save").toEqual([]);
  expect(((await (await page.request.get("/api/me")).json()) as { workspace: { id: string } }).workspace.id).toBe(person.workspaceId);

  /* Still editable, and once saving works again, Switch saves the edit and then switches. */
  await closeSettings(page);
  await action.fill("Edit saved on the second try");
  await expect(action).toHaveValue("Edit saved on the second try");
  state.fail = false;
  await openSettings(page);
  await settingsMenu(page).getByRole("menuitem", { name: `Switch to ${person.other.name}`, exact: true }).click();
  await expect.poll(() => state.events.includes("switch"), { timeout: 30_000 }).toBe(true);
  const switchAt = state.events.indexOf("switch");
  expect(state.events.slice(0, switchAt).at(-1)).toBe("save:Edit saved on the second try:200");
  await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace: { id: string } }).workspace.id, { timeout: 30_000 }).toBe(person.other.id);
  expect(paid).toEqual([]);
});

test("an edit tried while the route answers is blocked: nothing is sent after the switch request, never a refused save", async ({ page }) => {
  test.skip(!desktop(page), "the board's canvas and the avatar menu are desktop only; the phone's switch is the last test's");
  const { project, paid } = await seedBoard(page, [], { beats: true });
  const me = await (await page.request.get("/api/me")).json() as { workspace: { id: string } };
  const person = await secondWorkspace(page, me.workspace.id);
  const state = await watch(page);
  const action = await openBoardList(page, project.id);

  /* An edit still waiting for its save, then Switch with the route slow to answer. */
  await action.fill(FINAL);
  state.holdSwitch = true;
  await openSettings(page);
  await settingsMenu(page).getByRole("menuitem", { name: `Switch to ${person.other.name}`, exact: true }).click();
  await expect.poll(() => state.events.includes("switch")).toBe(true);
  expect(state.events.slice(0, state.events.indexOf("switch")).at(-1), "the waiting edit was saved before the switch was asked").toBe(`save:${FINAL}:200`);

  /* While the route answers: no press reaches the board, the field cannot be focused or typed into, no shortcut runs. */
  await expect(page.getByTestId("switching-veil")).toBeVisible();
  expect(await action.click({ timeout: 1500 }).then(() => "pressed", () => "blocked")).toBe("blocked");
  await action.focus().catch(() => {});
  await page.keyboard.type(" typed during the switch");
  await page.keyboard.press("Delete");
  await expect(action).toHaveValue(FINAL);
  await page.waitForTimeout(1200);

  /* The route agrees: the page leaves for the other workspace, and nothing was sent to the old one after the switch request. */
  state.releaseSwitch();
  await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace: { id: string } }).workspace.id, { timeout: 30_000 }).toBe(person.other.id);
  await expect(page).toHaveURL(/\/suites/);
  await page.waitForTimeout(1500);
  const after = state.events.slice(state.events.indexOf("switch") + 1);
  expect(after.filter((e) => e.startsWith("save:") || e.startsWith("failed:")), "no save after the switch request").toEqual([]);
  expect(state.events.filter((e) => /:409$/.test(e)), "never a refused save").toEqual([]);
  expect(state.events).toContain("switched:200");
  expect(paid).toEqual([]);
});

test("a link to another of your workspaces, on a phone too: its switch goes through the same path, a refusal keeps the page, then the switch lands", async ({ page }) => {
  const { workspace } = await signInLocally(page.request, "Switch Tester");
  const person = await secondWorkspace(page, workspace.id);
  const state = await watch(page);
  /* What Copy link makes (lib/shell/asset-link.ts › assetLinkHref): the other workspace's take. Nothing of it is read until the switch. */
  const href = assetLinkHref({ origin: process.env.PW_BASE_URL ?? "http://localhost:4551", workspace: person.other.id, production: "production-elsewhere", asset: "generation:render_elsewhere" });
  expect(href).toBeTruthy();
  const link = new URL(href!);
  await page.goto(link.pathname + link.search);
  await expect(page.getByTestId("link-card")).toHaveAttribute("data-phase", "workspace", { timeout: 60_000 });
  const button = page.getByTestId("link-switch");

  await removeMember(person.other.id, person.userId);
  await button.click();
  /* Refused: nothing switched and the card is not busy any more. (The account read every 30 s may already have dropped the
     workspace, and with it the offer: the card then says the link is for a workspace you are not in.) */
  await expect(page.getByTestId("link-error").or(page.getByTestId("link-lead").filter({ hasText: "This link is for a workspace you are not in." }))).toBeVisible();
  if (await page.getByTestId("link-error").isVisible()) await expect(page.getByTestId("link-error")).toHaveText("Not a workspace of yours.");
  await expect(page.getByText("Switching…")).toHaveCount(0);
  expect(state.events.filter((e) => e === "switch")).toEqual(["switch"]);
  expect(((await (await page.request.get("/api/me")).json()) as { workspace: { id: string } }).workspace.id).toBe(person.workspaceId);

  await addMember(person.other.id, person.userId);
  await page.reload();
  await expect(page.getByTestId("link-card")).toHaveAttribute("data-phase", "workspace", { timeout: 60_000 });
  await button.click();
  await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace: { id: string } }).workspace.id, { timeout: 30_000 }).toBe(person.other.id);
  expect(state.events.filter((e) => e === "switch")).toEqual(["switch", "switch"]);
});
