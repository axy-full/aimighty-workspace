import { test, expect, type Page } from "@playwright/test";
import { apiLog, noOverflow, setSite, signupInvite, teamInvite, visitorSite } from "./helpers/visitorV12";
import { signInLocally } from "./helpers/workbenchLocal";

/**
 * The visitor's new interface (redesign P4; components/v12/visitor, docs/redesign/inventory.md § 8): `/?guest=1` with Guest
 * Home on. The same app for someone signed out: Particl's own showcase, Make with Sample results, the explorable sample
 * board, and a join sheet behind every action that would think, spend, keep or send work. A visitor reaches no route that
 * thinks, spends or reads a workspace: every request the page makes is listed and checked. Local ENGINE_MOCK server.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const HOME = "/?guest=1";
/* The only routes a visitor's page may call: the two invite checks and Request access. */
const ALLOWED = [/^\/api\/auth\/accept\?code=/, /^\/api\/auth\/signup\?code=/, /^\/api\/access-request$/];
const stray = (seen: string[]) => seen.filter((line) => !ALLOWED.some((re) => re.test(line.replace(/^\w+ /, ""))));
const desktop = (info: { project: { name: string } }) => DESKTOP.includes(info.project.name);
const phone = (info: { project: { name: string } }) => PHONE.includes(info.project.name);

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => {
  const health = await request.get("/api/health").then((r) => r.json()).catch(() => null);
  test.skip(!health?.mock, "requires a local ENGINE_MOCK=1 server");
});
test.afterAll(async () => { await setSite({}); });

let sample: { title: string | null; guestWorkspace: string | null } = { title: null, guestWorkspace: null };
test.beforeAll(async ({ browser }) => { sample = await visitorSite(browser); });

const sheet = (page: Page) => page.getByTestId("v12-join");

test("Guest Home off: ?guest=1 is today's site, nothing of the new interface", async ({ page }) => {
  await setSite({});
  await page.goto(HOME);
  await expect(page.getByTestId("v12-visitor")).toHaveCount(0);
  await setSite({ guestHome: true, guestWorkspace: sample.guestWorkspace });
});

test("desktop: the visitor's Home is the same app — header, Particl's own showcase, How it works, the bar — and nothing of any workspace", async ({ page }, info) => {
  test.skip(!desktop(info), "desktop sizes");
  const seen = apiLog(page);
  await page.goto(HOME);
  await expect(page.getByTestId("v12-visitor-home")).toBeVisible({ timeout: 60_000 });
  const header = page.getByTestId("v12-visitor-header");
  await expect(header.getByTestId("v12-visitor-tab-home")).toHaveAttribute("data-active", "");
  await expect(header.getByTestId("v12-visitor-tab-make")).toBeVisible();
  await expect(header.getByTestId("v12-visitor-tab-board")).toContainText("Sample · ");
  await expect(header.getByTestId("v12-visitor-field")).toContainText("Ask Atomik, search or go to");
  await expect(header.getByTestId("v12-visitor-login")).toHaveText("Log in");
  await expect(header.getByTestId("v12-visitor-request")).toHaveText("Request access");
  /* No Activity, no avatar, no credits. */
  for (const none of ["v12-activity", "v12-avatar", "v12-low-credit"]) await expect(page.getByTestId(none)).toHaveCount(0);
  await expect(page.getByTestId("v12-visitor-title")).toHaveText("Made with Particl");
  await expect(page.getByText("Particl’s own showcase · tap a tile to make one like it")).toBeVisible();
  /* The wall is Particl's own public stills; no Waiting for you, no Your boards. */
  const tiles = page.getByTestId("v12-visitor-tile");
  await expect(tiles).toHaveCount(3);
  const urls = await tiles.locator("img").evaluateAll((els) => els.map((el) => new URL((el as HTMLImageElement).src).pathname));
  expect(urls.every((u) => u.startsWith("/campaign/"))).toBe(true);
  const text = await page.getByTestId("v12-visitor-home").innerText();
  expect(text).not.toMatch(/Waiting for you|Your boards/);
  const how = page.getByTestId("v12-visitor-how");
  await expect(how).toContainText("How it works");
  await expect(how).toContainText("Particl is invite-only");
  for (const title of ["Describe it", "Atomik plans the stages", "Approve as it’s made", "Deliver in every size and language"]) await expect(how).toContainText(title);
  await expect(page.getByTestId("v12-visitor-start")).toHaveText("Start · quoted");
  await noOverflow(page, "visitor Home");
  expect(stray(seen), "a visitor's Home calls only the invite checks and Request access").toEqual([]);
});

