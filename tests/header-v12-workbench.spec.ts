import { test, expect, type Page } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";
import { openAsTabs, redesignWithBoards } from "./helpers/v12Header";

/*
 * The new interface's header (components/v12/shell/Header.tsx; docs/redesign/inventory.md § 5.1–5.5, § 4.2–4.3).
 * Desktop: the tabs that hug, their keys and menu, the merged Atomik field, the + popover, Activity and the avatar menu,
 * with no credits pill and no horizontal overflow. Phone sizes: the phone app, as today, with the switch on.
 */

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no horizontal overflow").toBeLessThanOrEqual(0);
}
const boardTab = (page: Page, id: string) => page.locator(`[data-testid="v12-tab-board"][data-id="${id}"]`);

test("phone sizes keep today's phone app with the switch on", async ({ page }, info) => {
  test.skip(!isCompact(info), "the desktop header is covered by the tests below");
  await redesignWithBoards(page, ["Mirror film"]);
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("phone-app")).toBeVisible();
  await expect(page.getByTestId("v12-header")).toHaveCount(0);
  await noHorizontalOverflow(page);
});

test.describe("desktop", () => {
  test.beforeEach(({}, info) => { test.skip(isCompact(info), "the new header is desktop-only; the phone app is checked above"); });

  test("the header: 56 px, Home and Make tabs, board tabs that open with their board, no credits pill, tooltips, no overflow", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["Mirror film", "Launch clips"]);
    await openAsTabs(page, ids);
    const header = page.getByTestId("v12-header");
    expect((await header.boundingBox())!.height).toBe(56);
    await expect(page.locator(".gx-header, [data-testid=workspace-credits]")).toHaveCount(0);
    await expect(page.getByTestId("v12-tab-home")).toHaveAttribute("data-active", "");
    await expect(boardTab(page, ids[0])).toContainText("Mirror film");
    await expect(boardTab(page, ids[1])).toContainText("Launch clips");
    /* Every icon has its tooltip (§ 4.3): the panel icon's, on hover. */
    await page.getByTestId("v12-atomik-panel").hover();
    await expect(page.getByTestId("v12-tooltip")).toContainText("Atomik panel");
    await expect(page.getByTestId("v12-tooltip")).toContainText("Open the conversation: plans, questions and approvals.");
    await page.mouse.move(700, 700);
    await noHorizontalOverflow(page);
    /* The tabs hug: the group ends where its last control ends, not at a fixed width. */
    const nav = (await page.getByTestId("v12-tabs").boundingBox())!;
    const plus = (await page.getByTestId("v12-tab-plus").boundingBox())!;
    expect(Math.abs(nav.x + nav.width - (plus.x + plus.width))).toBeLessThanOrEqual(4);
  });

  test("keys: ⌘3 opens the first board tab, ⌘1 and G H go Home, ⌘2 opens Make, ⌘J toggles Atomik's panel, the field opens ⌘K", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["Mirror film", "Launch clips"]);
    await openAsTabs(page, ids);
    await page.locator("body").click({ position: { x: 700, y: 700 } });
    await page.keyboard.press("ControlOrMeta+3");
    await expect(boardTab(page, ids[0])).toHaveAttribute("data-active", "");
    await page.keyboard.press("ControlOrMeta+1");
    await expect(page.getByTestId("v12-tab-home")).toHaveAttribute("data-active", "");
    await page.keyboard.press("ControlOrMeta+4");
    await expect(boardTab(page, ids[1])).toHaveAttribute("data-active", "");
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await expect(page.getByTestId("v12-tab-home")).toHaveAttribute("data-active", "");
    await page.keyboard.press("ControlOrMeta+2");
    await expect(page.getByTestId("v12-tab-make")).toHaveAttribute("data-active", "");
    await page.getByTestId("v12-tab-home").getByRole("button", { name: "Home" }).click();
    await expect(page.getByTestId("v12-tab-home")).toHaveAttribute("data-active", "");

    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.getByTestId("v12-atomik-panel")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.getByTestId("v12-atomik-panel")).toHaveAttribute("aria-pressed", "false");

    await page.getByTestId("v12-ask").click();
    await expect(page.getByTestId("atomik-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("atomik-palette")).toHaveCount(0);
  });

  test("closing a tab keeps the board: Undo brings the tab back; the tab menu closes others; five boards put one under +1", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["One", "Two", "Three", "Four", "Five"]);
    await openAsTabs(page, ids);
    /* Four show; the fifth goes under +1 ▾. */
    await expect(page.getByTestId("v12-tab-board")).toHaveCount(4);
    await expect(page.getByTestId("v12-tab-more")).toHaveText("+1 ▾");
    await page.getByTestId("v12-tab-more").click();
    await expect(page.getByTestId("v12-more-menu")).toContainText("Five");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-more-menu")).toHaveCount(0);

    await boardTab(page, ids[1]).getByTestId("v12-tab-close").click();
    await expect(boardTab(page, ids[1])).toHaveCount(0);
    await expect(page.getByTestId("v12-toast")).toContainText("Two closed · the board is kept");
    await page.getByTestId("v12-toast-action").click();
    await expect(boardTab(page, ids[1])).toBeVisible();

    await boardTab(page, ids[0]).click({ button: "right" });
    const menu = page.getByTestId("v12-tab-menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Open", "Copy link", "Close", "Close others"]);
    await menu.getByRole("menuitem", { name: "Close others" }).click();
    await expect(page.getByTestId("v12-tab-board")).toHaveCount(1);
    await expect(page.getByTestId("v12-tab-more")).toHaveCount(0);

    /* What was closed is in the + popover's Recently closed, and Reopen brings its tab back. */
    await page.getByTestId("v12-tab-plus").click();
    const plus = page.getByTestId("v12-plus");
    await expect(plus.getByTestId("v12-plus-closed").first()).toBeVisible();
    await plus.getByTestId("v12-plus-closed").filter({ hasText: "Two" }).getByRole("button", { name: "Reopen" }).click();
    await expect(boardTab(page, ids[1])).toHaveAttribute("data-active", "");
  });

  test("closing the open board's tab moves to its neighbour, and Undo puts the closed board back on screen", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["One", "Two", "Three"]);
    await openAsTabs(page, ids, `/suites?view=board&project=${encodeURIComponent(ids[0])}`);
    await expect(boardTab(page, ids[0])).toHaveAttribute("data-active", "");
    await boardTab(page, ids[0]).getByTestId("v12-tab-close").click();
    await expect(boardTab(page, ids[0])).toHaveCount(0);
    await expect(boardTab(page, ids[1])).toHaveAttribute("data-active", "");
    await expect(page).toHaveURL(new RegExp(`project=${ids[1]}`));
    await page.getByTestId("v12-toast-action").click();
    /* The closed board, not the neighbour, is the one on screen again. */
    await expect(boardTab(page, ids[0])).toHaveAttribute("data-active", "");
    await expect(page).toHaveURL(new RegExp(`project=${ids[0]}`));
    await expect(boardTab(page, ids[1])).not.toHaveAttribute("data-active", "");
  });

  test("Close others while Make covers the open board keeps a tab for the board on screen; Activity's scope follows the board", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["One", "Two"]);
    await openAsTabs(page, ids, `/suites?view=board&project=${encodeURIComponent(ids[0])}`);
    await expect(boardTab(page, ids[0])).toHaveAttribute("data-active", "");
    /* Activity narrowed to this board, then Home: off a board it lists every board again. */
    await page.getByTestId("v12-activity").click();
    const activity = page.getByTestId("v12-activity-menu");
    await activity.getByRole("radio", { name: "This board" }).click();
    await expect(activity.getByRole("radio", { name: "This board" })).toBeChecked();
    await page.keyboard.press("Escape");
    await page.getByTestId("v12-tab-home").click();
    await page.getByTestId("v12-activity").click();
    await expect(activity.getByRole("radio", { name: "All boards" })).toBeChecked();
    await page.keyboard.press("Escape");

    /* Make over the open board, then Close others on the other tab: that board opens, so what is on screen has its tab. */
    await boardTab(page, ids[0]).getByRole("button", { name: "One", exact: true }).click();
    await page.getByTestId("v12-tab-make").click();
    await expect(page.getByTestId("v12-tab-make")).toHaveAttribute("data-active", "");
    await boardTab(page, ids[1]).click({ button: "right" });
    await page.getByTestId("v12-tab-close-others").click();
    await expect(page.getByTestId("v12-tab-board")).toHaveCount(1);
    await expect(boardTab(page, ids[1])).toHaveAttribute("data-active", "");
    await expect(page).toHaveURL(new RegExp(`project=${ids[1]}`));
  });

  test("the + popover finds a board and makes a new one by kind on today's create path", async ({ page }) => {
    const { ids } = await redesignWithBoards(page, ["Mirror film", "Launch clips"]);
    await page.goto("/suites?view=home");
    await page.getByTestId("v12-tab-plus").click();
    const plus = page.getByTestId("v12-plus");
    await expect(plus.getByTestId("v12-plus-find")).toBeFocused();
    await expect(plus.getByText("New board")).toBeVisible();
    await expect(plus.getByTestId(/^v12-new-/)).toHaveText([/Film/, /Pre-vis/, /Campaign/, /Social/]);
    await page.keyboard.type("launch");
    await expect(plus.getByTestId("v12-plus-board")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(boardTab(page, ids[1])).toHaveAttribute("data-active", "");

    await page.getByTestId("v12-tab-plus").click();
    await page.getByTestId("v12-new-campaign").click();
    await expect(page.getByTestId("v12-plus")).toHaveCount(0);
    await expect(page.getByTestId("v12-tab-board")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator('[data-testid="v12-tab-board"][data-active]')).toContainText("Untitled ad campaign");
  });

  test("Activity opens what needs you and what runs; the avatar menu holds the balance, Top up and Sign out", async ({ page }) => {
    await redesignWithBoards(page, ["Mirror film"]);
    await page.goto("/suites?view=home");
    const pill = page.getByTestId("v12-activity");
    await expect(pill).toBeVisible();
    await pill.click();
    const activity = page.getByTestId("v12-activity-menu");
    await expect(activity.getByRole("radiogroup", { name: "Which boards" })).toBeVisible();
    await expect(activity.getByTestId("v12-activity-empty")).toBeVisible();
    /* On Home there is no open board to narrow to. */
    await expect(activity.getByRole("radio", { name: "This board" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(activity).toHaveCount(0);

    await page.getByTestId("v12-avatar").click();
    const account = page.getByTestId("v12-account-menu");
    await expect(account.getByTestId("v12-account-balance")).toHaveText(/\d[\d,]*\s*cr$/);
    await expect(account.getByRole("menuitem")).toHaveText(["Top up", "Credits & billing", "Settings", "Sign out"]);
    await account.getByTestId("v12-account-topup").click();
    await expect(account).toHaveCount(0);
    await expect(page).toHaveURL(/[?&](tab|section|view)=/);
  });
});
