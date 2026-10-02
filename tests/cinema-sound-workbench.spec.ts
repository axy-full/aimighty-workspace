import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { goWorkbenchStage } from "./helpers/workbenchNavigation";
import { legacyShell } from "./helpers/legacyShell";

/**
 * Cinema Studio 4.0's Sound switch, in Gen and in the canvas dialog, and its
 * Movement on Auto.
 *
 * The switch is offered only where the engines route says Cinema Studio's
 * sound is (its cost is priced privately, or this is the house workspace).
 * Most tests set that answer themselves on the engines list, so they hold on
 * any server: where sound is offered, the switch is off by default, stays off
 * when a WAV sound is attached as a reference, and turning it on asks for the
 * price again (the button shows no figure until the fresh one lands) and the
 * figure with sound is its own; Generate then sends `generateAudio`. Where it
 * is not offered, there is no switch and nothing asks for sound. Two tests
 * follow the server's own answer instead, so the same spec checks a server
 * whose sound is priced and one whose sound is not.
 *
 * With Movement on Auto the words go exactly as typed and no movement is
 * sent: the camera is the model's. Nothing reaches a paid route: a Gen press
 * stops at its re-quote, the dialog's submission is mocked, and every other
 * paid route fails the test.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = ["workbench-390x844", "workbench-1440x900"];
const CINEMA = "higgsfield-cinema-studio-4.0";
const SEEDANCE = "dreamina-seedance-2-5-260628";
const WORDS = "a lighthouse keeper climbs the spiral stairs";
const UNAVAILABLE = "Sound isn't available for Cinema Studio yet.";
/** Where the engines list says Cinema Studio's sound is offered: as the test sets it, or as the server answers. */
type Offer = "offered" | "not offered" | "server";

/* Test fixtures only. */
const ROOM = upload({ id: "room-tone", filename: "Room tone.wav", mime: "audio/wav", kind: "audio", durationS: 6, width: null, height: null });
/** A Cinema Studio take made with its Sound switch on. */
const TAKE = () => generation({
  id: "gen_cinema_sound", kind: "video", model: CINEMA, provider: "higgsfield", title: "Lighthouse take with sound", prompt: WORDS,
  params: { rawPrompt: WORDS, ratio: "16:9", resolution: "720p", duration: 5, generateAudio: true },
});

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

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

/** What covers the middle of `target`, if anything does (a sticky Generate, the tab bar, a sheet). */
const coveredBy = (target: Locator) => target.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit && !el.contains(hit) ? `${hit.tagName}.${hit.className}` : null;
});

/** A price read held until the test lets it answer, so the button can be seen without a figure meanwhile. */
function gate() {
  let open: () => void = () => {};
  const shut = new Promise<void>((resolve) => { open = resolve; });
  return { shut, open: () => open() };
}

/* ── Gen ─────────────────────────────────────────────────────────────── */

async function openGen(page: Page, generations: ReturnType<typeof generation>[] = [], offer: Offer = "offered") {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject("Lighthouse study"), id: "ws-cinema-sound", productionProjectId: "prod-ws", shotMappings: {} } });
  await mockLibrary(page, { uploads: [ROOM], generations });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  await page.route(/\/api\/uploads\/room-tone\/metadata$/, (route) => route.fulfill({ json: { upload: ROOM } }));
  const reads: URLSearchParams[] = [];
  let hold: Promise<void> | null = null;
  if (offer !== "server") {
    /* The engines list, as the server writes it, with Cinema Studio's sound offered or not as the test says. */
    await page.route(/\/api\/workbench\/engines(\?.*)?$/, async (route) => {
      if (new URL(route.request().url()).searchParams.has("model")) return route.fallback();
      const response = await route.fetch();
      const json = await response.json() as { models?: { id: string; sound?: boolean }[] };
      for (const row of json.models ?? []) if (row.id === CINEMA) { if (offer === "offered") row.sound = true; else delete row.sound; }
      return route.fulfill({ response, json });
    });
    /* The composer's price reads (GET, never a charge). Cinema Studio's is approximate, and a take with sound has its
       own figure (what sound's measured charge adds). A read for sound can be held by the test. */
    await page.route(/\/api\/workbench\/engines\?.*model=/, async (route) => {
      const query = new URL(route.request().url()).searchParams;
      reads.push(query);
      if (query.get("audio") === "1" && hold) await hold;
      return route.fulfill({ json: query.get("model") === CINEMA ? { credits: query.get("audio") === "1" ? 36 : 31, approximate: true } : { credits: 12 } });
    });
  }
  /* Generate's own re-quote is where a press would first spend: recorded and refused, so nothing runs. */
  const priced: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => {
    priced.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 409, json: { error: "Stopped by the test before anything ran." } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 300)); });
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Lighthouse study");
  await expect(page.getByTestId("gen-model")).toContainText("Seedance");
  return { errors, priced, reads, holdSound: (until: Promise<void> | null) => { hold = until; } };
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

