import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { openAdvanced } from "./helpers/makeAdvanced";
import { projectName } from "./helpers/projectName";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here"); });

/**
 * Idea 23 — Gen's Audio output is whole: a line has a voice picker whose list
 * is the chosen speech model's own (ElevenLabs' voices, or Grok Voice's, swapped
 * with the model), effects and music have a length stepper, and music has an
 * Instrumental switch. Every one of them moves the price's key, so each change
 * is quoted again before the button shows a figure, and Generate re-quotes the
 * exact body and sends it once with that figure as its ceiling. 3D is not one of
 * Gen's outputs, so Gen offers no 3D tab (its copy no longer promises one).
 * The audio setup, its quotes and its one submission are mocks that count every
 * charge; nothing is priced or spent. Screenshots are opt-in: GEN_COVERAGE_SHOTS=<dir>.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.GEN_COVERAGE_SHOTS;
const DRAFT = "ws-sound";
const fixture = (): Project => ({ ...newProject("Harbour sound study"), id: DRAFT, productionProjectId: "prod-ws", shotMappings: {} });

/* Test fixtures: GET /api/audio's shape for a workspace on both sound vendors (lib/elevenlabs.ts, lib/xaiVoice.ts). */
const voice = (id: string, name: string, category = "premade") => ({ id, name, category, labels: {}, previewUrl: null, description: "" });
const ELEVEN_VOICES = [voice("21m00Tcm4TlvDq8ikWAM", "Rachel"), voice("EXAVITQu4vr4xnSDxMaL", "Sarah")];
const GROK_VOICES = [voice("eve", "Eve", "grok"), voice("ara", "Ara", "grok"), voice("rex", "Rex", "grok")];
const SETUP = {
  configured: true, vendors: { elevenlabs: true, xai: true }, envKey: "ELEVENLABS_API_KEY",
  speechModels: [
    { id: "eleven_multilingual_v2", label: "Multilingual v2", creditsPerChar: 1, note: "The dependable studio voice — 29 languages, the most consistent read." },
    { id: "grok-tts", label: "Grok Voice", creditsPerChar: 0, vendor: "xai", note: "xAI's voice: 20 languages, speech tags in the text." },
  ],
  defaultSpeechModel: "eleven_multilingual_v2", voices: ELEVEN_VOICES, grokVoices: GROK_VOICES, voicesError: null, grokVoicesError: null,
  account: null, accountError: null, terms: { sfxCredits: 200, musicCreditsPerMinute: 900 },
};
/* One Studio video engine, so Gen opens as it does; the audio rows' own rates, where the composer's length stands. */
const ENGINES = [
  { id: "dreamina-seedance-2-5-260628", kind: "video", resolutions: ["480p", "720p"], ratios: ["16:9", "9:16"], durations: [5, 10], use: "Cinematic motion from a prompt or references.", rate: { credits: 18, resolution: "480p", ratio: "16:9", duration: 5 } },
];
/* The mock's prices: a line by its voice (never by another vendor's), music by its length and vocals, an effect flat. */
function priceOf(body: Record<string, unknown>): number {
  if (body.task === "music") return 10 + Math.round(Number(body.lengthMs) / 1000) + (body.instrumental ? 0 : 5);
  if (body.task === "sound") return 3;
  return body.modelId === "grok-tts" ? (body.voiceId === "ara" ? 3 : 2) : 4;
}

