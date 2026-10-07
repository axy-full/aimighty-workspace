import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { composePrompt, craftModules } from "../lib/studio";
import { openAdvanced } from "./helpers/makeAdvanced";
import { projectName } from "./helpers/projectName";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here"); });

/**
 * Gen's film vocabulary (idea 13): under Direction, six chips — Shot · Angle ·
 * Camera · Lens · Light · Look — each Auto until picked. A chip opens a grid
 * where every entry shows its loop (the platform's neutral previews: muted,
 * preload none, playing only while in view) or a drawing of what it does; `#`
 * in the words opens the bank as a typeahead. A pick is written into the words
 * the way the bank composes it, sent as `shotSpec`, and Recreate brings it
 * back onto the chips. Nothing here reaches a paid route: a press stops at the
 * price check (a batch, at a mocked admission), and every paid route without a
 * mock fails the test.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
/* FILM_SHOTS=<dir> saves the finished composer and grid at the sizes the review looks at. */
const SHOTS = ["workbench-390x844", "workbench-1440x900"];
const CLIP = readFileSync("public/fixtures/clip.mp4");

/* Test fixtures only. */
const fixture = (): Project => ({ ...newProject("Harbour film study"), id: "ws-film", productionProjectId: "prod-ws", shotMappings: {} });
const WORDS = "a fisherman mends a net on the harbour wall";
const SETUP = { shot: "ws", move: "crane", light: "back", time: "golden" };
const craned = () => generation({
  id: "gen_crane", kind: "video", model: "dreamina-seedance-2-0-260128", title: "Harbour crane", prompt: "Harbour crane, rewritten by the writer",
  params: { rawPrompt: composePrompt("harbour at dusk, a boat drifts", SETUP), ratio: "16:9", resolution: "720p", duration: 5, shotSpec: SETUP },
});

type Options = { previews?: "ok" | "fail-once"; generations?: ReturnType<typeof generation>[]; member?: boolean };

async function open(page: Page, options: Options = {}) {
  const { workspace } = await signInLocally(page.request);
  if (options.member) {
    /* The session's role is read per request: this account is now a member of its own workspace. */
    const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try { await db.execute({ sql: "UPDATE memberships SET role='member' WHERE workspace_id=?", args: [workspace.id] }); }
    finally { db.close(); }
  }
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: options.generations ?? [] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  /* The platform's loops: one is published (Push in), the rest are not. The list fails once when asked to. */
  const lists: number[] = [];
  const clips: string[] = [];
  let failures = options.previews === "fail-once" ? 1 : 0;
  await page.route(/\/api\/platform\/previews(\?.*)?$/, (route) => {
    lists.push(Date.now());
    if (failures-- > 0) return route.fulfill({ status: 500, json: { error: "unavailable" } });
    return route.fulfill({ json: { previews: { "move:push": "/api/platform/previews/move%3Apush", "move:elsewhere": "https://elsewhere.example/clip.mp4" }, count: 2 } });
  });
  await page.route(/\/api\/platform\/previews\/[^/?]+(\?.*)?$/, (route) => {
    clips.push(new URL(route.request().url()).pathname);
    return route.fulfill({ body: CLIP, contentType: "video/mp4" });
  });
  /* The composer's price reads (GET, never a charge). */
  await page.route(/\/api\/workbench\/engines\?.*model=/, (route) => route.fulfill({ json: { credits: 31 } }));
  /* Generate's own re-quote is where a press would first spend: recorded and refused, so nothing runs. */
  const priced: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => {
    priced.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 409, json: { error: "Stopped by the test before anything ran." } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* React's own complaints (a duplicate key, a bad attribute) count as errors; a refused request is the fixtures'. */
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 300)); });
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  await expect(projectName(page)).toHaveText("Harbour film study");
  /* Hydrated: the composer has read its engines and priced itself once words arrive. */
  await expect(page.getByTestId("make-engine-line")).toContainText("Seedance");
  return { errors, priced, lists, clips };
}


/**
 * Again on a take's card in Make › Recent (it was the Inspector's Recreate), once it wears its price: the recipe lands in Make, which
 * is on its Make tab with Advanced folded. `advanced` opens it again, retried: Make redraws as a recipe's references are read.
 */