test("Gen: the Sound switch is off on Cinema Studio, a WAV reference leaves it off, and with Movement on Auto the words go as typed with no movement", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, priced, reads } = await openGen(page);
  const phone = PHONES.includes(info.project.name);
  /* No switch on an engine Gen has none for. */
  await expect(page.getByTestId("gen-sound-option")).toHaveCount(0);
  await pickModel(page, /^Cinema Studio 4\.0/);
  const row = page.getByTestId("gen-sound-option");
  const sound = page.getByTestId("gen-sound-toggle");
  await expect(row.locator(".gx-eyebrow")).toHaveText("Sound");
  await expect(sound).toHaveRole("switch");
  await expect(sound).toHaveAccessibleName("With sound");
  await expect(sound).toHaveAttribute("aria-checked", "false");
  /* Movement is on Auto, like every control. */
  await expect(page.getByTestId("gen-cinema-camera_movement")).toHaveAttribute("aria-label", "Movement: Auto");

  await page.getByTestId("gen-prompt").fill(WORDS);
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText("Generate · about 31 cr");
  /* A WAV dropped as a reference is cited and priced, and the switch stays where it was. */
  const well = page.getByTestId("gen-well");
  await dropId(page, well, "upload:room-tone");
  await expect(well).toContainText("@Audio1 · Room tone.wav");
  await expect.poll(() => reads.some((q) => q.get("model") === CINEMA && q.getAll("uploadId").includes("room-tone"))).toBe(true);
  await expect(sound).toHaveAttribute("aria-checked", "false");
  expect(reads.every((q) => !q.has("audio")), "a read asked for sound").toBe(true);
  await expect(go).toHaveText("Generate · about 31 cr");

  /* The floors, on the switch: clear of the sticky Generate and the tab bar, a full target, a readable label. */
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
  expect(await coveredBy(sound), "switch covered").toBeNull();
  expect(await noOverflow(page)).toBe(true);
  expect(await dimText(page, '[data-testid="gen-sound-option"]', ".gx-eyebrow, .gx-toggle span"), "switch text under #7C7C84").toEqual([]);
  if (phone) {
    expect(await smallTargets(page, '[data-testid="gen-sound-option"]'), "switch under 44×44").toEqual([]);
    expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  }
  await shot(page, info, "gen-sound-off");

  /* Generate: silent (no generateAudio at all), the sound as a reference, the words exactly as typed, no movement. */
  await go.click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ model: CINEMA, prompt: WORDS, references: [{ uploadId: "room-tone", role: "reference_audio" }] });
  expect(priced[0]).not.toHaveProperty("generateAudio");
  expect(priced[0]).not.toHaveProperty("cinema");
  expect(priced[0]).not.toHaveProperty("shotSpec");
  expect(errors).toEqual([]);
});

