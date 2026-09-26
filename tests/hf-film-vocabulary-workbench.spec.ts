import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { composePrompt } from "../lib/studio";

/**
 * Gen's film vocabulary (idea 13): under Direction, six chips — Shot · Angle ·
 * Camera · Lens · Light · Look — each Auto until picked. A chip opens a grid
 * where every entry shows its loop (the platform's neutral previews: muted,
 * preload none, playing only while in view) or a drawing of what it does; `#`
 * in the words opens the bank as a typeahead. A pick is written into the words
 * the way the bank composes it, sent as `shotSpec`, and Recreate brings it
 * back onto the chips. Nothing here submits: the one press stops at the price
 * check, and every paid route fails the test.
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

type Options = { previews?: "ok" | "fail-once"; generations?: ReturnType<typeof generation>[] };

async function open(page: Page, options: Options = {}) {
  await signInLocally(page.request);
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
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour film study");
  /* Hydrated: the composer has read its engines and priced itself once words arrive. */
  await expect(page.getByTestId("gen-model")).toContainText("Seedance");
  return { errors, priced, lists, clips };
}

const chip = (page: Page, key: string) => page.getByTestId(`gen-film-${key}`);
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
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 31 cr");

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
  }
  await shot(page, info, "film-camera");

  /* The search narrows the bank by name, other name or phrase. */
  await sheet.getByTestId("gen-film-search").fill("dolly");
  await expect(sheet.locator(".gx-fv-tile .gx-fv-name")).toHaveText(["Push in", "Pull out", "Dolly zoom"]);
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
  expect(lists).toHaveLength(1);

  /* # in the words: the bank as a typeahead; Enter picks, and the #word leaves the words. */
  await prompt.click();
  await prompt.press("End");
  await prompt.pressSequentially(" #35");
  const hash = page.getByTestId("gen-hash");
  await expect(hash).toBeVisible();
  await expect(hash.getByRole("option").first()).toContainText("Lens");
  await expect(hash.getByRole("option").first()).toContainText("35mm");
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
  }
  await shot(page, info, "film-hash");
  await prompt.press("Escape");
  await expect(hash).toHaveCount(0);
  await expect(prompt).toHaveValue(`${WORDS} #pan`);
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
  await expect(go).toHaveText("Generate · 31 cr");
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
  await page.getByTestId("gen-view").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_crane']").click();
  const inspector = page.getByTestId("asset-inspector");
  await inspector.getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("gen-recipe-setup")).toHaveText("Wide · Crane · Backlit · Golden hour");
  await expect(page.getByTestId("gen-recipe-setup")).toHaveAttribute("data-state", "kept");
  const prompt = page.getByTestId("gen-prompt");
  await expect(prompt).toHaveValue("harbour at dusk, a boat drifts.");
  await expect(chip(page, "shot")).toHaveAttribute("aria-label", "Shot: Wide");
  await expect(chip(page, "camera")).toHaveAttribute("aria-label", "Camera: Crane");
  await expect(chip(page, "light")).toHaveAttribute("aria-label", "Light: Backlit");
  /* The hour has no chip of its own: it shows, and can be taken off. */
  const extras = page.getByTestId("gen-film-extras");
  await expect(extras).toContainText("Golden hour");
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 31 cr");
  await page.getByTestId("gen-generate").click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ prompt: composePrompt("harbour at dusk, a boat drifts.", SETUP), shotSpec: SETUP });
  const setupNote = page.getByTestId("gen-recipe-why").locator("[data-note='setup']");
  await expect(setupNote).toHaveCount(0);
  /* On a still the crane is not sent: the card says so, and it is not a change made here. */
  await page.getByRole("tab", { name: "Images" }).click();
  await expect(page.getByTestId("gen-recipe-setup")).toHaveAttribute("data-state", "changed");
  await expect(setupNote).toHaveText("Setup A still has no camera move");
  await page.getByRole("tab", { name: "Video" }).click();
  await expect(page.getByTestId("gen-recipe-setup")).toHaveAttribute("data-state", "kept");
  await expect(setupNote).toHaveCount(0);
  await extras.getByRole("button", { name: "Remove Time of day: Golden hour" }).click();
  await expect(extras).toHaveCount(0);
  /* The card still names what the take carried, and now says the chips no longer hold it. */
  await expect(page.getByTestId("gen-recipe-setup")).toHaveText("Wide · Crane · Backlit · Golden hour");
  await expect(page.getByTestId("gen-recipe-setup")).toHaveAttribute("data-state", "changed");
  await expect(setupNote).toHaveText("Setup Changed here");
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
  await page.getByRole("tab", { name: "Images" }).click();
  await expect(page.getByTestId("gen-film").locator(".gx-fv-chip")).toHaveCount(5);
  await expect(chip(page, "camera")).toHaveCount(0);
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill("#");
  await expect(page.getByTestId("gen-hash").getByRole("option").first()).toContainText("Shot");
  await prompt.fill("#push");
  await expect(page.getByTestId("gen-hash-none")).toHaveText("Nothing called #push");
  await page.getByRole("tab", { name: "Audio" }).click();
  await expect(page.getByTestId("gen-film")).toHaveCount(0);
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
  expect(errors).toEqual([]);
});
