import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { goWorkbenchStage } from "./helpers/workbenchNavigation";
import { legacyShell } from "./helpers/legacyShell";

/**
 * Cinema Studio 4.0's documented creative controls, as Gen and the canvas
 * dialog offer them. In Gen they ride the film vocabulary's chips: nine
 * chips, each Auto until picked, a grid per control (with search where it is
 * long) and `#` over their names. In the canvas dialog they are its own
 * selects, by the same names, each Auto. A pick goes as the engine's own
 * setting (never into the words), never moves the approximate price, and a
 * WAV upload goes as a sound reference. Nothing here reaches a paid route: a
 * Gen press stops at its re-quote, the dialog's submission is mocked, and
 * every other paid route fails the test.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = ["workbench-390x844", "workbench-1440x900"];
const CINEMA = "higgsfield-cinema-studio-4.0";
const SEEDANCE = "dreamina-seedance-2-5-260628";
const WORDS = "a lighthouse keeper climbs the spiral stairs";
const LABELS = ["Camera", "Lens", "Aperture", "Movement", "Era", "Genre", "Light", "Pacing", "Palette"];

/* Test fixtures only. */
const ROOM = upload({ id: "room-tone", filename: "Room tone.wav", mime: "audio/wav", kind: "audio", durationS: 6, width: null, height: null });
const VOICE = upload({ id: "voice-line", filename: "Voice line.mp3", mime: "audio/mpeg", kind: "audio", durationS: 3, width: null, height: null });
/** A Cinema Studio take made with two controls picked and the room tone as its sound reference. */
const TAKE = () => generation({
  id: "gen_cinema_take", kind: "video", model: CINEMA, provider: "higgsfield", title: "Lighthouse take", prompt: "@Audio1 hums while a lighthouse keeper climbs",
  params: { rawPrompt: "@Audio1 hums while a lighthouse keeper climbs", ratio: "16:9", resolution: "720p", duration: 5,
    cinema: { camera_movement: "crane-up", genre: "noir" }, references: [{ uploadId: "room-tone", role: "reference_audio", kind: "audio" }] },
});

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
/** A surface measured only once its entrance (a sheet rising, a list scaling in) has finished. */
const settled = (target: Locator) => target.evaluate((el) => Promise.all(el.getAnimations({ subtree: true })
  .filter((a) => Number(a.effect?.getTiming().iterations) !== Infinity).map((a) => a.finished.catch(() => null))));

/** Text under `scope` whose colour, blended over what it sits on, is dimmer than #7C7C84 (the label floor, after alpha). */
async function dimText(page: Page, scope: string, selector: string): Promise<string[]> {
  return page.evaluate(({ scope, selector }) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const floor = luminance([0x7c, 0x7c, 0x84]) - 0.5;
    const ground = (el: Element | null): number[] => {
      for (let at = el; at; at = at.parentElement) {
        const [r, g, b, a = 1] = parse(getComputedStyle(at).backgroundColor);
        if (a > 0.99) return [r, g, b];
      }
      return [0, 0, 0];
    };
    const out: string[] = [];
    for (const root of Array.from(document.querySelectorAll(scope)))
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
        if (!el.getClientRects().length || !(el.textContent ?? "").trim()) continue;
        const [r, g, b, a = 1] = parse(getComputedStyle(el).color);
        /* What the text sits on: its own background (a select paints one), else the nearest opaque one above it. */
        const [br, bg, bb] = ground(el);
        const blended = [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
        if (luminance(blended) < floor) out.push(`${el.className || el.tagName}: ${getComputedStyle(el).color} — “${(el.textContent ?? "").trim().slice(0, 24)}”`);
      }
    return out;
  }, { scope, selector });
}

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS.includes(info.project.name)) return;
  await page.screenshot({ path: info.outputPath(`${name}-${info.project.name.replace("workbench-", "")}.png`), animations: "disabled" });
}

/** A drop of a Library id onto a well, the way a dragged tile carries it. */
async function dropId(page: Page, target: Locator, id: string) {
  const transfer = await page.evaluateHandle((value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    return data;
  }, id);
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
}

/* ── Gen ─────────────────────────────────────────────────────────────── */

