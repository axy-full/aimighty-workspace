import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, type LibraryRoute } from "./helpers/workspaceFixtures";
import { moreTakes } from "./helpers/genTakes";
import { openAdvanced } from "./helpers/makeAdvanced";
import { projectName } from "./helpers/projectName";
import { CINEMA_STUDIO_MODEL_ID } from "../lib/cinemaStudioTypes";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here"); });

/**
 * Takes 2–4 of one Generate go as ONE priced batch and land as ONE strip
 * (idea 3). The button shows the batch's total; Generate quotes every take
 * fresh and sends none of them if the sum moved; this workspace's takes carry
 * one batch id and their take numbers, and a take admission refuses stops the
 * batch with the takes that were made and charged named. (The connected
 * account's batches went with the Higgsfield sign-in.) Every paid route is a
 * mock that counts the charges per take; nothing is billed.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PRICE = 18;
const DRAFT = "ws-batch";
const PROMPT = "A slow dolly push across the wet harbour at blue hour";
const fixture = (): Project => ({ ...newProject("Harbour batch study"), id: DRAFT, productionProjectId: "prod-ws", shotMappings: {} });
/* Test fixtures: one Studio video engine and one still engine, as GET /api/workbench/engines lists them. */
const ENGINES = [
  { id: "dreamina-seedance-2-5-260628", kind: "video", resolutions: ["480p", "720p", "1080p"], ratios: ["16:9", "9:16", "1:1"], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], use: "Cinematic motion from a prompt or references.", rate: { credits: PRICE, resolution: "480p", ratio: "16:9", duration: 5 } },
  { id: "gemini-3.1-flash-image", kind: "image", resolutions: ["1K", "2K"], ratios: ["1:1", "16:9", "9:16"], durations: [], use: "Stills and quick frames.", rate: { credits: 1, resolution: "1K", ratio: "1:1", duration: null } },
];

async function open(page: Page, options: { library?: LibraryRoute } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const store = { current: fixture() };
  await mockProjects(page, store);
  const library = options.library ?? { uploads: [], generations: [] };
  await mockLibrary(page, library);
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  /* This workspace's engines, and one take's live price where the composer stands: fixed, so the batch arithmetic is plain
     and nothing waits on the engines route compiling. */
  await page.route(/\/api\/workbench\/engines(\?.*)?$/, (route) => {
    const priced = new URL(route.request().url()).searchParams.has("model");
    return route.fulfill({ json: { models: ENGINES, audio: null, credits: priced ? PRICE : null } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { errors, library, store };
}

async function gen(page: Page) {
  await page.goto(`/suites?make=video&project=${DRAFT}`);
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  await expect(projectName(page)).toHaveText("Harbour batch study");
}

async function takes(page: Page, count: number) {
  await moreTakes(page, count - 1);
  await expect(page.getByTestId("gen-takes-count")).toHaveText(String(count));
}

/**
 * Generate's label, measured against the button's own box: every run of text it draws sits inside its padding,
 * none is clipped or cut with an ellipsis, so the whole price is there. Then again with a wide fallback sans on
 * the button — Linux Chrome's fonts, and many Android phones', run wider than macOS's — so a label that only just
 * fits here fails here the way it would there.
 */
async function labelFits(page: Page) {
  const check = () => page.getByTestId("gen-generate").evaluate((button) => {
    const box = button.getBoundingClientRect(), style = getComputedStyle(button);
    const left = box.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) - 0.5;
    const right = box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) + 0.5;
    const out: string[] = [];
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      const parent = node.parentElement;
      if (!text || !parent || !parent.getClientRects().length) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) {
        if (!r.width) continue;
        if (r.left < left || r.right > right || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)
          out.push(`“${text}” runs past the button (${Math.round(r.left)}–${Math.round(r.right)} inside ${Math.round(left)}–${Math.round(right)})`);
      }
      if (getComputedStyle(parent).textOverflow === "ellipsis" && parent.scrollWidth > parent.clientWidth + 1) out.push(`“${text}” is cut with an ellipsis`);
    }
    if (button.scrollWidth > button.clientWidth + 1) out.push(`the label is ${button.scrollWidth - button.clientWidth}px wider than the button`);
    return out;
  });
  expect(await check(), "Generate's label fits its button").toEqual([]);
  const wide = await page.addStyleTag({ content: '[data-testid="gen-generate"], [data-testid="gen-generate"] * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }' });
  expect(await check(), "Generate's label fits its button in a wide fallback sans").toEqual([]);
  await wide.evaluate((el) => (el as HTMLStyleElement).remove());
}

