import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";

/**
 * Idea 12, first slice: a Next row on every take — in the Inspector and on
 * the selected take in Takes — that opens the existing tool on it: Re-edit
 * for a still, Seedance Edit for a clip, Edit & Sound for a sound. Navigation
 * only: no price on the row, and nothing that could spend is sent until the
 * tool's own priced button is pressed (the desk's own automatic quotes are
 * read-only, and charge nothing). Every reply is route-mocked.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const fixture = (saved = true): Project => ({ ...newProject("Next steps"), id: "ws-next", ...(saved ? { productionProjectId: "prod-next" } : {}), shotMappings: {} });
const store = () => ({
  generations: [
    generation({ id: "gen_still", title: "Pier at dusk", prompt: "a pier at dusk" }),
    generation({ id: "gen_clip", title: "Ferry turning", prompt: "the ferry turns", kind: "video" }),
    generation({ id: "gen_voice", title: "Keeper's line", prompt: "the storm is coming", kind: "audio", model: "eleven_v3" }),
    generation({ id: "gen_failed", title: "Night swim", status: "failed", storedUrl: null, error: "Refused by the content filter." }),
  ],
  uploads: [upload({ id: "up_script", filename: "the-crossing.pdf", mime: "application/pdf", kind: "file", width: 0, height: 0 })],
});

async function open(page: Page, url: string, saved = true) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture(saved) });
  await mockLibrary(page, store());
  /* Anything that could spend is counted: navigating to a tool must send none of it. A read-only quote (the quote route, or a
     `quoteOnly` body — the desk prices its own tools on sight) charges nothing, and is kept apart to prove it is only that. */
  const sent: string[] = [], quotes: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" || !/^\/api\/(generate|audio|jobs\/[^/]+\/retry|higgsfield)/.test(path)) return;
    let body: { quoteOnly?: unknown } | null = null;
    try { body = request.postDataJSON() as { quoteOnly?: unknown } | null; } catch { body = null; }
    if (path === "/api/generate/quote" || body?.quoteOnly === true) quotes.push(path); else sent.push(`${request.method()} ${path}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId("project-name")).toHaveText("Next steps");
  return { sent, quotes, errors };
}
const assets = async (page: Page, info: TestInfo) => {
  if (!WIDE.includes(info.project.name)) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
};
const tile = (page: Page, id: string) => page.getByTestId("library").locator(`.gx-asset-thumb[data-ctx='asset:${id}']`);
/**
 * The functional labels in `scope` that read dimmer than #7C7C84 as they land on the screen, not as they are written. A port
 * of the alpha-aware dimLabels in the phone chrome change, kept in this spec so the two don't collide: tests/phoneFloors.ts's
 * dimLabels reads only a colour's RGB here, so a .45 white passed it. The colour's alpha and any opacity on the label or
 * above it are composited over the ground: each translucent background colour above the label, down to the first opaque
 * one. One step stricter than that port: where a layer's paint is not one flat colour (a gradient card, the wallpaper,
 * a translucent layer), black stands in for everything under it, the darkest ground there is, so the estimate is
 * never brighter than the screen.
 */
async function labelsUnderFloor(page: Page, scope: string): Promise<string[]> {
  return page.evaluate(async (scope) => {
    /* At rest: an entrance still fading in (the shell's gx-enter, an overlay's gx-in) is not how the label reads. Loops are left as they are. */
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)));
    const labels = Array.from(document.querySelectorAll<HTMLElement>(scope)).flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("[data-functional-label]")));
    if (!labels.length) return [`no functional label in ${scope}`];
    type Rgba = { r: number; g: number; b: number; a: number };
    /* rgb()/rgba() in 0–255, or color(srgb …) in 0–1 (how Chromium writes a color-mix()). */
    const parse = (color: string): Rgba | null => {
      const srgb = color.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+))?\)$/);
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] == null ? 1 : Number(srgb[4]) };
      const rgb = color.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
      if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] == null ? 1 : Number(rgb[4]) };
      return color === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
    };
    const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const luminance = (c: Rgba) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const ground = (el: HTMLElement): Rgba => {
      const layers: Rgba[] = [];
      for (let up = el.parentElement; up; up = up.parentElement) {
        const style = getComputedStyle(up);
        /* A gradient or an image paints over this layer's own colour: black for it and everything under it. */
        if (style.backgroundImage !== "none") break;
        const bg = parse(style.backgroundColor);
        if (bg && bg.a > 0) layers.push(bg);
        /* An opaque colour ends the ground; a translucent layer keeps its tint, over black. */
        if (bg && bg.a >= 1) break;
      }
      return layers.reverse().reduce((under, layer) => over(layer, under), { r: 0, g: 0, b: 0, a: 1 });
    };
    const opacity = (el: HTMLElement) => {
      let o = 1;
      for (let up: HTMLElement | null = el; up; up = up.parentElement) o *= Number(getComputedStyle(up).opacity);
      return o;
    };
    /* #7C7C84 itself, computed the same way, is the floor. */
    const floor = 0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5;
    const out: string[] = [];
    for (const el of labels) {
      if (!el.getClientRects().length) continue;
      const style = getComputedStyle(el);
      /* A badge with its own background owns its own contrast; text painted by a gradient is not its `color`. */
      if (!/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(style.backgroundColor)) continue;
      if (style.backgroundClip === "text" || style.getPropertyValue("-webkit-background-clip") === "text") continue;
      const ink = parse(style.color);
      if (!ink) { out.push(`${el.className || el.tagName}: unreadable colour ${style.color}`); continue; }
      const seen = over({ ...ink, a: ink.a * opacity(el) }, ground(el));
      if (luminance(seen) < floor)
        out.push(`${el.className || el.tagName}: ${style.color} (reads ${[seen.r, seen.g, seen.b].map(Math.round).join(", ")}) — “${(el.textContent ?? "").trim().slice(0, 24)}”`);
    }
    return out;
  }, scope);
}

/** Thumb-sized, labelled at the floor, inside the screen, and clear of the phone's tab bar. */
async function rowFloors(page: Page, info: TestInfo, row: ReturnType<Page["getByTestId"]>, where: string) {
  const box = (await row.boundingBox())!;
  expect(box.x + box.width, `${where}: the row inside the screen`).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  /* The label floor at every size, on this ground. And the measure sees alpha: the eyebrow's .45 ink, which this row's
     label first shipped with, is caught here. */
  const scope = `${where} [data-testid="next-actions"]`;
  expect(await labelsUnderFloor(page, scope), `${where}: labels under #7C7C84`).toEqual([]);
  const label = row.locator("[data-functional-label]");
  await label.evaluate((el) => el.style.setProperty("color", "rgba(235, 235, 245, 0.45)"));
  expect(await labelsUnderFloor(page, scope), `${where}: a .45 label is caught`).toEqual([expect.stringMatching(/reads .*“Next”$/)]);
  await label.evaluate((el) => el.style.removeProperty("color"));
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, scope), `${where}: Next under 44×44`).toEqual([]);
    const bar = page.getByTestId("tabbar");
    if (await bar.isVisible()) {
      /* Centred, the row clears the bar. The desk's own smooth move to the take it opened may still be running, and it
         carries the page on to where it was going, so the row is centred again until that move is over. */
      await expect.poll(async () => {
        await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
        const [after, barBox] = [(await row.boundingBox())!, (await bar.boundingBox())!];
        return after.y + after.height - barBox.y;
      }, { message: `${where}: the row clears the tab bar` }).toBeLessThanOrEqual(0.5);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  /* With NEXT_SHOTS_DIR set, a picture of the row where it is. */
  if (process.env.NEXT_SHOTS_DIR) await page.screenshot({ path: `${process.env.NEXT_SHOTS_DIR}/next-${where.includes("inspector") ? "inspector" : "desk"}-${info.project.name.replace("workbench-", "")}.png` });
}