test("desktop: Start opens the join sheet with the prompt; Esc and × keep the text; a tile picks, fades the rest, and Remix opens the sheet", async ({ page }, info) => {
  test.skip(!desktop(info), "desktop sizes");
  const seen = apiLog(page);
  await page.goto(HOME);
  const input = page.getByTestId("v12-visitor-bar-input");
  await expect(input).toBeVisible({ timeout: 60_000 });
  await input.fill("A 30 s ad for a tea brand");
  await page.getByTestId("v12-visitor-start").click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByTestId("v12-join-title")).toHaveText("To start a board you need a Particl account");
  await expect(page.getByTestId("v12-join-prompt")).toHaveText("“A 30 s ad for a tea brand”");
  await expect(page.getByTestId("v12-join-want")).toHaveValue("A 30 s ad for a tea brand");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(input).toHaveValue("A 30 s ad for a tea brand");
  /* Enter in the bar opens it too, and × closes it. */
  await input.press("Enter");
  await expect(sheet(page)).toBeVisible();
  await page.getByTestId("v12-dialog-close").click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(input).toHaveValue("A 30 s ad for a tea brand");

  /* Pick a tile: "Picked", the rest fade, the bar opens Length and Aspect; Start quotes the tile's words. */
  const tiles = page.getByTestId("v12-visitor-tile");
  await tiles.first().getByTestId("v12-visitor-tile-pick").click();
  await expect(tiles.first().getByTestId("v12-visitor-tile-picked")).toHaveText("Picked");
  await expect(tiles.nth(1)).toHaveAttribute("data-faded", "");
  await expect(page.getByTestId("v12-visitor-sheet")).toBeVisible();
  await page.getByTestId("v12-visitor-start").click();
  await expect(page.getByTestId("v12-join-prompt")).toContainText("Make one like “");
  await page.keyboard.press("Escape");
  await tiles.nth(1).hover();
  await tiles.nth(1).getByTestId("v12-visitor-tile-remix").click();
  await expect(page.getByTestId("v12-join-title")).toContainText("To make this you need a Particl account");
  await page.keyboard.press("Escape");
  /* Attach and + open it as well; nothing opens a file chooser. */
  await page.getByTestId("v12-visitor-bar-attach").click();
  await expect(page.getByTestId("v12-join-title")).toHaveText("To upload or attach files you need a Particl account");
  await page.keyboard.press("Escape");
  expect(stray(seen)).toEqual([]);
});

test("desktop: the header's actions open the sheet by their reason; ⌘K too; Log in comes back here", async ({ page }, info) => {
  test.skip(!desktop(info), "desktop sizes");
  await page.goto(HOME);
  await expect(page.getByTestId("v12-visitor-header")).toBeVisible({ timeout: 60_000 });
  const title = page.getByTestId("v12-join-title");
  await page.getByTestId("v12-visitor-plus").click();
  await expect(title).toHaveText("To open a new board you need a Particl account");
  await page.keyboard.press("Escape");
  await page.getByTestId("v12-visitor-ask").click();
  await expect(title).toHaveText("To ask Atomik you need a Particl account");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await expect(title).toHaveText("To ask Atomik you need a Particl account");
  await page.keyboard.press("Escape");
  await page.getByTestId("v12-visitor-request").click();
  await expect(title).toHaveText("Request access to Particl");
  await expect(page.getByTestId("v12-join-login")).toHaveAttribute("href", /^\/login\?next=%2F%3Fguest%3D1/);
  await expect(page.getByTestId("v12-visitor-login")).toHaveAttribute("href", /^\/login\?next=/);
});