async function openGen(page: Page, generations: ReturnType<typeof generation>[] = []) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject("Lighthouse study"), id: "ws-cinema", productionProjectId: "prod-ws", shotMappings: {} } });
  await mockLibrary(page, { uploads: [ROOM, VOICE], generations });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  /* Each upload's own record, read when it is dropped on the well. */
  await page.route(/\/api\/uploads\/(room-tone|voice-line)\/metadata$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({ json: { upload: id === ROOM.id ? ROOM : VOICE } });
  });
  /* The composer's price reads (GET, never a charge): Cinema Studio's is approximate. */
  const reads: URLSearchParams[] = [];
  await page.route(/\/api\/workbench\/engines\?.*model=/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    reads.push(query);
    return route.fulfill({ json: query.get("model") === CINEMA ? { credits: 31, approximate: true } : { credits: 12 } });
  });
  /* Generate's own re-quote is where a press would first spend: recorded and refused, so nothing runs. */
  const priced: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => {
    priced.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 409, json: { error: "Stopped by the test before anything ran." } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 300)); });
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Lighthouse study");
  await expect(page.getByTestId("gen-model")).toContainText("Seedance");
  return { errors, priced, reads };
}

async function pickModel(page: Page, name: RegExp) {
  const button = page.getByTestId("gen-model");
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const sheet = page.getByRole("dialog", { name: "Choose a model" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("option", { name }).click();
  await expect(sheet).toHaveCount(0);
}

const chip = (page: Page, key: string) => page.getByTestId(`gen-cinema-${key}`);

test("Cinema Studio's own controls ride Gen's chips: nine Auto chips, grids with search, # over their names; picks go as its settings, never into the words or the price", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, priced, reads } = await openGen(page);
  const phone = PHONES.includes(info.project.name);
  await pickModel(page, /^Cinema Studio 4\.0/);
  await expect(page.getByTestId("gen-model")).toContainText("Cinema Studio 4.0");

  /* Nine chips, every one Auto, in the provider's own order; the film vocabulary's six give way to them. */
  await expect(page.getByTestId("gen-film")).toHaveCount(0);
  const chips = page.getByTestId("gen-cinema").locator(".gx-fv-chip");
  await expect(chips).toHaveCount(9);
  await expect(page.getByTestId("gen-cinema").getByRole("group")).toHaveAttribute("aria-label", "Cinema Studio controls");
  for (const [i, label] of LABELS.entries()) await expect(chips.nth(i)).toHaveAttribute("aria-label", `${label}: Auto`);

  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill(WORDS);
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText("Make · about 31 cr, at most 93 cr");
  /* An approximate quote says its ceiling (STATED_CHARGE_BAND, lib/runLimit.ts): one take's on the engine line, what Make approves on the button. */
  await expect(page.getByTestId("make-engine-price")).toHaveText("about 31 cr, at most 93 cr");
  await expect(go).toHaveAccessibleName("Make · about 31 cr, at most 93 cr");
  /* The longer price fits whole: on the button, inside the screen, on one line, never cut, never under 12 px. */
  const fit = await go.evaluate((el) => {
    const price = el.querySelector(".gx-go-price")!;
    const box = el.getBoundingClientRect(), p = price.getBoundingClientRect();
    const px = parseFloat(getComputedStyle(price).fontSize);
    return { inside: box.left >= 0 && box.right <= innerWidth + 1, uncut: el.scrollWidth <= el.clientWidth + 1 && p.left >= box.left - 1 && p.right <= box.right + 1,
      oneLine: p.height <= px * 1.6, legible: px >= 12 };
  });
  expect(fit).toEqual({ inside: true, uncut: true, oneLine: true, legible: true });
  /* The engine line's price is never cut either: it wraps whole inside the line and the panel (the name may ellipsize),
     and the line stays a full touch target where touch is the input. */
  await page.getByTestId("gen-model").scrollIntoViewIfNeeded();
  const line = await page.getByTestId("make-engine-price").evaluate((price) => {
    const within = (a: DOMRect, b: DOMRect) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    const p = price.getBoundingClientRect(), engine = price.closest("[data-testid=gen-model]")!.getBoundingClientRect();
    const px = parseFloat(getComputedStyle(price).fontSize);
    const touch = matchMedia("(max-width: 767px), (pointer: coarse)").matches;
    return { uncut: price.scrollWidth <= price.clientWidth + 1, inLine: within(p, price.parentElement!.getBoundingClientRect()), inEngine: within(p, engine),
      inPanel: within(p, price.closest(".gx-make")!.getBoundingClientRect()), legible: px >= 12, target: !touch || engine.height >= 44 };
  });
  expect(line).toEqual({ uncut: true, inLine: true, inEngine: true, inPanel: true, legible: true, target: true });
  expect(await noOverflow(page)).toBe(true);
  const readsBefore = reads.length;

  /* Movement: Auto first, then every documented move, each drawn; search narrows by name. */
  await chip(page, "camera_movement").click();
  const sheet = page.getByTestId("gen-film-sheet");
  await expect(sheet).toHaveAttribute("data-chip", "camera_movement");
  await expect(sheet.getByTestId("gen-film-auto")).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.locator(".gx-fv-tile")).toHaveCount(34);
  await expect(sheet.locator("[data-option='camera_movement:dolly-in'] .gx-fv-media")).toHaveAttribute("data-preview", "glyph");
  await expect(sheet.locator("[data-option='camera_movement:dolly-in'] svg")).toBeVisible();
  const search = sheet.getByTestId("gen-film-search");
  await expect(search).toHaveAttribute("placeholder", "Search 33 moves");
  if (phone) {
    await settled(sheet);
    expect(await smallTargets(page, ".gx-sheet--vocab"), "grid targets under 44×44").toEqual([]);
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
  await shot(page, info, "cinema-movement");
  await search.fill("dolly");
  await expect(sheet.locator(".gx-fv-tile .gx-fv-name")).toHaveText(["Dolly zoom", "Dolly in", "Dolly out"]);
  await sheet.locator("[data-option='camera_movement:dolly-in']").click();
  await expect(sheet).toHaveCount(0);
  await expect(chip(page, "camera_movement")).toHaveAttribute("aria-label", "Movement: Dolly in");
  await expect(chip(page, "camera_movement")).toHaveAttribute("data-set", "true");
  await expect(chip(page, "camera_movement")).toBeFocused();

  /* Palette: fifty names alone (nothing is drawn for a palette known only by its name), searchable. */
  await chip(page, "color_palette").click();
  await expect(sheet).toHaveAttribute("data-chip", "color_palette");
  await expect(sheet.locator(".gx-fv-tile[data-plain]")).toHaveCount(51);
  await expect(sheet.locator(".gx-fv-media")).toHaveCount(0);
  await expect(sheet.getByTestId("gen-film-search")).toHaveAttribute("placeholder", "Search 50 palettes");
  await settled(sheet);
  if (phone) expect(await smallTargets(page, ".gx-sheet--vocab"), "palette targets under 44×44").toEqual([]);
  expect(await dimText(page, ".gx-sheet--vocab", ".gx-fv-name, .gx-fv-aka, .gx-fv-now"), "grid text under #7C7C84").toEqual([]);
  await shot(page, info, "cinema-palette");
  await sheet.getByTestId("gen-film-search").fill("neon");
  await expect(sheet.locator(".gx-fv-tile .gx-fv-name")).toHaveText(["Neon Rain at Midnight"]);
  await sheet.locator("[data-option='color_palette:neon-rain-at-midnight']").click();
  await expect(chip(page, "color_palette")).toHaveAttribute("aria-label", "Palette: Neon Rain at Midnight");
  /* The last chip, just set, is on top: clear of the sticky Generate and, on a phone, the tab bar. */
  const covered = await chip(page, "color_palette").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && !el.contains(hit) ? `${hit.tagName}.${hit.className}` : null;
  });
  expect(covered, "palette chip covered after its pick").toBeNull();

  /* Genre: a short grid, no search; picking what is held puts it back to Auto, and Auto is sent as nothing. */
  await chip(page, "genre").click();
  await expect(sheet.getByTestId("gen-film-search")).toHaveCount(0);
  await expect(sheet.locator(".gx-fv-tile .gx-fv-name")).toHaveText(["Auto", "Epic", "Drama", "Noir", "Comedy", "Horror", "Action"]);
  await sheet.locator("[data-option='genre:noir']").click();
  await expect(chip(page, "genre")).toHaveAttribute("aria-label", "Genre: Noir");
  await chip(page, "genre").click();
  await sheet.locator("[data-option='genre:noir']").click();
  await expect(chip(page, "genre")).toHaveAttribute("aria-label", "Genre: Auto");

  /* # in the words: Cinema Studio's names, a pick sets its chip and leaves the words as they were. */
  await prompt.click();
  await prompt.press("End");
  await prompt.pressSequentially(" #contre");
  const hash = page.getByTestId("gen-hash");
  await expect(hash).toBeVisible();
  await expect(hash.getByRole("option").first()).toContainText("Light");
  await expect(hash.getByRole("option").first()).toContainText("Contre-jour");
  await expect(hash.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await settled(hash);
  if (phone) expect(await smallTargets(page, ".gx-fv-hash"), "typeahead rows under 44×44").toEqual([]);
  await prompt.press("Enter");
  await expect(hash).toHaveCount(0);
  await expect(prompt).toHaveValue(WORDS);
  await expect(chip(page, "light")).toHaveAttribute("aria-label", "Light: Contre-jour");

  /* The price stayed where it was: no control is in the published formula, so none asked for a new one. */
  await expect(go).toHaveText("Make · about 31 cr, at most 93 cr");
  expect(reads.length).toBe(readsBefore);
  await page.getByTestId("gen-cinema").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, info, "cinema-chips");
  expect(await noOverflow(page)).toBe(true);
  expect(await dimText(page, '[data-testid="gen-cinema"]', ".gx-fv-chip-label, .gx-fv-chip-value"), "chip text under #7C7C84").toEqual([]);
  if (phone) {
    expect(await smallTargets(page, '[data-testid="gen-cinema"]'), "chip targets under 44×44").toEqual([]);
    expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  }

  /* Generate: the picks go as Cinema Studio's settings; the words are the person's own, with no setup written in. */
  await go.click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ model: CINEMA, prompt: WORDS });
  expect(priced[0].cinema).toEqual({ camera_movement: "dolly-in", light: "contre-jour", color_palette: "neon-rain-at-midnight" });
  expect(priced[0]).not.toHaveProperty("shotSpec");

  /* Back on another engine the film vocabulary's chips return; the Cinema picks wait for Cinema Studio. */
  await pickModel(page, /^Seedance 2\.5/);
  await expect(page.getByTestId("gen-cinema")).toHaveCount(0);
  await expect(page.getByTestId("gen-film").locator(".gx-fv-chip")).toHaveCount(6);
  await pickModel(page, /^Cinema Studio 4\.0/);
  await expect(chip(page, "camera_movement")).toHaveAttribute("aria-label", "Movement: Dolly in");
  expect(errors).toEqual([]);
});

