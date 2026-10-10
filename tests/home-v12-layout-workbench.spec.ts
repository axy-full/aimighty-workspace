import { test, expect, type Page } from "@playwright/test";
import type { QueueItem } from "../lib/control-room/queue";
import { seedHome } from "./helpers/v12Home";

/**
 * Home in the new interface, the three layout rules its review found (redesign C2): the Waiting strip never clips an item's
 * action, whatever the names and the width; the last row of boards clears the bar, however tall the bar is (a picked tile's
 * sheet, a note); and the words a picked tile fades stay readable (rule 15). A name is cut at a word by the code, never
 * by the stylesheet. Local ENGINE_MOCK server; the approvals queue is answered here, so nothing is approved for real.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];

const LONG = "Keyframe retake for the opening sequence over the harbour at first light with the slow push-in";
const PLACE = "Opening sequence of the harbour film, second pass over the whole sequence";
const item = (id: string, title: string, credits: number): QueueItem => ({
  id, title, source: "held", where: PLACE, at: Date.now() - 5 * 60_000,
  project: { productionId: "prod-x", draftId: null, name: "The long-named harbour film with a second cut" },
  price: { kind: "exact", credits }, needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "release", genId: id, credits }, decline: null, open: { kind: "take", genId: id, draftId: null },
});

/** Every cut word-list on the page: whole, or cut at a word (what is left is the start of the full words, and the next letter of them is a space). */
async function cutsAtWords(page: Page, selector: string) {
  return page.$$eval(selector, (els) => els.map((el) => {
    const shown = (el.textContent ?? "").replace(/^·\s*/, "");
    const full = (el.getAttribute("title") ?? "").replace(/^·\s*/, "") || shown;
    const style = getComputedStyle(el);
    const cut = shown.endsWith("…");
    const head = cut ? shown.slice(0, -1) : shown;
    const ok = !cut || (full.startsWith(head) && !/[\p{L}\p{N}]/u.test(full.charAt(head.length)));
    return { shown, ok, ellipsisCss: style.textOverflow === "ellipsis", fits: el.scrollWidth <= el.clientWidth + 1 };
  }));
}

async function openHome(page: Page, items: QueueItem[], takes = 6) {
  await seedHome(page, { takes });
  await page.route((url) => url.pathname === "/api/control-room/approvals", (route) => route.fulfill({ json: { items, decided: [], inCredits: true } }));
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("v12-home")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-home-tile")).toHaveCount(takes, { timeout: 60_000 });
}

test("the Waiting strip keeps every item's action whole and counts what it does not show; names are cut at a word, never by CSS", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  const queue = [item("held:a", LONG, 3), item("held:b", `${LONG} again`, 7), item("held:c", "Wide shot", 2), item("held:d", "Hero take", 5)];
  await openHome(page, queue);
  const strip = page.getByTestId("v12-home-waiting");
  await expect(strip).toBeVisible();
  const check = async (label: string) => {
    const list = await page.locator(".v12-hm-wait-items").evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    const shown = page.getByTestId("v12-home-waiting-item");
    const n = await shown.count();
    expect(n, `${label}: at least one item`).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < n; i++) {
      const chip = await shown.nth(i).locator(".v12-hm-chip-btn").boundingBox();
      expect(chip, `${label}: item ${i} action`).not.toBeNull();
      expect(chip!.x, `${label}: item ${i} action starts inside the strip`).toBeGreaterThanOrEqual(list.left - 1);
      expect(chip!.x + chip!.width, `${label}: item ${i} action ends inside the strip, whole`).toBeLessThanOrEqual(list.right + 1);
    }
    /* "+N more" counts exactly the items not drawn. */
    const more = page.getByTestId("v12-home-waiting-more");
    if (queue.length - n > 0) await expect(more, label).toHaveText(`+${queue.length - n} more`);
    else await expect(more, label).toHaveCount(0);
    await expect(page.getByTestId("v12-home-waiting-count")).toHaveText(String(queue.length));
    for (const selector of [".v12-hm-wait-name", ".v12-hm-wait-where"]) {
      for (const cut of await cutsAtWords(page, selector)) {
        expect(cut.ellipsisCss, `${label}: ${cut.shown} is not cut by the stylesheet`).toBe(false);
      }
    }
    /* A name that is cut ends at a word: what is shown is the start of the whole name (the button's own label), at a space. */
    const names = await page.$$eval(".v12-hm-wait-open", (els) => els.map((el) => ({
      label: (el.getAttribute("aria-label") ?? "").split(" · ")[0],
      shown: (el.querySelector(".v12-hm-wait-name")?.textContent ?? ""),
    })));
    for (const name of names) {
      const head = name.shown.endsWith("…") ? name.shown.slice(0, -1) : name.shown;
      expect(name.label.startsWith(head), `${label}: ${name.shown}`).toBe(true);
      if (name.shown.endsWith("…")) expect(/[\p{L}\p{N}]/u.test(name.label.charAt(head.length)), `${label}: cut at a word: ${name.shown}`).toBe(false);
    }
  };
  await check("at this size");
  /* A narrower window changes what fits, and the strip follows. */
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1180, height: size.height });
  await check("at 1180 wide");
  await page.setViewportSize({ width: 900, height: size.height });
  await check("at 900 wide");
  await page.setViewportSize(size);
  await check("back at this size");
});