async function recreate(page: Page, id: string) {
  await page.getByTestId("make-tab-recent").click();
  const again = page.locator(`[data-testid="make-recent-card"][data-take*="${id}"]`).getByTestId("make-again");
  await expect(again).toBeEnabled({ timeout: 90_000 });
  await again.click();
  await expect(page.getByTestId("make-tab-make")).toHaveAttribute("aria-selected", "true");
}
const advanced = (page: Page) => expect(async () => { await openAdvanced(page); }).toPass({ timeout: 20_000 });

const chip = (page: Page, key: string) => page.getByTestId(`gen-film-${key}`);
/** What covers the chip's centre (the sticky Generate, the tab bar…), or null when the chip is on top. */
const coveredChip = (page: Page, key: string) => chip(page, key).evaluate((el) => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit && !el.contains(hit) ? `${hit.tagName}.${hit.className}` : null;
});
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

/** `centre`: the test id to bring into the middle of the screen first. */
async function shot(page: Page, info: TestInfo, name: string, centre?: string) {
  const dir = process.env.FILM_SHOTS;
  if (!dir || !SHOTS.includes(info.project.name)) return;
  if (centre) await page.getByTestId(centre).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect && Number(a.effect.getTiming().iterations) !== Infinity).map((a) => a.finished.catch(() => null))));
  await page.screenshot({ path: `${dir}/${name}-${info.project.name.replace("workbench-", "")}.png`, animations: "disabled" });
}