test("a WAV upload is Cinema Studio's sound reference (@Audio1) at the same price; an MP3 is refused, and any other engine says why it cannot take the sound", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, priced, reads } = await openGen(page);
  await pickModel(page, /^Cinema Studio 4\.0/);
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill(`${WORDS} to the hum of @Audio1`);
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText("Make · about 31 cr, at most 93 cr");
  const well = page.getByTestId("gen-well");
  await expect(well).toContainText("Drag stills, clips or WAV sounds here from the Library.");

  /* An MP3 is not the provider's documented audio input: refused, with the reason, and nothing lands. */
  await dropId(page, well, "upload:voice-line");
  await expect(page.getByRole("alert").filter({ hasText: "Cinema Studio takes sound references as WAV files uploaded to this workspace." })).toBeVisible();
  await expect(well.locator(".gx-ref")).toHaveCount(0);
  /* A WAV lands, cited the way the engine counts it. */
  await dropId(page, well, "upload:room-tone");
  await expect(well.locator(".gx-ref")).toHaveCount(1);
  await expect(well).toContainText("@Audio1 · Room tone.wav");
  await expect(well.locator(".gx-ref-wave")).toBeVisible();
  /* Priced with the sound in the read, at the same approximate figure. */
  await expect.poll(() => reads.some((q) => q.get("model") === CINEMA && q.getAll("uploadId").includes("room-tone"))).toBe(true);
  await expect(go).toHaveText("Make · about 31 cr, at most 93 cr");
  expect(await noOverflow(page)).toBe(true);
  await well.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, info, "cinema-sound");

  await go.click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ model: CINEMA, prompt: `${WORDS} to the hum of @Audio1`, references: [{ uploadId: "room-tone", role: "reference_audio" }] });
  expect(priced[0]).not.toHaveProperty("cinema");

  /* Any other engine: Generate waits and says why, rather than reading the sound as a picture. */
  await pickModel(page, /^Seedance 2\.5/);
  await expect(page.getByTestId("gen-blocked")).toHaveText("Seedance 2.5 takes pictures and video as references, not sound. Remove the sound, or choose Cinema Studio 4.0.");
  await expect(go).toBeDisabled();
  await well.getByRole("button", { name: "Remove Room tone.wav" }).click();
  await expect(page.getByTestId("gen-blocked")).toHaveCount(0);
  await expect(go).toHaveText("Make · 12 cr");
  expect(priced).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("Recreate brings a Cinema Studio take's controls back onto its chips and its WAV sound back into References; the card says when the chips no longer hold them", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, priced } = await openGen(page, [TAKE()]);
  await page.getByTestId("make-tab-recent").click();
  await page.getByTestId("gen-view").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_cinema_take']").click();
  await page.getByTestId("asset-inspector").getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("gen-model")).toContainText("Cinema Studio 4.0");
  await expect(chip(page, "camera_movement")).toHaveAttribute("aria-label", "Movement: Crane up");
  await expect(chip(page, "genre")).toHaveAttribute("aria-label", "Genre: Noir");
  await expect(chip(page, "light")).toHaveAttribute("aria-label", "Light: Auto");
  const row = page.getByTestId("gen-recipe-cinema");
  await expect(row).toHaveText("Crane up · Noir");
  await expect(row).toHaveAttribute("data-state", "kept");
  await expect(page.getByTestId("gen-well")).toContainText("@Audio1 · Room tone.wav");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("@Audio1 hums while a lighthouse keeper climbs");
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · about 31 cr, at most 93 cr");
  await shot(page, info, "cinema-recreate");
  /* A change made here: the card says so. */
  await chip(page, "genre").click();
  await page.getByTestId("gen-film-sheet").locator("[data-option='genre:drama']").click();
  await expect(row).toHaveAttribute("data-state", "changed");
  await expect(page.getByTestId("gen-recipe-why").locator("[data-note='cinema']")).toHaveText("Controls Changed here");
  /* Generate sends the take's controls as they stand now, and its sound. */
  await page.getByTestId("gen-generate").click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0].cinema).toEqual({ camera_movement: "crane-up", genre: "drama" });
  expect(priced[0].references).toEqual([{ uploadId: "room-tone", role: "reference_audio" }]);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