test("desktop: Make shows Sample results; Make, Download, Send to board and Keep in Library open the sheet", async ({ page }, info) => {
  test.skip(!desktop(info), "desktop sizes");
  const seen = apiLog(page);
  await page.goto(`${HOME}&screen=make`);
  await expect(page.getByTestId("v12-visitor-make")).toBeVisible({ timeout: 60_000 });
  const results = page.getByTestId("v12-visitor-result");
  await expect(results).toHaveCount(3);
  await expect(page.getByTestId("v12-visitor-sample-pill")).toHaveCount(3);
  await expect(page.getByTestId("v12-visitor-make-send")).toHaveText("Make · quoted");
  /* The composer's modes work. */
  await page.getByRole("radio", { name: "Audio" }).click();
  await expect(page.getByTestId("v12-visitor-make-bar-input")).toHaveAttribute("placeholder", "A line, a cue or a sound");
  await page.getByTestId("v12-visitor-make-bar-input").fill("a gull over water");
  await page.getByTestId("v12-visitor-make-send").click();
  await expect(page.getByTestId("v12-join-title")).toHaveText("To make this you need a Particl account");
  await expect(page.getByTestId("v12-join-prompt")).toHaveText("“a gull over water”");
  await page.keyboard.press("Escape");
  for (const [id, title] of [["download", "To download originals you need a Particl account"], ["send", "To open a new board you need a Particl account"], ["keep", "To add to a Library you need a Particl account"]] as const) {
    await results.first().hover();
    await results.first().getByTestId(`v12-visitor-${id}`).click();
    await expect(page.getByTestId("v12-join-title")).toHaveText(title);
    await page.keyboard.press("Escape");
  }
  await noOverflow(page, "visitor Make");
  expect(stray(seen)).toEqual([]);
});

test("desktop: the sample board is explorable and says nothing is saved; every action opens the sheet", async ({ page }, info) => {
  test.skip(!desktop(info), "desktop sizes");
  const seen = apiLog(page);
  await page.goto(`${HOME}&screen=board`);
  await expect(page.getByTestId("v12-visitor-board")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("v12-visitor-pill")).toHaveText("Sample · changes on the sample aren’t saved");
  await expect(page.getByTestId("v12-stage-kind")).toHaveText("FILM");
  expect(await page.getByTestId("v12-stage-row").count()).toBe(8);
  await expect(page.getByTestId("v12-visitor-stage")).toHaveText("Storyboard");
  const cards = page.getByTestId("v12-visitor-card");
  await expect(cards).toHaveCount(3);
  await cards.nth(2).getByTestId("v12-visitor-approve").click();
  await expect(page.getByTestId("v12-join-title")).toHaveText("To change the sample you need a Particl account");
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="v12-stage-row"][data-stage="shots"] .v12-rail-btn').click();
  await expect(page.getByTestId("v12-visitor-stage")).toHaveText("Shots");
  await page.getByTestId("v12-visitor-plan-approve").click();
  await expect(page.getByTestId("v12-join-title")).toContainText("To run this you need a Particl account · Approve · ");
  await page.keyboard.press("Escape");
  /* The rail cannot be changed on a sample. */
  await expect(page.getByTestId("v12-stage-add")).toHaveCount(0);
  await page.getByTestId("v12-visitor-board-bar-input").fill("make shot two darker");
  await page.getByTestId("v12-visitor-ask-send").click();
  await expect(page.getByTestId("v12-join-title")).toHaveText("To ask Atomik you need a Particl account");
  await page.keyboard.press("Escape");
  await noOverflow(page, "sample board");
  expect(stray(seen)).toEqual([]);
});