/** The view fits the phone: no sideways scroll, the button and the strip inside the width, targets 44px, no dim label. */
async function floors(page: Page, info: TestInfo) {
  const phone = PHONES.includes(info.project.name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const width = page.viewportSize()!.width;
  /* Make's button is on its Make tab; Recent shows the strips. */
  if (await page.getByTestId("gen-generate").count()) await labelFits(page);
  for (const locator of [...(await page.getByTestId("gen-generate").all()), ...(await page.getByTestId("gen-batch").all())]) {
    const box = await locator.boundingBox();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
  }
  if (phone) expect(await smallTargets(page, '[data-testid="gen-view"]'), "targets under 44×44").toEqual([]);
  /* Every word the strip and the button carry, blended over what it sits on, is no dimmer than #7C7C84. */
  const dim = await page.evaluate(() => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const ground = (el: Element): number[] => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        const [r, g, b, a = 1] = parse(getComputedStyle(node).backgroundColor);
        if (a >= 0.99) return [r, g, b];
      }
      return [0, 0, 0];
    };
    const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const floor = lum([0x7c, 0x7c, 0x84]) - 0.5;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="gen-batch"] *, [data-testid="gen-generate"], [data-testid="gen-takes"] .gx-hint'))) {
      if (!el.getClientRects().length || !Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim())) continue;
      const [r, g, b, a = 1] = parse(getComputedStyle(el).color);
      const [br, bg, bb] = ground(el);
      const seen = [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
      if (lum(seen) < floor) out.push(`${el.className}: ${getComputedStyle(el).color} — “${el.textContent?.trim().slice(0, 24)}”`);
    }
    return out;
  });
  expect(dim, "labels under #7C7C84").toEqual([]);
}


/** Every Takes chip shows its whole price: nothing in it runs past its box, wide or tall. */
async function chipsFit(page: Page) {
  const cut = await page.getByTestId("gen-takes").locator("button").evaluateAll((chips) => chips
    .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
    .map((el) => `${el.textContent} (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`));
  expect(cut, "Takes chips cut").toEqual([]);
}

/* ── This workspace's credits ─────────────────────────────────────────── */

type Charge = { variation: number; batchId: string; maxCredits: number; key: string | null; shotId: string };
/** What admission does with one take: admit it (and charge it), hold it (credits ran out: no charge), or refuse it. */
type Admit = { refuse: { status: number; json: unknown } } | { hold: true } | null;
/** POST /api/generate/quote and /api/generate for the batch: every quote, every charge per take, and every take held. */
async function workspaceRoutes(page: Page, answer: { price?: (variation: number, round: number) => number; admit?: (variation: number, round: number) => Admit } = {}) {
  const quotes: Record<string, unknown>[] = [], charges: Charge[] = [], held: number[] = [];
  const status = new Map<string, string>();
  let round = 0;
  await page.route("**/api/generate/quote", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (Number(body.variation) === 1) round++;
    quotes.push(body);
    return route.fulfill({ json: { estimatedCredits: answer.price?.(Number(body.variation), round) ?? PRICE, fingerprint: String(body.variation).repeat(64).slice(0, 64), unit: "cr" } });
  });
  await page.route(/\/api\/generate$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const body = request.postDataJSON() as Record<string, unknown>;
    const variation = Number(body.variation);
    const verdict = answer.admit?.(variation, round);
    if (verdict && "refuse" in verdict) return route.fulfill({ status: verdict.refuse.status, json: verdict.refuse.json, headers: { "Idempotency-Status": "complete" } });
    const id = `gen_batch_${round}_${variation}`;
    if (verdict && "hold" in verdict) {
      held.push(variation);
      status.set(id, "held");
      return route.fulfill({ status: 202, json: { id, status: "held", held: true, needs: PRICE, notices: ["Held: this needs 18 credits and 0 are left. Top up to release it — nothing is lost."] }, headers: { "Idempotency-Status": "complete" } });
    }
    charges.push({ variation, batchId: String(body.batchId), maxCredits: Number(body.maxCredits), key: request.headers()["idempotency-key"] ?? null, shotId: String(body.shotId) });
    status.set(id, "running");
    return route.fulfill({ json: { id, status: "running" }, headers: { "Idempotency-Status": "complete" } });
  });
  await page.route(/\/api\/jobs\/gen_batch_\d+_\d+(\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const now = status.get(id) ?? "running";
    return route.fulfill({ json: { generation: generation({ id, kind: "video", status: now, creditsBilled: now === "succeeded" ? PRICE : null, prompt: PROMPT, params: now === "held" ? { held: { why: "credits", needs: PRICE } } : {} }) } });
  });
  return { quotes, charges, held, status };
}

