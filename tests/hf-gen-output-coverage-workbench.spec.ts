import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { dimLabels, smallTargets } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

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
  await page.goto(`/suites?view=gen&project=${DRAFT}`);
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour sound study");
  return { quotes, charges, mismatched, errors, store };
}

const sheetOf = (page: Page) => page.getByRole("dialog", { name: "Choose a model" });

/** Picks a model by its name in Gen's model sheet. */
async function pickModel(page: Page, name: RegExp) {
  const button = page.getByTestId("gen-model");
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  await sheet.getByRole("option").filter({ has: page.locator(".gx-model-name", { hasText: name }) }).first().click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("gen-model").locator(".gx-model-name")).toHaveText(name);
}

const optionLabels = (page: Page) => page.getByTestId("gen-voice").locator("option").allTextContents();
const generateButton = (page: Page) => page.getByTestId("gen-generate");

/**
 * Generate's label, measured against the button's own box, then again with a wide fallback sans (Linux Chrome's
 * and many Android phones' fonts run wider than macOS's): every run of text sits inside, the price whole.
 */
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
  expect(await check(), "Generate's label fits its button").toEqual([]);
  const wide = await page.addStyleTag({ content: '[data-testid="gen-view"], [data-testid="gen-view"] * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }' });
  expect(await check(), "Generate's label fits its button in a wide fallback sans").toEqual([]);
  /* The sound rows keep to the card in the wide sans too. */
  expect(await soundRowsFit(page), "the sound rows fit the card in a wide fallback sans").toEqual([]);
  await wide.evaluate((el) => (el as HTMLStyleElement).remove());
}

/** Every control of the sound rows sits inside the composer card: nothing is cut or pushed sideways. */
function soundRowsFit(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-testid="gen-view"] .gx-gen-card[aria-label="Composer"]')!.getBoundingClientRect();
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="gen-voice"], [data-testid="gen-seconds"], [data-testid="gen-seconds"] *, [data-testid="gen-instrumental"], [data-testid="gen-instrumental"] *'))) {
      if (!el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.left < card.left - 0.5 || r.right > card.right + 0.5) out.push(`${el.dataset.testid || el.className || el.tagName} ${Math.round(r.left)}–${Math.round(r.right)} outside ${Math.round(card.left)}–${Math.round(card.right)}`);
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible") out.push(`${el.dataset.testid || el.className} is cut`);
    }
    return out;
  });
}

/** The phone floors: nothing sideways, 44px targets in Gen, no label under #7C7C84, no serif, and Gen's end above the tab bar. */
async function floors(page: Page, info: TestInfo) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);
  expect(await soundRowsFit(page), "the sound rows fit the card").toEqual([]);
  await labelFits(page);
  const serif = await page.getByTestId("gen-view").evaluate((view) => Array.from(view.querySelectorAll<HTMLElement>("*"))
    .filter((el) => el.getClientRects().length && /^(serif|times|georgia|garamond|palatino|cambria)/i.test(getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim()))
    .map((el) => el.className || el.tagName));
  expect(serif, "no serif in Gen").toEqual([]);
  if (!PHONES.includes(info.project.name)) return;
  expect(await smallTargets(page, '[data-testid="gen-view"]'), "Gen's targets under 44×44").toEqual([]);
  expect(await dimLabels(page, '[data-testid="gen-view"]'), "Gen's labels under #7C7C84").toEqual([]);
  await clearOfTabBar(page);
}

/** On a phone, Gen scrolled to its end: its last element ends above the tab bar (whatever the bar's height). */
async function clearOfTabBar(page: Page) {
  const bar = page.locator(".gx-tabbar");
  if (!(await bar.isVisible())) return;
  const gap = await page.getByTestId("gen-view").evaluate(async (view) => {
    let scroller: HTMLElement | null = view.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    (scroller ?? document.scrollingElement as HTMLElement).scrollTop = 1e9;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const last = Array.from(view.querySelectorAll<HTMLElement>("*")).filter((el) => el.getClientRects().length)
      .reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a), view);
    return document.querySelector(".gx-tabbar")!.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
  });
  expect(gap, "Gen's last element ends above the tab bar").toBeGreaterThanOrEqual(0);
}

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = info.project.name.replace("workbench-", "");
  /* The model row at the top of the scroller, so the rows under it show above the sticky Generate. */
  await page.getByTestId("gen-model").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: path.join(SHOTS, `${name}-${size}.png`) });
}