test("the wall's tile words are cut at a word by the code, and a faded tile's words and the dimmed boards' words stay readable", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  await openHome(page, []);
  const tiles = page.getByTestId("v12-home-tile");
  for (const selector of [".v12-hm-tile-title", ".v12-hm-tile-type", ".v12-hm-board-name"]) {
    for (const cut of await cutsAtWords(page, selector)) {
      expect(cut.ellipsisCss, `${selector}: ${cut.shown} is not cut by the stylesheet`).toBe(false);
      expect(cut.fits, `${selector}: ${cut.shown} fits its room`).toBe(true);
      expect(cut.ok, `${selector}: ${cut.shown} is cut at a word`).toBe(true);
    }
  }
  /* Pick one: the rest fade and the boards dim; every word stays at least 55% white and 12 px. */
  await tiles.first().getByTestId("v12-home-tile-pick").click();
  await expect(tiles.nth(1)).toHaveAttribute("data-faded", "");
  await page.mouse.move(2, 2);
  const weak = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".v12-hm-tile-type, .v12-hm-tile-title, .v12-hm-board-name, .v12-hm-board-state, .v12-hm-section-title, .v12-hm-filter")) {
      let alpha = 1;
      for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) alpha *= Number(getComputedStyle(n).opacity);
      const colour = getComputedStyle(el).color.match(/[\d.]+/g)!.map(Number);
      alpha *= colour.length > 3 ? colour[3] : 1;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (alpha < 0.55 || size < 12) out.push(`${el.className} "${(el.textContent ?? "").slice(0, 24)}": alpha ${alpha.toFixed(2)}, ${size}px`);
    }
    return out;
  });
  expect(weak, "readable text is at least 55% white and 12 px").toEqual([]);
});

test("the last row of boards clears the bar: with a tile picked, with a note, and in a short window", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  await openHome(page, [item("held:a", "Keyframe retake", 3)]);
  /* A short window, so the page scrolls and the bar is over its foot. */
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: 620 });
  const clear = async (label: string) => {
    await page.evaluate(() => { const s = document.querySelector(".v12-hm-scroll")!; s.scrollTop = s.scrollHeight; });
    const bar = await page.locator(".v12-hm-bar").boundingBox();
    const cards = await page.getByTestId("v12-home-board").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom));
    expect(cards.length, label).toBeGreaterThan(0);
    expect(Math.max(...cards), `${label}: the last board ends above the bar's top`).toBeLessThanOrEqual(bar!.y - 20);
    /* And the bar's own measure is what the page leaves: no more than a little extra. */
    const pad = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector(".v12-hm-scroll")!).paddingBottom));
    expect(pad, `${label}: room under the page follows the bar`).toBeGreaterThanOrEqual(bar!.height + 20 + 24 - 1);
  };
  await clear("plain");
  await page.getByTestId("v12-home-tile").first().getByTestId("v12-home-tile-pick").click();
  await expect(page.getByTestId("v12-home-sheet")).toBeVisible();
  await clear("a tile picked (the sheet is over the bar)");
  /* A file the bar cannot use leaves a note under it. */
  await page.getByTestId("v12-home-bar-attach-input").setInputFiles({ name: "notes.bin", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
  await expect(page.getByTestId("v12-home-bar-note")).toBeVisible();
  await clear("a tile picked and a note under the bar");
  /* Every board card is reachable: it can be scrolled above the bar and clicked. */
  const last = page.getByTestId("v12-home-board").last();
  await last.scrollIntoViewIfNeeded();
  const box = await last.boundingBox();
  const bar = await page.locator(".v12-hm-bar").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y + 1);
});