test("desktop: a link to a board that is not theirs says 'You don’t have access' with Log in and Request access, and shows nothing of it", async ({ page }, info) => {
  test.skip(!desktop(info), "desktop sizes");
  const seen = apiLog(page);
  await page.goto(`${HOME}&board=draft-of-another-workspace`);
  const none = page.getByTestId("v12-no-access");
  await expect(none).toBeVisible({ timeout: 60_000 });
  await expect(none.getByRole("heading")).toHaveText("You don’t have access");
  await expect(none).toContainText("This board belongs to another workspace. Boards, names and assets are never shown outside their workspace.");
  await expect(page.getByTestId("v12-no-access-login")).toHaveAttribute("href", /^\/login\?next=/);
  await page.getByTestId("v12-no-access-request").click();
  await expect(page.getByTestId("v12-join-title")).toHaveText("Request access to Particl");
  /* The link's own id is only the address the visitor typed; nothing is asked of the server for it, and nothing of a board is drawn. */
  expect(await page.locator("body").innerText()).not.toContain("draft-of-another-workspace");
  expect(seen).toEqual([]);
  expect(stray(seen)).toEqual([]);
});

test("desktop: Request access sends today's access request with the company, role and size in its note, and says you're on the list", async ({ page }, info) => {
  test.skip(!desktop(info), "desktop sizes");
  const sent: Record<string, unknown>[] = [];
  await page.route((url) => url.pathname === "/api/access-request", (route) => { sent.push(route.request().postDataJSON() as Record<string, unknown>); return route.fulfill({ json: { ok: true } }); });
  await page.goto(`${HOME}&join=start`);
  await page.getByTestId("v12-visitor-bar-input").waitFor({ timeout: 60_000 });
  await expect(sheet(page)).toBeVisible();
  await page.getByTestId("v12-join-name").fill("Visitor One");
  await page.getByTestId("v12-join-work-email").fill("visitor.one@example.test");
  await page.getByTestId("v12-join-company").fill("A small studio");
  await page.getByTestId("v12-join-role").selectOption("Agency");
  await page.getByTestId("v12-join-size").selectOption("11–50");
  await page.getByTestId("v12-join-want").fill("A 30 s ad");
  await page.getByTestId("v12-join-send").click();
  await expect(page.getByTestId("v12-join-requested")).toContainText("You’re on the list.");
  await expect(page.getByTestId("v12-join-requested")).toContainText("We’ll email you when your invite is ready; your prompt is saved for when you’re in.");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ name: "Visitor One", email: "visitor.one@example.test", organisation: "A small studio", role: "Agency", size: "11–50", brief: "A 30 s ad" });
  await page.getByTestId("v12-join-keep-looking").click();
  await expect(sheet(page)).toHaveCount(0);
});

test("desktop: an invite link — team, new workspace (name, plan) and expired — through today's invite checks", async ({ page, browser }, info) => {
  test.skip(!desktop(info), "desktop sizes");
  const seed = await browser.newContext();
  const owner = await signInLocally((await seed.newPage()).request, "Inviting Owner");
  await seed.close();
  const team = await teamInvite(owner.workspace.id);
  const usedTeam = await teamInvite(owner.workspace.id, "used");
  const fresh = await signupInvite();

  /* A team invite: the banner names the workspace, the sheet opens with the code filled in and nothing else to fill. */
  await page.goto(`${HOME}&invite=${team.code}`);
  const banner = page.getByTestId("v12-invite-banner");
  await expect(banner).toContainText(`${owner.workspace.name} invited you to Particl`, { timeout: 60_000 });
  await expect(page.getByTestId("v12-join-title")).toHaveText(`Join ${owner.workspace.name}’s workspace`);
  await expect(page.getByTestId("v12-join-code")).toHaveValue(team.code);
  await expect(page.getByTestId("v12-join-request")).toHaveCount(0);
  await expect(page.getByTestId("v12-join-email")).toBeVisible();
  await page.getByTestId("v12-join-email").click();
  await expect(page).toHaveURL(new RegExp(`/invite/${team.code}$`), { timeout: 30_000 });

  /* A new-workspace invite: name, plan (display only), then today's sign-up page with the name carried. */
  await page.goto(`${HOME}&invite=${fresh.code}`);
  await expect(page.getByTestId("v12-invite-banner")).toContainText("You’re invited to create a workspace on Particl", { timeout: 60_000 });
  await expect(page.getByTestId("v12-join-title")).toHaveText("Create your workspace");
  await page.getByTestId("v12-join-workspace").fill("North Quay Films");
  await page.getByTestId("v12-join-continue").click();
  await expect(page.getByTestId("v12-join-plan")).toHaveCount(3);
  await expect(page.getByTestId("v12-join-new")).toContainText("Prices are placeholders · confirm. Nothing runs without a price shown first.");
  await page.getByTestId("v12-join-plan").nth(1).click();
  await expect(page.getByTestId("v12-join-plan").nth(1)).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("v12-join-continue").click();
  await expect(page).toHaveURL(new RegExp(`/signup\\?invite=${fresh.code}&workspace=North%20Quay%20Films$`), { timeout: 30_000 });
  await expect(page.getByTestId("signup-workspace")).toHaveValue("North Quay Films", { timeout: 30_000 });

  /* A used invite: the banner and the sheet say so, and Request access is the way on. */
  await page.goto(`${HOME}&invite=${usedTeam.code}`);
  await expect(page.getByTestId("v12-invite-banner")).toContainText("This invite has expired or been used", { timeout: 60_000 });
  await expect(page.getByTestId("v12-join-title")).toHaveText("This invite has expired");
  await expect(page.getByTestId("v12-join-expired")).toContainText("This invite has expired or been used.");
  await page.getByTestId("v12-join-expired-request").click();
  await expect(page.getByTestId("v12-join-request")).toBeVisible();
});

