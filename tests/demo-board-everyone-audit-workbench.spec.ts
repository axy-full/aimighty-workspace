import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { FILLED } from "./helpers/s11-board";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { newProject } from "../lib/workbench/studio";
import { node } from "./helpers/s03-board";

/**
 * The board is the whole production for every workspace (owner, 5 Oct night): Studio, Ads and Social are one board, with the switch OFF.
 * What that board owes (README § 1.1, § 5): the bottom tool row (Select, Frame, Note, Text, Image, Video, Audio, Upload) wherever the
 * canvas shows; every paid action shows its credit price ("N cr", "up to N cr" or "free"); a "Not in Particl yet" section shows no
 * price and no button that spends. Local ENGINE_MOCK server. Nothing is generated and no paid button is pressed.
 */
const KINDS = [
  { kind: "studio", query: "" },
  { kind: "ads", query: "&kind=ads" },
  { kind: "social", query: "&kind=social" },
] as const;
const TOOLS = ["Select", "Frame", "Note", "Text", "Image", "Video", "Audio", "Upload"];
/** What a button that spends is called. Its label carries the price, or it is not enabled. */
const SPENDS = /\b(make|render|generate|run|approve|release|retry|recreate|again|upscale|transcribe|send|start|storyboard|write|redraft|build|train|verify|apply)\b/i;
const PRICE = /(\d[\d,.]*\s?cr\b|\bfree\b|up to \d)/i;

const compact = (page: Page) => page.evaluate(() => window.matchMedia("(max-width: 767px), (min-width: 768px) and (max-height: 500px) and (pointer: coarse)").matches);

async function seed(page: Page, kind: "studio" | "ads" | "social") {
  const workspaceId = (await signInLocally(page.request, "Board Audit")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const base = newProject("Audit fixture");
  const project = {
    ...base, brief: "A short film about a morning market opening.", boardKind: kind,
    nodes: kind === "studio" ? [node("node-brief01", "brief", "The brief", { text: "A morning market opens." }), node("node-shot0001", "scene", "Opening wide", { text: "Wide on the empty market." })] : [],
    ...(kind === "ads" ? { moleculr: { ...EMPTY_MOLECULR, ...FILLED } } : {}),
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 2000, "Audit fixture", "manual", "test", 0] });
  } finally { db.close(); }
  const paid: string[] = [];
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || (path.startsWith("/api/generate/") && !path.endsWith("/quote")))) paid.push(path);
  });
  return { project, paid, problems };
}

for (const { kind, query } of KINDS) {
  test(`${kind} board, switch off: the tool row, a price on every button that spends, and no price in a Not in Particl yet section`, async ({ page }, info) => {
    test.setTimeout(240_000);
    const { project, paid, problems } = await seed(page, kind);
    await page.goto(`/suites?project=${project.id}&view=board${query}`);
    await expect(page.locator(".gx")).toHaveAttribute("data-interface", "old", { timeout: 90_000 });
    await expect(page.getByTestId("board")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("board")).toHaveAttribute("data-board-kind", kind, { timeout: 60_000 });
    const phone = await compact(page);

    if (!phone) {
      /* Eight tools, in the design's order, always there on the canvas. */
      const row = page.getByTestId("board-tools");
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row.getByRole("button")).toHaveCount(8);
      const names = await row.getByRole("button").evaluateAll((els) => els.map((el) => (el.getAttribute("aria-label") ?? "").replace(/ \(.*\)$/, "")));
      expect(names).toEqual(TOOLS);
      const box = (await row.boundingBox())!, view = page.viewportSize()!;
      expect(box.x, "the tool row inside the screen").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, "the tool row inside the screen").toBeLessThanOrEqual(view.width + 0.5);
      expect(box.y + box.height, "the tool row above the bottom edge").toBeLessThanOrEqual(view.height + 0.5);
      await expect(page.getByTestId("board-rail")).toBeVisible();
    }

    /* Every button on the board that spends shows its price (or is not pressable). */
    const buttons = await page.getByTestId("board").getByRole("button").evaluateAll((els) => els
      .filter((el) => (el as HTMLElement).getClientRects().length && el.getAttribute("aria-disabled") !== "true" && !(el as HTMLButtonElement).disabled)
      .map((el) => ({ name: ((el.getAttribute("aria-label") ?? "") + " " + (el.textContent ?? "")).replace(/\s+/g, " ").trim(), testId: el.getAttribute("data-testid") ?? "" })));
    await info.attach(`buttons-${kind}.json`, { body: JSON.stringify(buttons, null, 2), contentType: "application/json" });
    const unpriced = buttons.filter((b) => SPENDS.test(b.name.split(" · ")[0]) && !PRICE.test(b.name));
    /* A button that only opens something (Make opens its panel, the agent plans) names no figure of its own: the panel shows the price on its own button. */
    const opens = unpriced.filter((b) => !/^(Make|Write|Start|Send|Build|Apply|Run|Generate|Render|Approve|Retry|Verify|Release)\b.*(open|plan|panel|in Make|card|region|reference|list|library)/i.test(b.name));
    expect(opens.map((b) => b.name), `${kind}: enabled buttons that spend with no price`).toEqual([]);

    /* A "Not in Particl yet" section shows no price and has no button that spends. */
    const sections = page.getByTestId("board").locator(":is([data-card-kind$='-unavailable'], [data-card-kind='ads-unavailable'], [data-card-kind='social-unavailable'])");
    const count = await sections.count();
    for (let i = 0; i < count; i++) {
      const section = sections.nth(i);
      await expect(section).toContainText("Not in Particl yet");
      await expect(section.locator("[data-price]"), "no price").toHaveCount(0);
      const text = (await section.innerText()).replace(/\s+/g, " ");
      expect(text, "no credit figure").not.toMatch(/\d\s?cr\b/i);
      const live = await section.getByRole("button").evaluateAll((els) => els.filter((el) => el.getAttribute("aria-disabled") !== "true" && !(el as HTMLButtonElement).disabled).map((el) => el.textContent?.trim() ?? ""));
      expect(live.filter((name) => SPENDS.test(name)), "no button that spends").toEqual([]);
    }
    if (kind !== "studio") expect(count, `the ${kind} board has Not in Particl yet sections`).toBeGreaterThan(0);

    expect(paid, "no paid request").toEqual([]);
    expect(problems).toEqual([]);
  });
}

test("Make over the board shows its price on its own button", async ({ page }) => {
  test.setTimeout(240_000);
  const { project, paid, problems } = await seed(page, "studio");
  await page.goto(`/suites?project=${project.id}&view=board&make=video`);
  await expect(page.getByTestId("make-panel")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("board")).toBeVisible();
  const go = page.getByTestId("gen-generate");
  await hydrated(go);
  await page.getByTestId("gen-prompt").fill("A fox crosses a frozen harbour at dusk.");
  /* The button says what it costs, in credits, before anything is sent. */
  await expect(go).toHaveText(/\d[\d,.]* cr/, { timeout: 90_000 });
  expect(paid, "nothing was sent: the button was not pressed").toEqual([]);
  expect(problems).toEqual([]);
});

async function hydrated(locator: ReturnType<Page["getByTestId"]>) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps")))).toBe(true);
}
