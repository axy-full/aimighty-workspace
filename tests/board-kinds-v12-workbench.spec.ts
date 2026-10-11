import { test, expect, type Page, type Route } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { openBoard } from "./helpers/boardV12";
import type { Project } from "../lib/workbench/studio";

/**
 * Board kinds and the new-board flow in the new interface (docs/redesign-plan.md P2-a; components/v12/board/NewBoard.tsx,
 * lib/v12/board/kinds.ts): the kind label cycles Film, Pre-vis, Campaign, Social narrated and clips, with the rail changing
 * and the cards kept, all in the draft; "New board" is a tab of its own (`?view=board&newboard=1`): "What are we making?",
 * kind cards that switch the rail at once, the words suggest a kind, and Start makes the board through today's create path
 * and asks Atomik once at the figure on the button. Atomik's thinking (agent.plan) is answered here by a fixture and counted:
 * nothing is generated or spent.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const NEW_BOARD = "/suites?view=board&newboard=1";
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const rows = (page: Page) => page.getByTestId("v12-stage-row");
const labels = (page: Page) => rows(page).evaluateAll((els) => els.map((el) => el.querySelector(".v12-rail-label")?.textContent ?? ""));

/** The server's figure for a new board: read, never spent. */
async function figureOf(page: Page, scope: string): Promise<number> {
  const reply = await page.request.get("/api/workbench/team-canvas?agent=1&board=new", { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json());
  expect(reply.agent).toMatchObject({ enabled: true });
  expect(reply.agent.ask.planning).toBeGreaterThan(0);
  return reply.agent.ask.planning as number;
}

/** Records what Start sends: the projects saved and Atomik's asks, which are answered by a fixture. */
function watch(page: Page) {
  const asks: Record<string, unknown>[] = [];
  const puts: Project[] = [];
  const paid: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === "PUT" && path === "/api/workbench/projects") puts.push((r.postDataJSON() as { project: Project }).project);
    if (r.method() !== "GET" && /^\/api\/(generate|audio|soul|jobs)/.test(path)) paid.push(`${r.method()} ${path}`);
  });
  return page.route((url) => url.pathname === "/api/workbench/team-canvas", (route: Route) => {
    const request = route.request();
    if (request.method() === "POST" && (request.postDataJSON() as { action?: string }).action === "agent.plan") {
      asks.push(request.postDataJSON());
      return route.fulfill({ status: 202, json: { agent: { enabled: true, run: null, ask: null } } });
    }
    return route.fallback();
  }).then(() => ({ asks, puts, paid }));
}