test("phones: the visitor's Home is the phone's own — Log in and Request access, a two-column wall, How it works, a bottom sheet with Continue with email", async ({ page }, info) => {
  test.skip(!phone(info), "phone sizes");
  const seen = apiLog(page);
  await page.goto(HOME);
  await expect(page.getByTestId("v12-visitor-home")).toBeVisible({ timeout: 60_000 });
  const header = page.getByTestId("v12-visitor-header");
  await expect(header.getByTestId("v12-visitor-login")).toBeVisible();
  await expect(header.getByTestId("v12-visitor-request")).toBeVisible();
  for (const target of [header.getByTestId("v12-visitor-login"), header.getByTestId("v12-visitor-request"), page.getByTestId("v12-visitor-start")]) {
    const box = (await target.boundingBox())!;
    expect(box.height, "a touch target").toBeGreaterThanOrEqual(43.5);
    expect(box.width, "a touch target").toBeGreaterThanOrEqual(43.5);
  }
  await expect(page.getByTestId("v12-visitor-title")).toHaveText("Made with Particl");
  await expect(page.getByTestId("v12-visitor-how")).toContainText("Describe it");
  await noOverflow(page, "phone Home");
  await page.getByTestId("v12-visitor-bar-input").fill("A 30 s ad for a tea brand");
  await page.getByTestId("v12-visitor-start").click();
  const s = sheet(page);
  await expect(s).toHaveAttribute("data-variant", "sheet");
  await expect(page.getByTestId("v12-join-title")).toHaveText("To start a board you need a Particl account");
  await expect(page.getByTestId("v12-join-email")).toBeVisible();
  await expect(page.getByTestId("v12-join-google")).toBeVisible();
  for (const id of ["v12-join-name", "v12-join-work-email", "v12-join-company", "v12-join-role", "v12-join-size", "v12-join-want"]) await expect(page.getByTestId(id)).toBeAttached();
  await expect(page.getByTestId("v12-join-login")).toBeAttached();
  await expect(s).toContainText("Your work stays private to your workspace.");
  /* One column, inside the screen, clear of the bottom edge. */
  const box = (await s.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1.5);
  const invite = (await page.getByTestId("v12-join-invite").boundingBox())!;
  const request = (await page.getByTestId("v12-join-request").boundingBox())!;
  expect(request.y, "the request form is under the invite: one column").toBeGreaterThan(invite.y + invite.height - 1);
  await noOverflow(page, "phone sheet");
  await page.keyboard.press("Escape");
  await expect(s).toHaveCount(0);
  await expect(page.getByTestId("v12-visitor-bar-input")).toHaveValue("A 30 s ad for a tea brand");
  expect(stray(seen)).toEqual([]);
});