test("six Auto chips open a grid of loops and drawings; a pick and a #word are written into the words once and sent as shotSpec", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, priced, lists, clips } = await open(page);
  const phone = PHONES.includes(info.project.name);

  /* Six chips, every one Auto, and nothing read until a grid that has loops opens. */
  await expect(page.getByTestId("gen-film").locator(".gx-fv-chip")).toHaveCount(6);
  for (const [key, label] of [["shot", "Shot"], ["angle", "Angle"], ["camera", "Camera"], ["lens", "Lens"], ["light", "Light"], ["look", "Look"]])
    await expect(chip(page, key)).toHaveAttribute("aria-label", `${label}: Auto`);
  expect(lists).toEqual([]);

  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill(WORDS);
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · 31 cr");

  /* Camera: Auto first, the moves, then the named techniques; the published loop plays, the rest are drawn. */
  await chip(page, "camera").click();
  const sheet = page.getByTestId("gen-film-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("group", { name: "Moves" })).toBeVisible();
  await expect(sheet.getByRole("group", { name: "Techniques" })).toBeAttached();
  await expect(sheet.getByTestId("gen-film-auto")).toHaveAttribute("aria-pressed", "true");
  const push = sheet.locator("[data-option='move:push']");
  await expect(push).toContainText("Push in");
  await expect(push).toContainText("dolly in");
  await expect(push.locator(".gx-fv-media")).toHaveAttribute("data-preview", "loop");
  const loop = push.locator("video");
  expect(await loop.evaluate((v: HTMLVideoElement) => ({ muted: v.muted, loop: v.loop, preload: v.preload, inline: v.playsInline }))).toEqual({ muted: true, loop: true, preload: "none", inline: true });
  /* In view, so it plays; a clip from anywhere else is never used. */
  await expect.poll(() => loop.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await expect(loop).toHaveAttribute("data-ready", "true");
  expect(clips).toContain("/api/platform/previews/move%3Apush");
  expect(clips.some((c) => c.includes("elsewhere"))).toBe(false);
  await expect(sheet.locator("[data-option='move:pull'] .gx-fv-media")).toHaveAttribute("data-preview", "glyph");
  await expect(sheet.locator("[data-option='move:pull'] svg")).toBeVisible();
  expect(lists).toHaveLength(1);
  if (phone) {
    expect(await smallTargets(page, ".gx-sheet--vocab"), "grid targets under 44×44").toEqual([]);
    /* The sheet sits on the bottom edge, inside the screen, once it has risen. */
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => null))));
    const box = await sheet.boundingBox();
    expect(Math.round(box!.y + box!.height)).toBeLessThanOrEqual(page.viewportSize()!.height);
    /* On its side the phone gives the grid its height, not a strip under a gap. */
    if (info.project.name === "workbench-844x390") expect(box!.height).toBeGreaterThan(page.viewportSize()!.height - 40);
  }
  await shot(page, info, "film-camera");

  /* The search narrows the bank by name, other name or phrase. */
  await sheet.getByTestId("gen-film-search").fill("dolly");
  await expect(sheet.locator(".gx-fv-tile .gx-fv-name")).toHaveText(["Push in", "Pull out", "Tracking", "Dolly zoom"]);
  await sheet.getByTestId("gen-film-search").fill("zzz");
  await expect(sheet.getByTestId("gen-film-none")).toContainText("Nothing matches “zzz”.");
  await sheet.getByRole("button", { name: "Clear search" }).click();
  await push.click();
  await expect(sheet).toHaveCount(0);
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Push in");
  await expect(chip(page, "camera")).toHaveAttribute("data-set", "true");
  await expect(chip(page, "camera")).toBeFocused();

  /* Shot: a grid of drawings (no loops for framing), picked the same way. */
  await chip(page, "shot").click();
  await expect(sheet.locator(".gx-fv-media[data-preview='loop']")).toHaveCount(0);
  await sheet.locator("[data-option='shot:cu']").click();
  await expect(chip(page, "shot")).toHaveAttribute("aria-label", "Shot: Close-up");
  /* A chip just set is on top: clear of the sticky Generate and, on a phone, the tab bar. */
  expect(await coveredChip(page, "shot"), "shot chip covered after its pick").toBeNull();
  expect(lists).toHaveLength(1);

  /* # in the words: the bank as a typeahead. A number chooses nothing by itself (it may be a rank or a
     count); an arrow chooses, Enter picks, and the #word leaves the words. */
  await prompt.click();
  await prompt.press("End");
  await prompt.pressSequentially(" #35");
  const hash = page.getByTestId("gen-hash");
  await expect(hash).toBeVisible();
  await expect(hash.getByRole("option").first()).toContainText("Lens");
  await expect(hash.getByRole("option").first()).toContainText("35mm");
  await expect(hash.getByRole("option", { selected: true })).toHaveCount(0);
  await prompt.press("ArrowDown");
  await expect(hash.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await prompt.press("Enter");
  await expect(hash).toHaveCount(0);
  await expect(prompt).toHaveValue(WORDS);
  await expect(chip(page, "lens")).toHaveAttribute("aria-label", "Lens: 35mm");

  /* Arrows move, Escape closes and leaves the words alone; a click picks too. */
  await prompt.pressSequentially(" #pan");
  await expect(hash.getByRole("option").nth(0)).toContainText("Pan");
  await prompt.press("ArrowDown");
  await expect(hash.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(hash.getByRole("option").nth(1)).toContainText("Pan left");
  if (phone) {
    expect(await smallTargets(page, ".gx-fv-hash"), "typeahead rows under 44×44").toEqual([]);
    /* The list is in view and not under the sticky Generate band. */
    const under = await hash.evaluate((list) => {
      const r = list.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.bottom - 6, innerHeight - 1));
      return hit && !list.contains(hit) ? `${hit.tagName}.${hit.className}` : null;
    });
    expect(under, "typeahead's last row covered").toBeNull();
    const list = (await hash.boundingBox())!;
    expect(Math.round(list.y + list.height), "typeahead past the screen's foot").toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  await shot(page, info, "film-hash");
  await prompt.press("Escape");
  await expect(hash).toHaveCount(0);
  await expect(prompt).toHaveValue(`${WORDS} #pan`);
  /* A hashtag or a rank is the person's own: nothing is offered for #ad, nothing is chosen for #1, and Enter is a new line. */
  await prompt.fill(`${WORDS} #ad`);
  await expect(hash).toHaveCount(0);
  await prompt.press("Enter");
  await expect(prompt).toHaveValue(`${WORDS} #ad\n`);
  await prompt.fill(`${WORDS}, the world's #1`);
  await expect(hash).toBeVisible();
  await expect(hash.getByRole("option", { selected: true })).toHaveCount(0);
  await prompt.press("Enter");
  await expect(prompt).toHaveValue(`${WORDS}, the world's #1\n`);
  await expect(chip(page, "lens")).toHaveAttribute("aria-label", "Lens: 35mm");
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Push in");
  await prompt.fill(`${WORDS} #soft`);
  await hash.getByRole("option", { name: /Soft/ }).click();
  await expect(prompt).toHaveValue(WORDS);
  await expect(chip(page, "light")).toHaveAttribute("aria-label", "Light: Soft");
  await expect(prompt).toBeFocused();
  /* Picking what is already held puts that chip back to Auto. */
  await chip(page, "light").click();
  await sheet.locator("[data-option='light:soft']").click();
  await expect(chip(page, "light")).toHaveAttribute("aria-label", "Light: Auto");

  await shot(page, info, "film-chips", "gen-film");
  expect(await noOverflow(page)).toBe(true);
  if (phone) {
    expect(await smallTargets(page, ".gx-fv"), "chip targets under 44×44").toEqual([]);
    expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  }

  /* Generate: the words carry the setup once, written the bank's way, and the setup goes as data. */
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText("Make · 31 cr");
  await go.click();
  await expect.poll(() => priced.length).toBe(1);
  const spec = { shot: "cu", move: "push", lens: "35" };
  expect(priced[0]).toMatchObject({ prompt: composePrompt(WORDS, spec), shotSpec: spec });
  expect(String(priced[0].prompt)).toMatch(/^a fisherman mends a net on the harbour wall\. Close-up\. Shot on a 35mm lens\.\n\nThe camera travels forward/);
  /* The box still holds the person's words. */
  await expect(prompt).toHaveValue(WORDS);
  expect(errors).toEqual([]);
});