test("the Inspector's Next opens each take's own place on the board — Shots for a still and a clip, Cut for a sound — and nothing that could spend is sent", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { sent, quotes, errors } = await open(page, "/suites?suite=atomik&page=agent&sp=agent");
  await assets(page, info);
  await tile(page, "generation:gen_still").click();
  const inspector = page.getByTestId("inspector");
  const next = inspector.getByTestId("next-actions");
  /* The tool it opens, then the priced actions (tests/suites-next-actions-priced-workbench.spec.ts): no price on the row itself. */
  await expect(next.getByRole("button")).toHaveText(["Re-edit ›", "Upscale", "Outpaint", "Animate"]);
  await expect(next).not.toContainText(/\d|credit/i);
  await rowFloors(page, info, next, '[data-testid="inspector"]');
  /* The Takes page is deleted: the tool opens where the take is, on the board's Shots region, with that take selected. */
  const onBoard = async (asset: string) => {
    await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
    await expect.poll(() => { const q = new URL(page.url()).searchParams; return [q.get("view"), q.get("region"), q.get("asset")]; }).toEqual(["board", "shots", asset]);
  };
  await next.getByTestId("next-re-edit").click();
  await onBoard("generation:gen_still");

  /* A clip, from the Library again: its Seedance Edit opens on it, the same way. */
  await page.goto("/suites?suite=atomik&page=agent&sp=agent");
  await assets(page, info);
  await tile(page, "generation:gen_clip").click();
  await expect(page.getByTestId("inspector").getByTestId("next-actions").getByRole("button")).toHaveText(["Edit ›", "Upscale", "Reframe", "Extend"]);
  await page.getByTestId("inspector").getByTestId("next-edit").click();
  await onBoard("generation:gen_clip");

  /* A sound: Edit & Sound opens — the row says what opens, nothing more. It is the Cut region. */
  await page.goto("/suites?suite=atomik&page=agent&sp=agent");
  await assets(page, info);
  await tile(page, "generation:gen_voice").click();
  /* What no engine here does for a sound is listed, not offered, and says why. */
  await expect(page.getByTestId("inspector").getByTestId("next-actions").getByRole("button")).toHaveText(["Edit & Sound ›", "Upscale", "Extend"]);
  await expect(page.getByTestId("inspector").getByTestId("next-not-offered")).toHaveText("Upscale and Extend are not offered: no engine Particl uses upscales or extends sound.");
  await page.getByTestId("inspector").getByTestId("next-edit-sound").click();
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  await expect.poll(() => { const q = new URL(page.url()).searchParams; return [q.get("view"), q.get("region")]; }).toEqual(["board", "cut"]);
  expect(sent, "nothing that could spend on the way to a tool").toEqual([]);
  expect(quotes.every((path) => path === "/api/generate/quote" || path === "/api/audio/transcribe"), "only read-only quotes").toBe(true);
  expect(errors).toEqual([]);
});