test("this workspace's credits: 4 takes are one batch at the total on the button, one batch id and take numbers 1–4, each sent once", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, library } = await open(page);
  const routes = await workspaceRoutes(page);
  await page.clock.install();
  await gen(page);
  await page.getByTestId("gen-prompt").fill(PROMPT);
  /* The first live price can wait on a cold compile of the engines route. */
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${PRICE} cr`, { timeout: 60_000 });
  await takes(page, 4);
  /* The whole batch's price is on the button before anything is spent. */
  await expect(page.getByTestId("gen-generate")).toHaveText("Make 4 takes · 72 cr");
  expect(routes.quotes).toHaveLength(0);
  await floors(page, info);
  await page.getByTestId("gen-generate").click();

  /* Every take priced exactly as it is sent, then each sent once: one batch id, its own take number, its own ceiling, one shot. */
  await expect.poll(() => routes.charges.length).toBe(4);
  expect(routes.quotes.map((q) => q.variation)).toEqual([1, 2, 3, 4]);
  expect(routes.charges.map((c) => c.variation)).toEqual([1, 2, 3, 4]);
  expect(new Set(routes.charges.map((c) => c.batchId)).size).toBe(1);
  expect(routes.charges[0].batchId).toMatch(/^b_[a-z0-9]{4,20}$/);
  expect(routes.charges.every((c) => c.maxCredits === PRICE)).toBe(true);
  expect(new Set(routes.charges.map((c) => c.key)).size).toBe(4);
  expect(new Set(routes.charges.map((c) => c.shotId)).size).toBe(1);
  /* The accepted batch closes Make and says what it came to: the batch's total and its take count. */
  await expect(page.getByTestId("toast")).toContainText("72 cr · 4 takes · rendering");
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  /* (The batch strip and its per-take statuses on Recent, and the landing announcement that needs the composer mounted, are gone with
     the old Gen results: docs/old-shells.md.) */
  /* Still four charges: nothing was sent twice. */
  expect(routes.charges).toHaveLength(4);
  expect(errors).toEqual([]);
});

test("this workspace's credits: a moved price sends none; admission refusing take 3 names what was made and charged, and bills nothing refused", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  /* Take 2 prices a credit dearer than the button: the first press sends nothing; the second approves the new total;
     admission then refuses take 3 (the workspace's monthly cap on the platform's engines). */
  const routes = await workspaceRoutes(page, {
    price: (variation) => (variation === 2 ? PRICE + 1 : PRICE),
    admit: (variation, round) => (round === 2 && variation === 3 ? { refuse: { status: 429, json: { error: "This workspace has reached its monthly cap on the platform's engines" } } } : null),
  });
  await gen(page);
  await page.getByTestId("gen-prompt").fill(PROMPT);
  await takes(page, 4);
  await expect(page.getByTestId("gen-generate")).toHaveText("Make 4 takes · 72 cr", { timeout: 60_000 });
  await page.getByTestId("gen-generate").click();
  /* Nothing sent; the new total is on the button, said once. */
  await expect(page.getByRole("status").filter({ hasText: "The price is now 73 cr for 4 takes. Nothing was sent; press Generate again to approve it." })).toBeVisible();
  await expect(page.getByTestId("gen-generate")).toHaveText("Make 4 takes · 73 cr");
  expect(routes.charges).toEqual([]);
  expect(routes.quotes).toHaveLength(4);
  await expect(page.getByTestId("gen-batch")).toHaveCount(0);
  await floors(page, info);

  /* The second, deliberate press approves 73: takes 1–2 made and charged at their own ceilings; take 3 refused; take 4 never asked for. */
  await page.getByTestId("gen-generate").click();
  await expect(page.getByRole("status").filter({ hasText: "Takes 1–2 were sent at 37 cr. Takes 3–4 were not made (This workspace has reached its monthly cap on the platform's engines). Nothing was charged for them." })).toBeVisible();
  expect(routes.charges.map((c) => [c.variation, c.maxCredits])).toEqual([[1, PRICE], [2, PRICE + 1]]);
  expect(routes.quotes).toHaveLength(8);
  /* Make stays open with that line (nothing started for takes 3-4): the line is the whole account, and it is on Make. */
  await expect(page.getByTestId("make-panel")).toBeVisible();
  expect(errors).toEqual([]);
});

test("this workspace's credits: when the credits run out mid-batch, takes 3–4 are held, said so, and not charged", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  const routes = await workspaceRoutes(page, { admit: (variation) => (variation >= 3 ? { hold: true } : null) });
  await gen(page);
  await page.getByTestId("gen-prompt").fill(PROMPT);
  await takes(page, 4);
  await expect(page.getByTestId("gen-generate")).toHaveText("Make 4 takes · 72 cr", { timeout: 60_000 });
  await page.getByTestId("gen-generate").click();
  await expect(page.getByRole("status").filter({ hasText: "Takes 1–2 were sent at 36 cr. Takes 3–4 are held, not charged until they run: top up to release them at the same price." })).toBeVisible();
  /* Two charges; two takes admitted as held, which cost nothing until they run. */
  expect(routes.charges.map((c) => c.variation)).toEqual([1, 2]);
  expect(routes.held).toEqual([3, 4]);
  await expect(page.getByTestId("make-panel")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the takes stepper stays put as the live price lands: a press on More across that moment counts, and one just after it is More again, never Generate", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  const routes = await workspaceRoutes(page);
  /* The take's live price waits until a press on More has gone down; open()'s engines route then answers it. */
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let asked = 0;
  await page.route(/\/api\/workbench\/engines\?.*model=/, async (route) => { asked++; await held; return route.fallback(); });
  await gen(page);
  await page.getByTestId("gen-prompt").fill(PROMPT);
  await expect.poll(() => asked, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId("gen-blocked")).toHaveText("Getting the live price…");
  /* Where the stepper and Generate sit in the composer, whatever the scroll (at a scroller's end a shorter page scrolls back and hides a move). */
  const place = () => page.getByTestId("gen-view").evaluate((view) => {
    const top = (selector: string) => Math.round((view.querySelector(selector)!.getBoundingClientRect().top - view.querySelector(".gx-mk-compose")!.getBoundingClientRect().top) * 10) / 10;
    return { takes: top('[data-testid="gen-takes"]'), generate: top('[data-testid="gen-generate"]') };
  });
  const pricing = await place();
  const more = page.getByTestId("gen-takes-2");
  /* Scrolled to where a press hits it: on a phone Generate's sticky band floats over the rows above its own place. */
  await more.click({ trial: true });
  const box = (await more.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  release();
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${PRICE} cr`, { timeout: 60_000 });
  await expect(page.getByTestId("gen-blocked")).toHaveCount(0);
  const priced = await place();
  /* Under 768px Generate's band sticks to the screen (it moves with the scroll), so its place is compared only where it is in the flow. */
  /* Make's row sticks to the panel's foot at every width (it moves with the scroll), so only the stepper's place is compared. */
  expect(priced.takes, "nothing moved as the price landed").toEqual(pricing.takes);
  await page.mouse.up();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("2");
  /* Aimed at More while the price was on its way, made once it is on the button: More again, never Generate. */
  await page.getByTestId("gen-takes-3").click();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("3");
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make 3 takes · ${3 * PRICE} cr`);
  await expect(page.getByTestId("gen-takes-1")).toContainText(`${PRICE} cr`);
  await chipsFit(page);
  expect(routes.quotes).toEqual([]);
  expect(routes.charges).toEqual([]);
  expect(errors).toEqual([]);
});

test("Cinema Studio's takes chips show 'about N cr, at most 3N cr' whole, inside their chips", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop width");
  const { errors } = await open(page);
  const cinema = { ...ENGINES[0], id: CINEMA_STUDIO_MODEL_ID, rate: { credits: 35, resolution: "720p", ratio: "16:9", duration: 5, approximate: true } };
  await page.route(/\/api\/workbench\/engines(\?.*)?$/, (route) => {
    const priced = new URL(route.request().url()).searchParams.has("model");
    return route.fulfill({ json: { models: [cinema, ENGINES[1]], audio: null, credits: priced ? 35 : null, ...(priced ? { approximate: true } : {}) } });
  });
  await gen(page);
  await page.getByTestId("gen-prompt").fill(PROMPT);
  const one = page.getByTestId("gen-takes-1");
  await expect(one).toContainText("at most 105 cr", { timeout: 60_000 });
  await expect(page.getByTestId("gen-takes-4")).toContainText("at most 420 cr");
  await chipsFit(page);
  expect(errors).toEqual([]);
});