test("Recreate brings a take's setup back onto the chips and out of the words; a row no chip shows can be removed; Undo puts Auto back", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, priced } = await open(page, { generations: [craned()] });
  await recreate(page, "gen_crane");
  await advanced(page);
  const prompt = page.getByTestId("gen-prompt");
  await expect(prompt).toHaveValue("harbour at dusk, a boat drifts.");
  await expect(chip(page, "shot")).toHaveAttribute("aria-label", "Shot: Wide");
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Crane");
  await expect(chip(page, "light")).toHaveAttribute("aria-label", "Light: Backlit");
  /* The hour has no chip of its own: it shows, and can be taken off. */
  const extras = page.getByTestId("gen-film-extras");
  await expect(extras).toContainText("Golden hour");
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · 31 cr");
  await page.getByTestId("gen-generate").click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ prompt: composePrompt("harbour at dusk, a boat drifts.", SETUP), shotSpec: SETUP });
  /* On a still the crane is not sent: a still has no Camera chip. (The old card's own line about the setup is not on Make's card.) */
  await page.getByTestId("make-type-image").click();
  await advanced(page);
  await expect(chip(page, "camera")).toHaveCount(0);
  await page.getByTestId("make-type-video").click();
  await advanced(page);
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Crane");
  await extras.getByRole("button", { name: "Remove Time of day: Golden hour" }).click();
  await expect(extras).toHaveCount(0);
  await shot(page, info, "film-recreate", "gen-recipe");

  await page.getByTestId("gen-recipe-undo").click();
  for (const key of ["shot", "camera", "light"]) await expect(chip(page, key)).toHaveAttribute("aria-label", /: Auto$/);
  await expect(prompt).toHaveValue("");
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("the grid says when its loops cannot be read and reads them again; Escape and the veil close it; a still has no Camera chip", async ({ page }, info) => {
  test.skip(!["workbench-360x640", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, lists } = await open(page, { previews: "fail-once" });
  await chip(page, "camera").click();
  const sheet = page.getByTestId("gen-film-sheet");
  const note = sheet.getByTestId("gen-film-previews-error");
  await expect(note).toContainText("Loops unavailable");
  /* Every entry still picks: the drawings stand in. */
  await expect(sheet.locator("[data-option='move:push'] .gx-fv-media")).toHaveAttribute("data-preview", "glyph");
  await note.getByRole("button", { name: "Try again" }).click();
  await expect(note).toHaveCount(0);
  await expect(sheet.locator("[data-option='move:push'] .gx-fv-media")).toHaveAttribute("data-preview", "loop");
  expect(lists).toHaveLength(2);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(chip(page, "camera")).toBeFocused();

  /* The veil closes it too, and the loops are not read again. */
  await chip(page, "angle").click();
  await expect(sheet).toHaveAttribute("data-chip", "angle");
  await page.getByTestId("gen-film-veil").click({ position: { x: 5, y: 5 } });
  await expect(sheet).toHaveCount(0);
  expect(lists).toHaveLength(2);

  /* A still: framing, lens, light and look — no camera travel. # lists shot sizes first. */
  await page.getByTestId("make-type-image").click();
  await expect(page.getByTestId("gen-film").locator(".gx-fv-chip")).toHaveCount(5);
  await expect(chip(page, "camera")).toHaveCount(0);
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill("#");
  await expect(page.getByTestId("gen-hash").getByRole("option").first()).toContainText("Shot");
  await expect(page.getByTestId("gen-hash").getByRole("option", { selected: true })).toHaveCount(0);
  /* A still has no camera move: #push offers nothing, so nothing opens. */
  await prompt.fill("#push");
  await expect(page.getByTestId("gen-hash")).toHaveCount(0);
  await page.getByTestId("make-type-audio").click();
  await expect(page.getByTestId("gen-film")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a loop that rises into view with its grid plays, even when a busy page hands over what it saw all at once", async ({ page }, info) => {
  test.skip(!["workbench-360x640", "workbench-390x844"].includes(info.project.name), "the phones whose grid rises from the foot of the screen");
  /* A busy page (CI under load) delivers an observer's entries late and together, oldest first. Once armed, a loop's
     observer here is handed nothing until the loop is in view (or a while has passed), then everything at once. */
  await page.addInitScript(() => {
    const w = window as unknown as { __loopLooks: boolean[][]; __holdLoops?: boolean };
    w.__loopLooks = [];
    const Native = window.IntersectionObserver;
    window.IntersectionObserver = class extends Native {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        let held: IntersectionObserverEntry[] = [];
        let timer = 0;
        const hand = (observer: IntersectionObserver) => {
          window.clearTimeout(timer);
          timer = 0;
          const all = held;
          held = [];
          w.__loopLooks.push(all.map((e) => e.isIntersecting));
          callback(all, observer);
        };
        super((entries, observer) => {
          if (!w.__holdLoops || !entries.every((e) => e.target.matches(".gx-fv-media > video"))) return callback(entries, observer);
          held.push(...entries);
          if (entries.some((e) => e.isIntersecting)) hand(observer);
          else if (!timer) timer = window.setTimeout(() => hand(observer), 5_000);
        }, options);
      }
    };
  });
  const { errors } = await open(page);
  const sheet = page.getByTestId("gen-film-sheet");
  const loop = sheet.locator("[data-option='move:push'] video");
  /* The first opening reads the loops; the next shows them as the grid starts to rise from the foot of the screen. */
  await chip(page, "camera").click();
  await expect(loop).toBeAttached();
  await sheet.getByTestId("gen-film-close").click();
  await expect(sheet).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __holdLoops: boolean }).__holdLoops = true; });
  await chip(page, "camera").click();
  const looks = () => page.evaluate(() => (window as unknown as { __loopLooks: boolean[][] }).__loopLooks);
  await expect.poll(async () => (await looks()).length).toBeGreaterThan(0);
  /* One delivery: below the screen as the grid began to rise, then in view. The newest is where the loop is. */
  const [seen] = await looks();
  expect(seen[0], "first look: below the screen").toBe(false);
  expect(seen[seen.length - 1], "last look: in view").toBe(true);
  await expect.poll(() => loop.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await expect(loop).toHaveAttribute("data-ready", "true");
  expect(errors).toEqual([]);
});