/** Atomik is on for a paying plan: the fixture workspace moves to Studio (local database only). */
async function studioPlan(page: Page) {
  const me = await page.request.get("/api/me").then((r) => r.json()) as { workspace: { id: string } };
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [me.workspace.id] }); } finally { db.close(); }
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("the kind label cycles the kind: the rail changes, the cards are kept, the draft keeps it, Undo puts it back", async ({ page }) => {
    const { errors } = await openBoard(page, "/suites?view=board&stage=storyboard");
    await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
    const kind = page.getByTestId("v12-stage-kind");
    await expect(kind).toHaveText("FILM");
    const saved = () => page.waitForResponse((r) => r.url().includes("/api/workbench/projects") && r.request().method() === "PUT" && r.ok(), { timeout: 30_000 });

    let put = saved();
    await kind.click();
    await put;
    await expect(kind).toHaveText("PRE-VIS");
    expect(await labels(page)).toEqual(["Brief", "Script", "Cast", "Elements", "Storyboard", "Animatic", "PPM deck"]);
    await expect(page.getByTestId("toast")).toContainText("Board kind · Pre-vis · the rail changed; your cards are kept");
    /* The storyboard's frames are still there: the kind changed the rail, not the work. */
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Storyboard");
    await expect(page.getByTestId("v12-stage-empty")).toHaveCount(0);

    /* Undo puts the kind and the rail back. */
    await page.getByTestId("toast-undo").click();
    await expect(kind).toHaveText("FILM");
    expect(await rows(page).count()).toBe(8);

    /* Round the kinds: Pre-vis, Campaign, Social · narrated, Social · clips. */
    const want: [string, string[]][] = [
      ["PRE-VIS", ["Brief", "Script", "Cast", "Elements", "Storyboard", "Animatic", "PPM deck"]],
      ["CAMPAIGN", ["Product", "Look", "Formats", "Variants", "Deliver"]],
      ["SOCIAL · NARRATED", ["Hook", "Script", "Scenes", "Voice", "Captions", "Deliver"]],
      ["SOCIAL · CLIPS", ["Source", "Moments", "Clips", "Captions", "Deliver"]],
    ];
    for (const [label, stages] of want) {
      put = saved();
      await kind.click();
      await put;
      await expect(kind).toHaveText(label);
      expect(await labels(page), label).toEqual(stages);
      expect(await noSideways(page), `${label}: no sideways scroll`).toBe(true);
    }
    /* The draft keeps it: a reload opens the same kind. */
    await page.reload();
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("SOCIAL · CLIPS", { timeout: 60_000 });
    expect(await labels(page)).toEqual(["Source", "Moments", "Clips", "Captions", "Deliver"]);
    /* And back to Film: the Film board's own cards are still on it. */
    put = saved();
    await page.getByTestId("v12-stage-kind").click();
    await put;
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("FILM");
    await page.locator('[data-testid="v12-stage-row"][data-stage="cast"] .v12-rail-btn').click();
    await expect(page.getByTestId("board")).toHaveAttribute("data-stage", "cast");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("New board: its own tab, what are we making, kind cards switch the rail at once (dimmed), words suggest a kind, Start with nothing says so", async ({ page }) => {
    const { errors } = await openBoard(page, NEW_BOARD);
    const sent = await watch(page);
    const nb = page.getByTestId("v12-newboard");
    await expect(nb).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-newboard-title")).toHaveText("What are we making?");
    await expect(page.getByTestId("v12-board-crumb")).toHaveText("New board");
    await expect(page.getByTestId("v12-stage-primary")).toHaveCount(0);
    await expect(page.getByTestId("v12-board-menu")).toHaveCount(0);
    await expect(page.getByTestId("v12-stage-rail")).toHaveAttribute("data-dim", "true");
    await expect(page.getByTestId("board")).toHaveCount(0);

    const cases: [string, string, string, string[]][] = [
      ["film", "Describe the film", "FILM", ["Brief", "Script", "Cast", "Elements", "Storyboard", "Shots", "Cut", "Deliver"]],
      ["previs", "Paste or attach the agency script", "PRE-VIS", ["Brief", "Script", "Cast", "Elements", "Storyboard", "Animatic", "PPM deck"]],
      ["campaign", "Paste the product page link", "CAMPAIGN", ["Product", "Look", "Formats", "Variants", "Deliver"]],
      ["social", "A topic, or a long video link", "SOCIAL · NARRATED", ["Hook", "Script", "Scenes", "Voice", "Captions", "Deliver"]],
    ];
    for (const [id, title, label, stages] of cases) {
      await page.getByTestId(`v12-kind-${id}`).click();
      await expect(page.getByTestId("v12-newboard-title")).toHaveText(title);
      await expect(page.getByTestId("v12-stage-kind")).toHaveText(label);
      expect(await labels(page), id).toEqual(stages);
      await expect(page.getByTestId(`v12-kind-${id}`)).toHaveAttribute("aria-pressed", "true");
    }
    /* Social: a link or a video with no topic is clips. */
    await page.getByTestId("v12-newboard-text").fill("https://example.com/long-talk");
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("SOCIAL · CLIPS");
    /* Chips follow the kind. */
    await expect(page.locator('[data-testid="v12-newboard-chip"][data-chip="platform"]')).toHaveCount(3);
    await page.getByTestId("v12-kind-campaign").click();
    await expect(page.getByTestId("v12-newboard-chip")).toHaveCount(0);
    await page.getByTestId("v12-kind-film").click();
    await expect(page.locator('[data-testid="v12-newboard-chip"][data-chip="aspect"]')).toHaveCount(3);

    /* Nothing said: Start says so, and makes nothing. */
    await page.getByTestId("v12-newboard-text").fill("");
    await page.getByTestId("v12-newboard-start").click();
    await expect(page.getByTestId("v12-toast")).toHaveText("Describe it, or attach something");
    expect(sent.puts).toEqual([]);
    expect(sent.asks).toEqual([]);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("New board: typing without picking lets the words pick the kind, with a way to change it", async ({ page }) => {
    await openBoard(page, NEW_BOARD);
    await expect(page.getByTestId("v12-newboard")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-newboard-guess")).toHaveCount(0);
    await page.getByTestId("v12-newboard-text").fill("Ads for our new product page, with packshots");
    await expect(page.getByTestId("v12-newboard-guess")).toContainText("Looks like a Campaign");
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("CAMPAIGN");
    await page.getByTestId("v12-newboard-text").fill("The agency sent a script for a live-action shoot");
    await expect(page.getByTestId("v12-newboard-guess")).toContainText("Looks like a Pre-vis");
    await page.getByTestId("v12-newboard-change").click();
    await expect(page.getByTestId("v12-kind-film")).toBeFocused();
    /* Picking a card ends the guess. */
    await page.getByTestId("v12-kind-film").click();
    await expect(page.getByTestId("v12-newboard-guess")).toHaveCount(0);
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("FILM");
    /* Edit stages says where the rail is edited, and the rail is: a stage added before Start is not lost. */
    await page.getByTestId("v12-newboard-edit-stages").click();
    await expect(page.getByTestId("v12-toast")).toHaveText("Edit the stages on the rail: rename, drag, ⋯ to skip or remove, + Stage at the end");
  });

  test("Start: makes the board by today's create path with the kind and the rail, asks Atomik once at the figure on the button, opens on the first stage", async ({ page }) => {
    const { scope } = await openBoard(page, NEW_BOARD);
    await studioPlan(page);
    const figure = await figureOf(page, scope);
    const sent = await watch(page);
    await page.goto(`${NEW_BOARD}&pick=campaign`);
    await expect(page.getByTestId("v12-newboard-title")).toHaveText("Paste the product page link", { timeout: 60_000 });
    /* The button states Atomik's thinking, the server's figure, with dollars on hover. */
    const start = page.getByTestId("v12-newboard-start");
    await expect(start).toContainText(`Start · up to ${figure} cr`, { timeout: 30_000 });
    await expect(start.locator("[data-price]")).toHaveAttribute("title", /\$/);
    /* A stage renamed on the rail before Start is kept. */
    const row = page.locator('[data-testid="v12-stage-row"][data-stage="look"]');
    await row.hover();
    await page.getByRole("button", { name: "Rename Look" }).click();
    await page.getByTestId("v12-stage-rename").fill("Brand look");
    await page.getByTestId("v12-stage-rename").press("Enter");
    await expect(row).toContainText("Brand look");

    await page.getByTestId("v12-newboard-text").fill("Ads for our new tea, from the product page.");
    await start.click();
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("CAMPAIGN", { timeout: 60_000 });
    await expect(page.getByTestId("board")).toHaveAttribute("data-board-kind", "ads");
    expect(sent.puts.filter((p) => p.boardFlavor)).toHaveLength(1);
    const made = sent.puts.find((p) => p.boardFlavor)!;
    expect(made).toMatchObject({ name: "Ads for our new · campaign", boardKind: "ads", boardFlavor: "campaign", brief: "Ads for our new tea, from the product page.", aspect: "16:9" });
    expect(made.boardStages).toEqual([{ id: "product" }, { id: "look", label: "Brand look" }, { id: "formats" }, { id: "variants" }, { id: "deliver" }]);
    expect(sent.asks).toHaveLength(1);
    expect(sent.asks[0]).toMatchObject({ action: "agent.plan", projectId: made.id, limit: figure, mode: "ask" });
    expect(sent.paid, "only Atomik's thinking at the pressed limit; nothing generated").toEqual([]);
    /* The board opens on its first stage with the renamed rail. */
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Product");
    expect(await labels(page)).toEqual(["Product", "Brand look", "Formats", "Variants", "Deliver"]);
    expect(new URL(page.url()).searchParams.get("newboard")).toBeNull();
  });

  test("Start with a kind the words picked says so; the high-water sizes have no sideways scroll", async ({ page }) => {
    const { scope } = await openBoard(page, NEW_BOARD);
    await studioPlan(page);
    await figureOf(page, scope);
    const sent = await watch(page);
    await page.goto(NEW_BOARD);
    await expect(page.getByTestId("v12-newboard-start")).toContainText("Start · up to", { timeout: 60_000 });
    await page.getByTestId("v12-newboard-text").fill("A topic: why the tide turns twice a day");
    await page.getByTestId("v12-newboard-start").click();
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("SOCIAL · NARRATED", { timeout: 60_000 });
    const made = sent.puts.find((p) => p.boardFlavor)!;
    expect(made).toMatchObject({ boardKind: "social", boardFlavor: "narrated", aspect: "9:16", deliverables: "Reels · 30 s" });
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Hook");
    expect(await noSideways(page)).toBe(true);
  });
});

test.describe("switch off and phones", () => {
  test("switch off: the address means nothing and today's board shows", async ({ page }, info) => {
    test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
    await openBoard(page, NEW_BOARD, { on: false });
    await expect(page.getByTestId("board-rail")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-newboard")).toHaveCount(0);
  });

  test("phones keep today's app: no new-board screen, no sideways scroll", async ({ page }, info) => {
    test.skip(!PHONE.includes(info.project.name), "phone sizes");
    await openBoard(page, NEW_BOARD);
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-newboard")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });
});