/* ── The canvas dialog ───────────────────────────────────────────────── */

async function canvas(page: Page) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = {
    ...newProject("Lighthouse canvas"), id: "cinema-canvas", productionProjectId: "production-cinema", shotMappings: { "generate-node": "shot-cinema" },
    assets: [
      { id: "portrait", uploadId: "portrait-upload", name: "Keeper portrait", kind: "image", category: "Reference", url: "/campaign/character.webp", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] },
      { id: "room", uploadId: "room-upload", name: "Room tone.wav", kind: "audio", mime: "audio/wav", category: "Reference", url: "/api/uploads/room-upload", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], seconds: 6 },
    ],
    nodes: [
      { id: "reference-node", type: "media", title: "Keeper portrait", assetId: "portrait", x: 80, y: 440, width: 280, linked: [] },
      { id: "sound-node", type: "media", title: "Room tone", assetId: "room", x: 420, y: 440, width: 280, linked: [] },
      { id: "generate-node", type: "generate", title: "Lighthouse scene", text: WORDS, mode: "Video", x: 80, y: 80, width: 320, linked: ["reference-node", "sound-node"] },
    ],
  };
  let revision = 1;
  const submissions: { body: Record<string, unknown>; key: string | undefined }[] = [];
  const reads: URLSearchParams[] = [];
  const engines = [
    { id: CINEMA, label: "Cinema Studio 4.0", kind: "video", family: "cinema-studio", resolutions: ["720p", "480p"], ratios: ["16:9"], durations: [5], maxReferenceImages: 30, maxReferenceVideos: 10 },
    { id: SEEDANCE, label: "Seedance 2.5", kind: "video", family: "seedance-2", resolutions: ["720p"], ratios: ["16:9"], durations: [5], maxReferenceImages: 9, maxReferenceVideos: 3 },
  ];
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const json = (value: unknown, status = 200, headers?: Record<string, string>) => route.fulfill({ json: value, status, headers });
    if (path === "/api/me") return json(me);
    if (path === "/api/workbench/projects") {
      if (req.method() === "PUT") { project = req.postDataJSON().project; return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: project.shotMappings }); }
      if (req.method() === "POST") return json({ productionProjectId: "production-cinema", shotId: "shot-cinema" });
      return json({ project, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === "/api/workbench/engines") {
      if (!url.searchParams.has("model")) return json({ models: engines });
      reads.push(url.searchParams);
      return json(url.searchParams.get("model") === CINEMA ? { credits: 35, approximate: true } : { credits: 3 });
    }
    if (path === "/api/generate/check" && req.method() === "POST") return json({ state: "absent" });
    if (path === "/api/generate" && req.method() === "POST") {
      submissions.push({ body: req.postDataJSON(), key: req.headers()["idempotency-key"] });
      return json({ id: "cinema-take", status: "running" }, 202, { "Idempotency-Status": "complete" });
    }
    if (/^\/api\/(generate|jobs\/[^/]+\/retry|soul\/identities|audio)$/.test(path) && req.method() === "POST") throw new Error("A paid route was reached without a mock.");
    if (path === "/api/workbench/library") return json({ projectId: project.id, uploads: [], generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (path === "/api/productions") return json({ productions: [] });
    if (path === "/api/cast") return json({ cast: [] });
    if (path === "/api/uploads/room-upload") return route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.alloc(44) });
    if (path === "/api/uploads/portrait-upload") return route.fulfill({ status: 302, headers: { Location: "/campaign/character.webp" } });
    return json({});
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(await legacyShell(page, "/workbench?project=cinema-canvas&stage=canvas"));
  return { submissions, reads, errors, current: () => project };
}