test("every grid draws every entry it offers, and picks from the keyboard", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors } = await open(page);
  const sheet = page.getByTestId("gen-film-sheet");
  for (const key of ["shot", "angle", "camera", "lens", "light", "look"]) {
    await chip(page, key).click();
    await expect(sheet).toHaveAttribute("data-chip", key);
    /* Each tile carries a loop or a drawing with something in it; none is blank. */
    const blank = await sheet.locator(".gx-fv-tile").evaluateAll((tiles) => tiles.filter((t) => {
      const svg = t.querySelector("svg");
      return !t.querySelector("video") && (!svg || svg.childElementCount === 0 || !svg.getBoundingClientRect().width);
    }).map((t) => t.getAttribute("data-option")));
    expect(blank, `${key}: tiles with nothing drawn`).toEqual([]);
    if (key === "camera") {
      /* No two entries are drawn alike, so they tell apart where no loop is published. */
      const drawings = await sheet.locator(".gx-fv-tile:not([data-option='auto']) svg").evaluateAll((svgs) => svgs.map((svg) => svg.innerHTML));
      expect(drawings.length).toBeGreaterThan(30);
      expect(drawings.filter((d, i) => drawings.indexOf(d) !== i).length, "camera entries drawn alike").toBe(0);
    }
    /* On a phone every grid rises edge to edge, whatever its content (not only the one with a search). */
    if (PHONES.includes(info.project.name)) expect(Math.round((await sheet.boundingBox())!.width), `${key}: sheet width`).toBe(page.viewportSize()!.width);
    await shot(page, info, `film-grid-${key}`);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
  /* The keyboard: the picked entry (Auto) has focus; arrows move through the grid, Enter picks. */
  await chip(page, "look").click();
  await expect(sheet.getByTestId("gen-film-auto")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(sheet.locator("[data-option='look:clean']")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(sheet.locator(".gx-fv-tile:focus")).not.toHaveAttribute("data-option", "look:clean");
  await page.keyboard.press("Enter");
  await expect(sheet).toHaveCount(0);
  await expect(chip(page, "look")).not.toHaveAttribute("aria-label", "Look: Auto");

  /* Focus stays in the sheet: Shift+Tab from its first control goes to its last, Tab from its last back to the first. */
  await chip(page, "shot").click();
  const close = sheet.getByTestId("gen-film-close");
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(sheet.locator(".gx-fv-tile").last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  /* Rack focus locks the camera off: it takes the move off, only Locked off rides with it, and a move takes it off again. */
  const camera = async (option: string) => { await chip(page, "camera").click(); await sheet.locator(`[data-option='${option}']`).click(); await expect(sheet).toHaveCount(0); };
  await camera("move:push");
  await camera("technique:rackfocus");
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Rack focus");
  await camera("move:static");
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Locked off + Rack focus");
  await camera("move:orbit");
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Orbit");

  /* Long values read whole on a narrow phone, and a chip just set is never left under the sticky Generate. */
  for (const [key, option] of [["shot", "shot:evs"], ["angle", "angle:ground"], ["look", "look:teal"]] as const) {
    await chip(page, key).click();
    await sheet.locator(`[data-option='${option}']`).click();
    await expect(sheet).toHaveCount(0);
    expect(await coveredChip(page, key), `${key} chip covered after its pick`).toBeNull();
  }
  if (info.project.name === "workbench-390x844") {
    const cut = await page.locator(".gx-fv-chip-value").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent));
    expect(cut, "chip values cut short").toEqual([]);
  }
  expect(errors).toEqual([]);
});