test("Gen: turning Sound on asks for the price again, at the figure for a take with sound; Generate sends it, and turning it off asks again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, priced, reads, holdSound } = await openGen(page);
  const phone = PHONES.includes(info.project.name);
  await pickModel(page, /^Cinema Studio 4\.0/);
  await page.getByTestId("gen-prompt").fill(WORDS);
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText("Generate · about 31 cr");
  const sound = page.getByTestId("gen-sound-toggle");
  await sound.scrollIntoViewIfNeeded();

  /* On: the figure on the button was for a silent take, so it goes until the fresh read for sound answers. */
  const held = gate();
  holdSound(held.shut);
  const before = reads.length;
  await sound.click();
  await expect(sound).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => reads.slice(before).some((q) => q.get("model") === CINEMA && q.get("audio") === "1")).toBe(true);
  await expect(page.getByTestId("gen-blocked")).toHaveText("Getting the live price…");
  await expect(go).not.toContainText("cr");
  if (phone) expect(await smallTargets(page, '[data-testid="gen-sound-option"]'), "switch under 44×44 when on").toEqual([]);
  expect(await dimText(page, '[data-testid="gen-sound-option"]', ".gx-eyebrow, .gx-toggle span"), "switch text under #7C7C84 when on").toEqual([]);
  held.open();
  holdSound(null);
  /* The fresh figure is the one for a take with sound. */
  await expect(go).toHaveText("Generate · about 36 cr");
  expect(await noOverflow(page)).toBe(true);
  await shot(page, info, "gen-sound-on");

  /* Generate: the re-quote is for the take with sound. */
  await go.click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ model: CINEMA, prompt: WORDS, generateAudio: true });

  /* Off again: priced again, for a silent take. */
  const again = reads.length;
  await sound.click();
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => reads.slice(again).some((q) => q.get("model") === CINEMA && !q.has("audio"))).toBe(true);
  await expect(go).toHaveText("Generate · about 31 cr");
  /* Another engine has no switch; back on Cinema Studio it is as it was left. */
  await pickModel(page, /^Seedance 2\.5/);
  await expect(page.getByTestId("gen-sound-option")).toHaveCount(0);
  await pickModel(page, /^Cinema Studio 4\.0/);
  await expect(page.getByTestId("gen-sound-toggle")).toHaveAttribute("aria-checked", "false");
  expect(errors).toEqual([]);
});

test("Gen: Recreate of a Cinema Studio take made with sound turns the switch back on, and the card says when it is changed here", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, priced, reads } = await openGen(page, [TAKE()]);
  await page.getByTestId("gen-view").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_cinema_sound']").click();
  await page.getByTestId("asset-inspector").getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("gen-model")).toContainText("Cinema Studio 4.0");
  const sound = page.getByTestId("gen-sound-toggle");
  await expect(sound).toHaveAttribute("aria-checked", "true");
  const chip = page.getByTestId("gen-recipe-chips").locator("[data-chip='sound']");
  await expect(chip).toHaveText("With sound");
  await expect(chip).toHaveAttribute("data-state", "kept");
  await expect.poll(() => reads.some((q) => q.get("model") === CINEMA && q.get("audio") === "1")).toBe(true);
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · about 36 cr");
  await shot(page, info, "gen-sound-recreate");
  /* Turned off here: the card says so, and Generate sends a silent take. */
  await sound.scrollIntoViewIfNeeded();
  await sound.click();
  await expect(chip).toHaveText("With sound → silent");
  await expect(chip).toHaveAttribute("data-state", "changed");
  await expect(page.getByTestId("gen-recipe-why").locator("[data-note='sound']")).toHaveText("Sound Changed here");
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · about 31 cr");
  await page.getByTestId("gen-generate").click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ model: CINEMA, prompt: WORDS });
  expect(priced[0]).not.toHaveProperty("generateAudio");
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("Gen, where sound is not offered: Cinema Studio has no Sound switch, a Recreate of a take made with sound comes back silent and says why, and nothing asks for sound", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, priced, reads } = await openGen(page, [TAKE()], "not offered");
  await pickModel(page, /^Cinema Studio 4\.0/);
  await expect(page.getByTestId("gen-cinema-camera_movement")).toBeVisible();
  await expect(page.getByTestId("gen-sound-option")).toHaveCount(0);
  await expect(page.getByTestId("gen-sound-toggle")).toHaveCount(0);
  /* Recreate of a take made with sound: the switch cannot come back here, and the card says so. */
  await page.getByTestId("gen-view").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_cinema_sound']").click();
  await page.getByTestId("asset-inspector").getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("gen-model")).toContainText("Cinema Studio 4.0");
  const chip = page.getByTestId("gen-recipe-chips").locator("[data-chip='sound']");
  await expect(chip).toHaveText("With sound → silent");
  await expect(chip).toHaveAttribute("data-state", "changed");
  await expect(page.getByTestId("gen-recipe-why").locator("[data-note='sound']")).toHaveText("Sound Cinema Studio 4.0 has no Sound switch here");
  await expect(page.getByTestId("gen-sound-option")).toHaveCount(0);
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText("Generate · about 31 cr");
  expect(reads.some((q) => q.has("audio")), "a read asked for sound").toBe(false);
  expect(await noOverflow(page)).toBe(true);
  await shot(page, info, "gen-sound-not-offered");
  await go.click();
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ model: CINEMA, prompt: WORDS });
  expect(priced[0]).not.toHaveProperty("generateAudio");
  expect(errors).toEqual([]);
});