test("a line: the voice list is the chosen model's own and swaps with it, each change is priced again, and one Generate sends the voice on the button at its price", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { quotes, charges, mismatched, errors } = await open(page);
  /* Gen makes video, images and sound: no 3D tab, whoever is signed in. */
  await expect(page.getByRole("tablist", { name: "Output" }).getByRole("tab")).toHaveText(["Video", "Images", "Audio", "Edit", "Analysis"]);
  await page.getByRole("tab", { name: "Audio" }).click();
  await pickModel(page, /^Grok Voice$/);
  const line = "Not tonight. The ice will hold until morning.";
  await page.getByTestId("gen-prompt").fill(line);

  /* Grok Voice reads in xAI's own voices, the first chosen until the person picks: the line is priced in it. */
  expect(await optionLabels(page)).toEqual(["Eve", "Ara", "Rex"]);
  await expect(page.getByTestId("gen-voice")).toHaveValue("eve");
  await expect(generateButton(page)).toHaveText("Generate · 2 cr");
  expect(quotes.at(-1)).toMatchObject({ task: "speech", modelId: "grok-tts", voiceId: "eve", text: line });
  await expect(page.getByTestId("gen-view").locator(".gx-gen-foot").first()).toHaveText("Eve · Saved to your takes");

  /* Another voice is another price: the old figure never stands beside the new voice. */
  let asked = quotes.length;
  await page.getByTestId("gen-voice").selectOption("ara");
  await expect(generateButton(page)).toHaveText("Generate · 3 cr");
  expect(quotes.length).toBeGreaterThan(asked);
  expect(quotes.at(-1)).toMatchObject({ modelId: "grok-tts", voiceId: "ara" });

  /* An ElevenLabs model swaps the list, and a Grok voice is never carried over: the line falls to its first voice. */
  asked = quotes.length;
  await pickModel(page, /^Eleven Multilingual v2$/);
  expect(await optionLabels(page)).toEqual(["Rachel", "Sarah"]);
  await expect(page.getByTestId("gen-voice")).toHaveValue(ELEVEN_VOICES[0].id);
  await expect(generateButton(page)).toHaveText("Generate · 4 cr");
  expect(quotes.slice(asked).every((q) => q.modelId === "eleven_multilingual_v2" && q.voiceId === ELEVEN_VOICES[0].id)).toBe(true);
  await page.getByTestId("gen-voice").selectOption(ELEVEN_VOICES[1].id);
  await expect.poll(() => quotes.at(-1)?.voiceId).toBe(ELEVEN_VOICES[1].id);
  await expect(generateButton(page)).toHaveText("Generate · 4 cr");
  /* No line was ever priced in the other vendor's voice. */
  expect(mismatched).toEqual([]);
  await floors(page, info);
  await shot(page, info, "voice");

  /* Generate: settled first, priced again exactly as it is sent, then sent once with the button's figure as its ceiling. */
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

test("effects and music: the length stepper and Instrumental each price the take again, and Generate sends the length and vocals on the button", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { quotes, charges, errors } = await open(page);
  await page.getByRole("tab", { name: "Audio" }).click();
  /* This workspace's sound opens on effects, at ten seconds. */
  await expect(page.getByTestId("gen-model").locator(".gx-model-name")).toHaveText("Eleven Sound Effects");
  const cue = "A slow cello under rain on a tin roof";
  await page.getByTestId("gen-prompt").fill(cue);
  const stepper = page.getByRole("group", { name: "Length" });
  const value = page.getByTestId("gen-seconds-value");
  const instrumental = page.getByTestId("gen-instrumental");
  const shorter = stepper.getByRole("button", { name: "Shorter" }), longer = stepper.getByRole("button", { name: "Longer" });
  await expect(value).toHaveText("10 s");
  await expect(generateButton(page)).toHaveText("Generate · 3 cr");
  expect(quotes.at(-1)).toMatchObject({ task: "sound", durationSeconds: 10, text: cue });
  /* An effect has no vocals to switch, and runs one second at a time to thirty: every length is priced as it is sent. */
  await expect(instrumental).toHaveCount(0);
  for (let i = 0; i < 20; i++) await longer.click();
  await expect(value).toHaveText("30 s");
  await expect(longer).toBeDisabled();
  await expect.poll(() => quotes.at(-1)?.durationSeconds).toBe(30);
  await expect(generateButton(page)).toHaveText("Generate · 3 cr");
  await expect(page.getByTestId("gen-view").locator(".gx-gen-foot").first()).toHaveText("30 s · Saved to your takes");

  /* Music keeps the length while it is in range, and steps five seconds to its ten-second floor. */
  await pickModel(page, /^Eleven Music$/);
  await expect(value).toHaveText("30 s");
  await expect(instrumental).toHaveAttribute("aria-checked", "true");
  await expect(generateButton(page)).toHaveText("Generate · 40 cr");
  expect(quotes.at(-1)).toMatchObject({ task: "music", lengthMs: 30_000, instrumental: true, text: cue });
  for (let i = 0; i < 4; i++) await shorter.click();
  await expect(value).toHaveText("10 s");
  await expect(shorter).toBeDisabled();
  await expect(generateButton(page)).toHaveText("Generate · 20 cr");
  expect(quotes.at(-1)).toMatchObject({ lengthMs: 10_000, instrumental: true });
  /* Each press is a new length, and a new price before the button shows one. */
  await longer.click();
  await longer.click();
  await expect(value).toHaveText("20 s");
  await expect(generateButton(page)).toHaveText("Generate · 30 cr");
  expect(quotes.at(-1)).toMatchObject({ lengthMs: 20_000, instrumental: true });

  /* Vocals are another take: priced again. */
  let asked = quotes.length;
  await instrumental.click();
  await expect(instrumental).toHaveAttribute("aria-checked", "false");
  await expect(generateButton(page)).toHaveText("Generate · 35 cr");
  expect(quotes.length).toBeGreaterThan(asked);
  expect(quotes.at(-1)).toMatchObject({ lengthMs: 20_000, instrumental: false });
  await expect(page.getByTestId("gen-view").locator(".gx-gen-foot").first()).toHaveText("20 s · With vocals · Saved to your takes");
  await floors(page, info);
  await shot(page, info, "music");

  /* Generate: priced again exactly as it is sent, then sent once, the button's figure its ceiling. */
  expect(charges).toEqual([]);
  asked = quotes.length;
  await generateButton(page).click();
  await expect.poll(() => charges.length).toBe(1);
  expect(quotes.length).toBe(asked + 1);
  expect(charges[0].body).toMatchObject({ task: "music", text: cue, lengthMs: 20_000, instrumental: false, maxCredits: 35, projectId: "prod-ws" });
  expect(charges[0].key).toBeTruthy();
  await page.waitForTimeout(500);
  expect(charges).toHaveLength(1);
  expect(errors).toEqual([]);
});