/* A take stored the way admission stored one made with the camera on Auto before the words were kept beside it: the words Gen sent, then a move the server chose, then the platform's rules. */
const NET = "A fisherman mends a net on the pier";
const served = () => generation({
  id: "gen_net", kind: "video", model: "dreamina-seedance-2-0-260128", title: "Net mending",
  prompt: `${composePrompt(NET, { shot: "cu" })}\n\n${craftModules({ move: "static" })}\n\nKeep the horizon level.`,
  params: { ratio: "16:9", resolution: "720p", duration: 5, shotSpec: { shot: "cu" } },
});

test("Recreate takes what the server added off a take's words, so one chip changed sends one setup", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, priced } = await open(page, { generations: [served()] });
  await recreate(page, "gen_net");
  await advanced(page);
  const prompt = page.getByTestId("gen-prompt");
  await expect(prompt).toHaveValue(`${NET}.`);
  await expect(chip(page, "shot")).toHaveAttribute("aria-label", "Shot: Close-up");
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Auto");
  await chip(page, "camera").click();
  await page.getByTestId("gen-film-sheet").locator("[data-option='move:pull']").click();
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · 31 cr");
  await page.getByTestId("gen-generate").click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ prompt: composePrompt(`${NET}.`, { shot: "cu", move: "pull" }), shotSpec: { shot: "cu", move: "pull" } });
  expect(String(priced[0].prompt)).not.toMatch(/locked on a tripod|horizon level/);
  expect(errors).toEqual([]);
});