async function openNode(page: Page) {
  await goWorkbenchStage(page, "canvas");
  if (page.viewportSize()!.width < 760) {
    await page.locator(".mobile-node-viewbar").getByRole("tab", { name: "List", exact: true }).click();
    await page.locator(".mobile-node-list button").filter({ hasText: "Lighthouse scene" }).click();
  } else {
    const node = page.getByRole("article", { name: "Generate node: Lighthouse scene", exact: true });
    await node.focus();
    await node.press("Enter");
  }
  await page.getByRole("button", { name: "Generate take", exact: true }).click();
  return page.getByRole("dialog", { name: "Generate a new take", exact: true });
}

test("the canvas dialog offers Cinema Studio's nine controls, each Auto; picks go as its settings with the node's WAV sound, at the same approximate price", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const f = await canvas(page);
  const phone = PHONES.includes(info.project.name);
  const dialog = await openNode(page);
  await expect(dialog.getByRole("combobox", { name: "Generation engine" })).toHaveValue(CINEMA);
  const controls = dialog.getByRole("group", { name: "Cinema Studio controls" });
  await expect(controls).toBeVisible();
  const selects = controls.getByRole("combobox");
  await expect(selects).toHaveCount(9);
  for (const [i, label] of LABELS.entries()) {
    await expect(selects.nth(i)).toHaveAttribute("aria-label", `Cinema Studio ${label.toLowerCase()}`);
    await expect(selects.nth(i)).toHaveValue("");
    await expect(selects.nth(i).locator("option").first()).toHaveText("Auto");
  }
  /* Every documented value, and nothing else, is on offer. */
  await expect(dialog.getByRole("combobox", { name: "Cinema Studio palette" }).locator("option")).toHaveCount(51);
  await expect(dialog.getByRole("combobox", { name: "Cinema Studio movement" }).locator("option")).toHaveCount(34);
  /* The node's sound is a reference here, by name. */
  await expect(dialog.getByRole("list", { name: "Bound references" })).toContainText("Room tone.wav · Sound");
  const generate = dialog.getByRole("button", { name: "Generate · about 35 cr, at most 105 cr", exact: true });
  await expect(generate).toBeEnabled();
  /* The hold is the whole of what Generate approves (lib/cinemaHold.ts): its price is never cut, at every size —
     inside the dialog and the screen, wrapping whole rather than clipped, and at least 12 px. */
  await generate.scrollIntoViewIfNeeded();
  const fit = await generate.evaluate((el) => {
    const box = el.getBoundingClientRect(), dialogBox = el.closest("[role=dialog]")!.getBoundingClientRect();
    return { uncut: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
      inside: box.left >= dialogBox.left - 0.5 && box.right <= dialogBox.right + 0.5 && box.left >= 0 && box.right <= innerWidth + 1,
      legible: parseFloat(getComputedStyle(el).fontSize) >= 12 };
  });
  expect(fit).toEqual({ uncut: true, inside: true, legible: true });
  expect(f.reads.at(-1)?.getAll("uploadId")).toEqual(["portrait-upload", "room-upload"]);
  const readsBefore = f.reads.length;

  await dialog.getByRole("combobox", { name: "Cinema Studio camera" }).selectOption({ label: "35mm film" });
  await dialog.getByRole("combobox", { name: "Cinema Studio movement" }).selectOption({ label: "Dolly in" });
  await dialog.getByRole("combobox", { name: "Cinema Studio palette" }).selectOption({ label: "After Dark" });
  await dialog.getByRole("combobox", { name: "Cinema Studio genre" }).selectOption({ label: "Noir" });
  await dialog.getByRole("combobox", { name: "Cinema Studio genre" }).selectOption({ label: "Auto" });
  /* The same approximate price, never asked for again. */
  await expect(generate).toBeEnabled();
  expect(f.reads.length).toBe(readsBefore);

  expect(await noOverflow(page)).toBe(true);
  const fits = await controls.evaluate((el) => {
    const dialogBox = el.closest("[role=dialog]")!.getBoundingClientRect();
    return Array.from(el.querySelectorAll("select")).every((s) => { const r = s.getBoundingClientRect(); return r.left >= dialogBox.left - 0.5 && r.right <= dialogBox.right + 0.5; });
  });
  expect(fits, "a select runs past the dialog").toBe(true);
  expect(await dimText(page, '[data-testid="dialog-cinema"]', "[data-functional-label], select"), "control text under #7C7C84").toEqual([]);
  const sizes = await controls.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>("span, select")).map((n) => Number.parseFloat(getComputedStyle(n).fontSize)));
  expect(Math.min(...sizes), "control text under 12px").toBeGreaterThanOrEqual(12);
  /* On touch every target in the dialog clears 44×44, not only the Cinema controls: the type and engine selects, Size,
     Aspect, Seconds, First frame, the direction, the Generate button and the close button. */
  if (phone) expect(await smallTargets(page, ".ps-dialog"), "dialog targets under 44×44").toEqual([]);
  await controls.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, info, "dialog-cinema");

  /* Another engine takes no Cinema controls and no sound; back on Cinema Studio the picks are still there. */
  await dialog.getByRole("combobox", { name: "Generation engine" }).selectOption(SEEDANCE);
  await expect(controls).toHaveCount(0);
  await expect(dialog.getByRole("list", { name: "Bound references" })).not.toContainText("Room tone.wav");
  await dialog.getByRole("combobox", { name: "Generation engine" }).selectOption(CINEMA);
  await expect(dialog.getByRole("combobox", { name: "Cinema Studio movement" })).toHaveValue("dolly-in");

  await dialog.getByRole("button", { name: "Generate · about 35 cr, at most 105 cr", exact: true }).click();
  await expect.poll(() => f.submissions.length).toBe(1);
  expect(f.submissions[0].body).toMatchObject({ model: CINEMA, projectId: "production-cinema", shotId: "shot-cinema", maxCredits: 105 });
  expect(f.submissions[0].body.cinema).toEqual({ camera_model: "35mm-film", camera_movement: "dolly-in", color_palette: "after-dark" });
  expect(f.submissions[0].body.references).toEqual([{ uploadId: "portrait-upload", role: "reference_image" }, { uploadId: "room-upload", role: "reference_audio" }]);
  await expect(dialog).toHaveCount(0);
  expect(f.errors).toEqual([]);
});