test("a take that did not render, a file with nothing to edit, and an unsaved project: Next says why, or is not there", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone and one desktop");
  const { sent, errors } = await open(page, "/suites?suite=atomik&page=agent&sp=agent", false);
  await assets(page, info);
  await tile(page, "generation:gen_failed").click();
  const next = page.getByTestId("inspector").getByTestId("next-actions");
  await expect(next.getByTestId("next-re-edit")).toBeDisabled();
  await expect(next.getByTestId("next-why")).toHaveText("It did not render, so there is nothing to edit.");
  if (!WIDE.includes(info.project.name)) await page.getByTestId("close-inspector").click();
  await assets(page, info);
  await tile(page, "generation:gen_still").click();
  await expect(page.getByTestId("inspector").getByTestId("next-re-edit")).toBeDisabled();
  await expect(page.getByTestId("inspector").getByTestId("next-why")).toHaveText("Saving this project…");
  if (!WIDE.includes(info.project.name)) await page.getByTestId("close-inspector").click();
  await assets(page, info);
  await tile(page, "upload:up_script").click();
  await expect(page.getByTestId("inspector").getByTestId("asset-inspector")).toBeVisible();
  await expect(page.getByTestId("inspector").getByTestId("next-actions")).toHaveCount(0);
  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
});