/* The connected account stores only the words, with the setup written in as Gen sent it. */
const GULL = "a gull over the breakwater";
const accountTake = () => generation({
  id: "gen_account", kind: "video", model: "seedance_2_5", title: "Account take", provider: "higgsfield",
  prompt: composePrompt(GULL, { move: "push", light: "soft" }),
  params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", outputType: "video", duration: 5.04, settings: { aspect_ratio: "16:9", resolution: "720p", duration: 5 } },
});

test("a connected take's setup, kept only in its words, comes back onto the chips; a move changed sends one camera block", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  /* A member recreates on this workspace's engines, so the one press stops at this workspace's price check. */
  const { errors, priced } = await open(page, { member: true, generations: [accountTake()] });
  await recreate(page, "gen_account");
  await advanced(page);
  const prompt = page.getByTestId("gen-prompt");
  await expect(prompt).toHaveValue(`${GULL}.`);
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Push in");
  await expect(chip(page, "light")).toHaveAttribute("aria-label", "Light: Soft");
  await chip(page, "camera").click();
  await page.getByTestId("gen-film-sheet").locator("[data-option='move:pull']").click();
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Pull out");
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · 31 cr");
  await page.getByTestId("gen-generate").click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ prompt: composePrompt(`${GULL}.`, { move: "pull", light: "soft" }), shotSpec: { move: "pull", light: "soft" } });
  expect(String(priced[0].prompt)).not.toMatch(/travels forward/);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

/* Takes 2–4 of one Generate go as one batch (lib/workspace/take-batch.ts): every take is priced and sent in the words as sent. */
test("a batch of four takes carries the chips' setup in every take it prices and sends", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  /* This workspace's batch, mocked: every take priced at 31 and admitted as running; nothing runs. */
  const quotes: Record<string, unknown>[] = [], sends: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    quotes.push(body);
    return route.fulfill({ json: { estimatedCredits: 31, fingerprint: String(body.variation).repeat(64).slice(0, 64), unit: "cr" } });
  });
  await page.route(/\/api\/generate$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sends.push(body);
    return route.fulfill({ json: { id: `gen_fv_take_${body.variation}`, status: "running" }, headers: { "Idempotency-Status": "complete" } });
  });
  await page.route(/\/api\/jobs\/gen_fv_take_\d+(\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    return route.fulfill({ json: { generation: generation({ id, kind: "video", status: "running", prompt: WORDS }) } });
  });
  await page.getByTestId("gen-prompt").fill(WORDS);
  const sheet = page.getByTestId("gen-film-sheet");
  await chip(page, "shot").click();
  await sheet.locator("[data-option='shot:cu']").click();
  await expect(chip(page, "shot")).toHaveAttribute("aria-label", "Shot: Close-up");
  await chip(page, "camera").click();
  await sheet.locator("[data-option='move:push']").click();
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Push in");
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · 31 cr");
  await page.getByTestId("gen-takes-4").click();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("4");
  await expect(page.getByTestId("gen-generate")).toHaveText("Make 4 takes · 124 cr");
  await page.getByTestId("gen-generate").click();

  /* Four quotes, then four sends, each with the setup written in once and kept as data; one batch. */
  await expect.poll(() => sends.length).toBe(4);
  const spec = { shot: "cu", move: "push" };
  for (const body of [...quotes, ...sends]) expect(body).toMatchObject({ prompt: composePrompt(WORDS, spec), shotSpec: spec });
  expect(quotes.map((q) => q.variation)).toEqual([1, 2, 3, 4]);
  expect(sends.map((s) => s.variation)).toEqual([1, 2, 3, 4]);
  expect(new Set(sends.map((s) => s.batchId)).size).toBe(1);
  await expect(page.getByTestId("toast")).toContainText("124 cr · 4 takes · rendering");
  /* The accepted batch closes Make (the draft of the words is cleared with it). */
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  expect(errors).toEqual([]);
});