test("Gen follows the server's own answer: the Sound switch shows only where the server offers Cinema Studio's sound, and the figures are the server's", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, priced } = await openGen(page, [], "server");
  const listed = await (await page.request.get("/api/workbench/engines")).json() as { models: { id: string; sound?: boolean }[] };
  const offered = listed.models.find((row) => row.id === CINEMA)?.sound === true;
  /* The page's own price reads, answered by the server. */
  const answer = (audio: boolean) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/workbench/engines" && url.searchParams.get("model") === CINEMA && (url.searchParams.get("audio") === "1") === audio;
  });
  const silentRead = answer(false);
  await pickModel(page, /^Cinema Studio 4\.0/);
  await page.getByTestId("gen-prompt").fill(WORDS);
  const silentResponse = await silentRead;
  const silent = await silentResponse.json() as { credits: number };
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(`Generate · about ${silent.credits} cr`);
  if (!offered) {
    await expect(page.getByTestId("gen-sound-option")).toHaveCount(0);
    /* Asked for by hand, sound is refused by the price read and by admission alike, before anything is reserved or sent. */
    const url = new URL(silentResponse.url());
    url.searchParams.set("audio", "1");
    const read = await page.request.get(url.pathname + url.search);
    expect(read.status()).toBe(400);
    expect(await read.json()).toEqual({ error: UNAVAILABLE });
    const quote = await page.request.post("/api/generate/quote", { data: { model: CINEMA, prompt: WORDS, ratio: "16:9", resolution: "720p", duration: 5, refine: false, generateAudio: true } });
    expect(quote.status()).toBe(400);
    expect(await quote.json()).toEqual({ error: UNAVAILABLE });
  } else {
    /* Offered: on, the server prices the take with sound, and that figure is the button's. */
    const loudRead = answer(true);
    const sound = page.getByTestId("gen-sound-toggle");
    await sound.scrollIntoViewIfNeeded();
    await sound.click();
    const loud = await (await loudRead).json() as { credits: number };
    expect(loud.credits).toBeGreaterThanOrEqual(silent.credits);
    await expect(go).toHaveText(`Generate · about ${loud.credits} cr`);
    await go.click();
    await expect.poll(() => priced.length).toBe(1);
    expect(priced[0]).toMatchObject({ model: CINEMA, prompt: WORDS, generateAudio: true });
  }
  expect(errors).toEqual([]);
});

/* ── The canvas dialog ───────────────────────────────────────────────── */

async function canvas(page: Page, offer: Offer = "offered") {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = {
    ...newProject("Lighthouse canvas"), id: "cinema-sound-canvas", productionProjectId: "production-cinema", shotMappings: { "generate-node": "shot-cinema" },
    assets: [
      { id: "room", uploadId: "room-upload", name: "Room tone.wav", kind: "audio", mime: "audio/wav", category: "Reference", url: "/api/uploads/room-upload", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], seconds: 6 },
    ],
    nodes: [
      { id: "sound-node", type: "media", title: "Room tone", assetId: "room", x: 420, y: 440, width: 280, linked: [] },
      { id: "generate-node", type: "generate", title: "Lighthouse scene", text: WORDS, mode: "Video", x: 80, y: 80, width: 320, linked: ["sound-node"] },
    ],
  };
  let revision = 1;
  const submissions: Record<string, unknown>[] = [];
  const reads: URLSearchParams[] = [];
  let hold: Promise<void> | null = null;
  const engines = [
    { id: CINEMA, label: "Cinema Studio 4.0", kind: "video", family: "cinema-studio", resolutions: ["720p", "480p"], ratios: ["16:9"], durations: [5], maxReferenceImages: 30, maxReferenceVideos: 10,
      ...(offer === "offered" ? { sound: true } : {}) },
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
      /* The server's own list and figures, where the test follows the server. */
      if (offer === "server") return route.continue();
      if (!url.searchParams.has("model")) return json({ models: engines });
      reads.push(url.searchParams);
      if (url.searchParams.get("audio") === "1" && hold) await hold;
      return json(url.searchParams.get("model") === CINEMA ? { credits: url.searchParams.get("audio") === "1" ? 40 : 35, approximate: true } : { credits: 3 });
    }
    if (path === "/api/generate/check" && req.method() === "POST") return json({ state: "absent" });
    if (path === "/api/generate" && req.method() === "POST") {
      submissions.push(req.postDataJSON());
      return json({ id: "cinema-sound-take", status: "running" }, 202, { "Idempotency-Status": "complete" });
    }
    if (/^\/api\/(generate|jobs\/[^/]+\/retry|soul\/identities|audio)$/.test(path) && req.method() === "POST") throw new Error("A paid route was reached without a mock.");
    if (path === "/api/workbench/library") return json({ projectId: project.id, uploads: [], generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (path === "/api/productions") return json({ productions: [] });
    if (path === "/api/cast") return json({ cast: [] });
    if (path === "/api/uploads/room-upload") return route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.alloc(44) });
    return json({});
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(await legacyShell(page, "/workbench?project=cinema-sound-canvas&stage=canvas"));
  return { submissions, reads, errors, holdSound: (until: Promise<void> | null) => { hold = until; } };
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