type Quote = Record<string, unknown>;
type Charge = { body: Record<string, unknown>; key: string | null };

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  await page.route(/\/api\/workbench\/engines(\?.*)?$/, (route) => {
    const q = new URL(route.request().url()).searchParams;
    const seconds = Math.max(10, Math.min(300, Number(q.get("seconds") || 10)));
    return route.fulfill({ json: { models: ENGINES, audio: { sound: { credits: 3, seconds: null }, music: { credits: 10 + seconds, seconds } }, credits: q.has("model") ? 18 : null } });
  });
  /* The audio admission: every quote is kept, a line in the other vendor's voice is refused (as the route refuses it),
     and each submission is a charge — counted, never billed. */
  const quotes: Quote[] = [], charges: Charge[] = [], mismatched: Quote[] = [];
  await page.route(/\/api\/audio$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: SETUP });
    const body = request.postDataJSON() as Record<string, unknown>;
    const grok = GROK_VOICES.some((v) => v.id === body.voiceId);
    if (body.task === "speech" && (body.modelId === "grok-tts") !== grok) {
      mismatched.push(body);
      return route.fulfill({ status: 400, json: { error: body.modelId === "grok-tts" ? "Pick a Grok voice." : "Pick a voice." } });
    }
    if (body.quoteOnly === true) {
      quotes.push(body);
      const credits = priceOf(body);
      return route.fulfill({ json: { estimatedCredits: credits, price: credits, unit: "cr" } });
    }
    charges.push({ body, key: request.headers()["idempotency-key"] ?? null });
    if (Number(body.maxCredits) !== priceOf(body)) return route.fulfill({ status: 409, json: { error: "The price changed." } });
    return route.fulfill({ json: { id: `gen_sound_${charges.length}`, status: "running" }, headers: { "Idempotency-Status": "complete" } });
  });
  await page.route(/\/api\/jobs\/gen_sound_\d+(\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    return route.fulfill({ json: { generation: generation({ id, kind: "audio", status: "running", task: "speech" }) } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?make=video&project=${DRAFT}`);
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  await expect(projectName(page)).toHaveText("Harbour sound study");
  return { quotes, charges, mismatched, errors, store };
}

/** Picks a model by its name in Make's engine list (under Change); picking closes the list, and the engine line names it. */
async function pickModel(page: Page, name: RegExp) {
  const change = page.getByTestId("gen-model");
  if ((await change.getAttribute("aria-expanded")) !== "true") await change.click();
  const list = page.getByTestId("make-engines");
  await expect(list).toBeVisible();
  await list.getByTestId("make-engine-row").filter({ has: page.locator(".gx-mk-row-name", { hasText: name }) }).first().click();
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId("make-engine-line").locator(".gx-mk-part").first()).toHaveText(name);
}
/** The list open again (picking closes it): the voice, the length and Instrumental are in it. */
async function openList(page: Page) {
  const change = page.getByTestId("gen-model");
  if ((await change.getAttribute("aria-expanded")) !== "true") await change.click();
  await expect(page.getByTestId("make-engines")).toBeVisible();
}

const optionLabels = (page: Page) => page.getByTestId("gen-voice").locator("option").allTextContents();
const generateButton = (page: Page) => page.getByTestId("gen-generate");
/** A sound's figure is a live estimate: "Make · up to N cr" or "Make · N cr", never a different N. */
const makeAt = (n: number) => new RegExp(`^Make · (up to )?${n} cr$`);

/** Generate's label, measured against the button's own box: every run of text sits inside it, the price whole, also in a wide fallback sans. */
async function labelFits(page: Page) {
  const check = () => generateButton(page).evaluate((button) => {
    const box = button.getBoundingClientRect(), style = getComputedStyle(button);
    const left = box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) - 0.5;
    const right = box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) + 0.5;
    const out: string[] = [];
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      if (!text || !node.parentElement?.getClientRects().length) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects()))
        if (r.width && (r.left < left || r.right > right || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)) out.push(`“${text}” runs past the button`);
    }
    return out;
  });
  expect(await check(), "Make's label fits its button").toEqual([]);
  const wide = await page.addStyleTag({ content: '[data-testid="gen-view"], [data-testid="gen-view"] * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }' });
  expect(await check(), "Make's label fits its button in a wide fallback sans").toEqual([]);
  await wide.evaluate((el) => (el as HTMLStyleElement).remove());
}

/** Nothing scrolls sideways and the button's price is whole, in Make's panel. */
async function floors(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);
  await labelFits(page);
}

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = info.project.name.replace("workbench-", "");
  /* The model row at the top of the scroller, so the rows under it show above the sticky Generate. */
  await page.getByTestId("gen-model").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: path.join(SHOTS, `${name}-${size}.png`) });
}

test("a line: the voice list is the chosen model's own and swaps with it, each change is priced again, and one Make sends the voice on the button at its price", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { quotes, charges, mismatched, errors } = await open(page);
  /* Make offers video, images and sound: no 3D, whoever is signed in. Analysis ran through the signed-in
     account, which is retired, so it is gone for everyone. */
  await expect(page.getByRole("radiogroup", { name: "Type" }).getByRole("radio")).toHaveText(["Video", "Image", "Audio"]);
  await page.getByTestId("make-type-audio").click();
  await pickModel(page, /^Grok Voice$/);
  const line = "Not tonight. The ice will hold until morning.";
  await page.getByTestId("gen-prompt").fill(line);
  await openList(page);

  /* Grok Voice reads in xAI's own voices, the first chosen until the person picks: the line is priced in it. */
  expect(await optionLabels(page)).toEqual(["Eve", "Ara", "Rex"]);
  await expect(page.getByTestId("gen-voice")).toHaveValue("eve");
  await expect(generateButton(page)).toHaveText(makeAt(2));
  expect(quotes.at(-1)).toMatchObject({ task: "speech", modelId: "grok-tts", voiceId: "eve", text: line });
  await expect(page.getByTestId("make-engine-line")).toContainText("Eve");

  /* Another voice is another price: the old figure never stands beside the new voice. */
  let asked = quotes.length;
  await page.getByTestId("gen-voice").selectOption("ara");
  await expect(generateButton(page)).toHaveText(makeAt(3));
  await expect(page.getByTestId("make-engine-price")).toHaveText(/^(up to )?3 cr$/);
  expect(quotes.length).toBeGreaterThan(asked);
  expect(quotes.at(-1)).toMatchObject({ modelId: "grok-tts", voiceId: "ara" });

  /* An ElevenLabs model swaps the list, and a Grok voice is never carried over: the line falls to its first voice. */
  asked = quotes.length;
  await pickModel(page, /^Eleven Multilingual v2$/);
  await openList(page);
  expect(await optionLabels(page)).toEqual(["Rachel", "Sarah"]);
  await expect(page.getByTestId("gen-voice")).toHaveValue(ELEVEN_VOICES[0].id);
  await expect(generateButton(page)).toHaveText(makeAt(4));
  expect(quotes.slice(asked).every((q) => q.modelId === "eleven_multilingual_v2" && q.voiceId === ELEVEN_VOICES[0].id)).toBe(true);
  await page.getByTestId("gen-voice").selectOption(ELEVEN_VOICES[1].id);
  await expect.poll(() => quotes.at(-1)?.voiceId).toBe(ELEVEN_VOICES[1].id);
  await expect(generateButton(page)).toHaveText(makeAt(4));
  /* No line was ever priced in the other vendor's voice. */
  expect(mismatched).toEqual([]);
  await floors(page);
  await shot(page, info, "voice");

  /* Make: settled first, priced again exactly as it is sent, then sent once with the button's figure as its ceiling. */
  expect(charges).toEqual([]);
  asked = quotes.length;
  await generateButton(page).click();
  await expect.poll(() => charges.length).toBe(1);
  expect(quotes.length).toBe(asked + 1);
  const sent = charges[0].body;
  expect(sent).toMatchObject({ task: "speech", modelId: "eleven_multilingual_v2", voiceId: ELEVEN_VOICES[1].id, text: line, maxCredits: 4, projectId: "prod-ws" });
  expect(String(sent.shotId)).toMatch(/^shot_/);
  expect(charges[0].key).toBeTruthy();
  /* The body sent is the body last priced, plus only its ceiling and where it files. */
  const without = (body: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(body).filter(([k]) => !keys.includes(k)));
  expect(without(sent, ["maxCredits", "projectId", "shotId"])).toEqual(without(quotes.at(-1)!, ["quoteOnly"]));
  await page.waitForTimeout(500);
  expect(charges).toHaveLength(1);
  expect(mismatched).toEqual([]);
  expect(errors).toEqual([]);
});

test("effects and music: the length and Instrumental each price the take again, and Make sends the length and vocals on the button", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { quotes, charges, errors } = await open(page);
  await page.getByTestId("make-type-audio").click();
  /* Make opens sound on a voice (priced by its words); effects are one pick away, at ten seconds. */
  await pickModel(page, /^Eleven Sound Effects$/);
  const cue = "A slow cello under rain on a tin roof";
  await page.getByTestId("gen-prompt").fill(cue);
  await openList(page);
  const stepper = page.getByTestId("gen-seconds");
  const value = page.getByTestId("gen-seconds-value");
  const instrumental = page.getByTestId("gen-instrumental");
  const shorter = stepper.getByRole("button", { name: "Shorter" }), longer = stepper.getByRole("button", { name: "Longer" });
  await expect(value).toHaveText("10 s");
  await expect(generateButton(page)).toHaveText(makeAt(3));
  expect(quotes.at(-1)).toMatchObject({ task: "sound", durationSeconds: 10, text: cue });
  /* An effect has no vocals to switch, and runs one second at a time to thirty: every length is priced as it is sent. */
  await expect(instrumental).toHaveCount(0);
  for (let i = 0; i < 20; i++) await longer.click();
  await expect(value).toHaveText("30 s");
  await expect(longer).toBeDisabled();
  await expect.poll(() => quotes.at(-1)?.durationSeconds).toBe(30);
  await expect(generateButton(page)).toHaveText(makeAt(3));
  await expect(page.getByTestId("make-engine-line")).toContainText("30 s");

  /* Music keeps the length while it is in range (30 s is one of its chips); every chip is a new length, priced again. */
  await pickModel(page, /^Eleven Music$/);
  await openList(page);
  await expect(page.getByTestId("gen-seconds-value")).toHaveText("30 s");
  await expect(instrumental).toHaveAttribute("aria-checked", "true");
  await expect(generateButton(page)).toHaveText(makeAt(40));
  expect(quotes.at(-1)).toMatchObject({ task: "music", lengthMs: 30_000, instrumental: true, text: cue });
  const chips = page.getByTestId("gen-seconds").getByTestId("make-music-chip");
  await chips.filter({ hasText: /^15 s$/ }).click();
  await expect(generateButton(page)).toHaveText(makeAt(25));
  expect(quotes.at(-1)).toMatchObject({ lengthMs: 15_000, instrumental: true });
  /* Each press is a new length, and a new price before the button shows one. */
  await chips.filter({ hasText: /^60 s$/ }).click();
  await expect(generateButton(page)).toHaveText(makeAt(70));
  expect(quotes.at(-1)).toMatchObject({ lengthMs: 60_000, instrumental: true });
  await chips.filter({ hasText: /^30 s$/ }).click();
  await expect(generateButton(page)).toHaveText(makeAt(40));

  /* Vocals are another take: priced again. */
  let asked = quotes.length;
  await instrumental.click();
  await expect(instrumental).toHaveAttribute("aria-checked", "false");
  await expect(generateButton(page)).toHaveText(makeAt(45));
  expect(quotes.length).toBeGreaterThan(asked);
  expect(quotes.at(-1)).toMatchObject({ lengthMs: 30_000, instrumental: false });
  await expect(page.getByTestId("make-engine-price")).toHaveText(/^(up to )?45 cr$/);
  await floors(page);
  await shot(page, info, "music");

  /* Make: priced again exactly as it is sent, then sent once, the button's figure its ceiling. */
  expect(charges).toEqual([]);
  asked = quotes.length;
  await generateButton(page).click();
  await expect.poll(() => charges.length).toBe(1);
  expect(quotes.length).toBe(asked + 1);
  expect(charges[0].body).toMatchObject({ task: "music", text: cue, lengthMs: 30_000, instrumental: false, maxCredits: 45, projectId: "prod-ws" });
  expect(charges[0].key).toBeTruthy();
  await page.waitForTimeout(500);
  expect(charges).toHaveLength(1);
  expect(errors).toEqual([]);
});