test("the canvas dialog, where sound is offered: Sound is off with the node's WAV bound; on, the price is read again, at the figure for a take with sound, and the take is sent with sound", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const f = await canvas(page);
  const phone = PHONES.includes(info.project.name);
  const dialog = await openNode(page);
  await expect(dialog.getByRole("combobox", { name: "Generation engine" })).toHaveValue(CINEMA);
  await expect(dialog.getByRole("list", { name: "Bound references" })).toContainText("Room tone.wav · Sound");
  const sound = dialog.getByRole("switch", { name: "With sound" });
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByRole("button", { name: "Generate · about 35 cr", exact: true })).toBeEnabled();
  expect(f.reads.every((q) => !q.has("audio")), "a read asked for sound").toBe(true);

  /* The floors, on the switch. */
  await sound.scrollIntoViewIfNeeded();
  expect(await coveredBy(sound), "switch covered").toBeNull();
  const box = (await sound.boundingBox())!;
  if (phone) {
    expect(box.width, "switch width").toBeGreaterThanOrEqual(43.5);
    expect(box.height, "switch height").toBeGreaterThanOrEqual(43.5);
  }
  const dialogBox = (await dialog.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 0.5);
  expect(await dimText(page, '[role="dialog"]', '[data-testid="dialog-cinema-sound"] span'), "switch text under #7C7C84").toEqual([]);
  const size = await sound.locator("span").last().evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  expect(size, "switch text under 12px").toBeGreaterThanOrEqual(12);
  expect(await noOverflow(page)).toBe(true);

  /* On: no figure until the fresh read for sound answers, then that figure: the one for a take with sound. */
  const held = gate();
  f.holdSound(held.shut);
  const before = f.reads.length;
  await sound.click();
  await expect(sound).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => f.reads.slice(before).some((q) => q.get("model") === CINEMA && q.get("audio") === "1")).toBe(true);
  await expect(dialog.getByRole("button", { name: "Loading estimate…", exact: true })).toBeDisabled();
  held.open();
  f.holdSound(null);
  const generate = dialog.getByRole("button", { name: "Generate · about 40 cr", exact: true });
  await expect(generate).toBeEnabled();
  expect(f.reads.at(-1)?.getAll("uploadId")).toEqual(["room-upload"]);
  await sound.scrollIntoViewIfNeeded();
  await shot(page, info, "dialog-sound-on");

  await generate.click();
  await expect.poll(() => f.submissions.length).toBe(1);
  expect(f.submissions[0]).toMatchObject({ model: CINEMA, generateAudio: true, maxCredits: 40, references: [{ uploadId: "room-upload", role: "reference_audio" }] });
  await expect(dialog).toHaveCount(0);
  /* The node's first input is the WAV, so the inspector's monitor holds that sound, at full volume. The node's own mode
     ("Video") is not a volume; read as one, it threw and stopped the page. */
  if (!phone) await expect.poll(() => page.getByRole("complementary", { name: "Node inspector" }).locator("audio").evaluate((el) => (el as HTMLAudioElement).volume)).toBe(1);
  expect(f.errors).toEqual([]);
});

test("the canvas dialog, where sound is offered: off, the take goes silent with its sound reference, and with Movement on Auto the words go as typed with no movement", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const f = await canvas(page);
  const dialog = await openNode(page);
  await expect(dialog.getByRole("combobox", { name: "Cinema Studio movement" })).toHaveValue("");
  const sound = dialog.getByRole("switch", { name: "With sound" });
  await expect(sound).toHaveAttribute("aria-checked", "false");
  /* On and off again: back to the silent take's price read. */
  await sound.click();
  await expect.poll(() => f.reads.some((q) => q.get("audio") === "1")).toBe(true);
  const back = f.reads.length;
  await sound.click();
  await expect(sound).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => f.reads.slice(back).some((q) => q.get("model") === CINEMA && !q.has("audio"))).toBe(true);
  /* Another engine has no switch. */
  await dialog.getByRole("combobox", { name: "Generation engine" }).selectOption(SEEDANCE);
  await expect(dialog.getByRole("switch", { name: "With sound" })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "Generation engine" }).selectOption(CINEMA);
  await expect(dialog.getByRole("switch", { name: "With sound" })).toHaveAttribute("aria-checked", "false");

  /* The words are the dialog's direction, which starts from the node's brief: sent exactly as shown, never rewritten. */
  const direction = await dialog.getByRole("textbox", { name: "Generation direction" }).inputValue();
  expect(direction).toContain(WORDS);
  await dialog.getByRole("button", { name: "Generate · about 35 cr", exact: true }).click();
  await expect.poll(() => f.submissions.length).toBe(1);
  expect(f.submissions[0]).toMatchObject({ model: CINEMA, prompt: direction, refine: false, references: [{ uploadId: "room-upload", role: "reference_audio" }] });
  expect(f.submissions[0]).not.toHaveProperty("generateAudio");
  expect(f.submissions[0]).not.toHaveProperty("cinema");
  expect(f.errors).toEqual([]);
});

test("the canvas dialog, where sound is not offered: no Sound switch with the node's WAV bound, and the take goes silent with it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const f = await canvas(page, "not offered");
  const dialog = await openNode(page);
  await expect(dialog.getByRole("combobox", { name: "Generation engine" })).toHaveValue(CINEMA);
  await expect(dialog.getByRole("group", { name: "Cinema Studio controls" })).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Bound references" })).toContainText("Room tone.wav · Sound");
  await expect(dialog.getByRole("switch", { name: "With sound" })).toHaveCount(0);
  await expect(dialog.getByTestId("dialog-cinema-sound")).toHaveCount(0);
  const generate = dialog.getByRole("button", { name: "Generate · about 35 cr", exact: true });
  await expect(generate).toBeEnabled();
  expect(f.reads.some((q) => q.has("audio")), "a read asked for sound").toBe(false);
  expect(await noOverflow(page)).toBe(true);
  await shot(page, info, "dialog-sound-not-offered");
  await generate.click();
  await expect.poll(() => f.submissions.length).toBe(1);
  expect(f.submissions[0]).toMatchObject({ model: CINEMA, maxCredits: 35, references: [{ uploadId: "room-upload", role: "reference_audio" }] });
  expect(f.submissions[0]).not.toHaveProperty("generateAudio");
  expect(f.errors).toEqual([]);
});

test("the canvas dialog follows the server's own answer: its Sound switch shows only where the server offers Cinema Studio's sound", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const f = await canvas(page, "server");
  const listed = await (await page.request.get("/api/workbench/engines")).json() as { models: { id: string; sound?: boolean }[] };
  const offered = listed.models.find((row) => row.id === CINEMA)?.sound === true;
  const dialog = await openNode(page);
  await dialog.getByRole("combobox", { name: "Generation engine" }).selectOption(CINEMA);
  await expect(dialog.getByRole("group", { name: "Cinema Studio controls" })).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "With sound" })).toHaveCount(offered ? 1 : 0);
  if (offered) await expect(dialog.getByRole("switch", { name: "With sound" })).toHaveAttribute("aria-checked", "false");
  expect(f.submissions).toEqual([]);
  expect(f.errors).toEqual([]);
});
