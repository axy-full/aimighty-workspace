import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, type LibraryRoute } from "./helpers/workspaceFixtures";

/**
 * Takes 2–4 of one Generate go as ONE priced batch and land as ONE strip
 * (idea 3). The button shows the batch's total; Generate quotes every take
 * fresh and sends none of them if the sum moved; this workspace's takes carry
 * one batch id and their take numbers, and a take admission refuses stops the
 * batch with the takes that were made and charged named; the connected
 * account gets one paid call for the whole batch, and a lost reply is checked
 * (and fenced), never sent again. Every paid route is a mock that counts the
 * charges per take; nothing is billed.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PRICE = 18;
const WALLET = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";
const DRAFT = "ws-batch";
const PROMPT = "A slow dolly push across the wet harbour at blue hour";
const fixture = (): Project => ({ ...newProject("Harbour batch study"), id: DRAFT, productionProjectId: "prod-ws", shotMappings: {} });
const uuid = (n: number) => `9d2b3c4e-5f60-4a7b-8c9d-${String(n).padStart(12, "0")}`;
const original = (n: number) => `gen_hfc_${String(n % 10).repeat(40)}`;
const CATALOGUE = [
  { id: "seedance_2_5", name: "Seedance 2.5", outputType: "video", aspectRatios: ["16:9", "9:16"], durationRange: { min: 4, max: 12 }, medias: [{ name: "medias", roles: ["start_image", "image_references"] }], parameters: [{ name: "resolution", options: ["480p", "720p", "1080p"] }] },
];

async function open(page: Page, options: { owner?: boolean; library?: LibraryRoute } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const store = { current: fixture() };
  await mockProjects(page, store);
  const library = options.library ?? { uploads: [], generations: [] };
  await mockLibrary(page, library);
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  /* One take's live price, where the composer stands: a fixed figure so the batch arithmetic is plain. */
  await page.route(/\/api\/workbench\/engines(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const real = await route.fetch();
    const json = await real.json();
    return route.fulfill({ json: url.searchParams.has("model") ? { ...json, credits: PRICE } : json });
  });
  if (options.owner) {
    const me = await page.request.get("/api/me").then((r) => r.json());
    await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
    await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { errors, library, store };
}

async function gen(page: Page) {
  await page.goto(`/suites?view=gen&project=${DRAFT}`);
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour batch study");
}

async function takes(page: Page, count: number) {
  const stepper = page.getByRole("group", { name: "Takes per generate" });
  for (let n = 1; n < count; n++) await stepper.getByRole("button", { name: "More" }).click();
  await expect(page.getByTestId("gen-takes-count")).toHaveText(String(count));
}

/** The view fits the phone: no sideways scroll, the button and the strip inside the width, targets 44px, no dim label. */
async function floors(page: Page, info: TestInfo) {
  const phone = PHONES.includes(info.project.name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const width = page.viewportSize()!.width;
  const clipped = await page.getByTestId("gen-generate").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(clipped, "Generate's label fits its button").toBeLessThanOrEqual(1);
  for (const locator of [page.getByTestId("gen-generate"), ...(await page.getByTestId("gen-batch").all())]) {
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

/** On a phone the last thing in Gen, scrolled to the end, ends above the tab bar. */
async function clearOfTabBar(page: Page) {
  const bar = page.getByTestId("tabbar");
  if (!(await bar.isVisible())) return;
  const gap = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="content"]')!;
    scroller.scrollTop = scroller.scrollHeight;
    const view = document.querySelector<HTMLElement>('[data-testid="gen-view"]')!;
    const results = view.querySelector<HTMLElement>(".gx-gen-results")!;
    const last = Array.from(results.querySelectorAll<HTMLElement>("*")).filter((el) => el.getClientRects().length).reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a), results);
    return document.querySelector('[data-testid="tabbar"]')!.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
  });
  expect(gap, "the last element ends above the tab bar").toBeGreaterThanOrEqual(0);
}

/** Opt-in (BATCH_SHOTS=<dir>): the page with the strip's end above the dock, the strip alone, and the takes stepper with Generate. */
async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.BATCH_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const size = info.project.name.replace("workbench-", "");
  const strip = page.getByTestId("gen-batch").first();
  if (await strip.count()) {
    await strip.evaluate((el) => { (el as HTMLElement).style.scrollMarginBottom = "120px"; el.scrollIntoView({ block: "end" }); });
    await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
    await strip.screenshot({ path: path.join(dir, `${name}-${size}-strip.png`) });
  } else await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
  const cta = page.getByTestId("gen-view").locator(".gx-gen-card[aria-label='Composer']");
  await page.getByTestId("gen-takes").scrollIntoViewIfNeeded();
  const box = await cta.boundingBox();
  const takes = await page.getByTestId("gen-takes").boundingBox();
  if (box && takes) await page.screenshot({ path: path.join(dir, `${name}-${size}-cta.png`), clip: { x: box.x, y: Math.max(0, takes.y - 60), width: box.width, height: Math.min(page.viewportSize()!.height - Math.max(0, takes.y - 60), 220) } });
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

test("this workspace's credits: 4 takes are one batch at the total on the button, one batch id and take numbers 1–4, and land as one strip", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, library } = await open(page);
  const routes = await workspaceRoutes(page);
  await page.clock.install();
  await gen(page);
  await page.getByTestId("gen-prompt").fill(PROMPT);
  await expect(page.getByTestId("gen-generate")).toHaveText(`Generate · ${PRICE} cr`);
  await takes(page, 4);
  /* The whole batch's price is on the button before anything is spent. */
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate 4 takes · 72 cr");
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
  await expect(page.getByRole("status").filter({ hasText: "4 takes sent at 72 cr. They file into Takes as one strip as they land." })).toBeVisible();

  /* Rendering: one strip, take 1–4, each take followed on its own. */
  const strip = page.getByTestId("gen-batch");
  await expect(strip).toHaveCount(1);
  await expect(strip.locator(".gx-batch-label")).toHaveText("take 1–4");
  await expect(strip.getByTestId("gen-batch-take").locator(".gx-asset-name")).toHaveText(["take 1", "take 2", "take 3", "take 4"]);
  await expect(strip.getByTestId("gen-batch-take-status")).toHaveText(["Rendering", "Rendering", "Rendering", "Rendering"]);
  await expect(page.getByTestId("gen-running")).toHaveCount(0);
  await floors(page, info);
  await shot(page, info, "workspace-rendering");

  /* Takes land one by one; the strip says so; when the last lands the Library has all four as one strip. */
  const batchId = routes.charges[0].batchId;
  routes.status.set("gen_batch_1_2", "succeeded");
  await page.clock.fastForward("00:07");
  await expect(strip.getByTestId("gen-batch-take-status")).toHaveText(["Rendering", "Complete", "Rendering", "Rendering"]);
  await expect(strip.locator(".gx-batch-meta")).toContainText("1 of 4 rendered");
  library.generations = [4, 3, 2, 1].map((v) => generation({ id: `gen_batch_1_${v}`, kind: "video", title: PROMPT, prompt: PROMPT, params: { batchId, variation: v }, creditsBilled: PRICE }));
  for (const v of [1, 3, 4]) routes.status.set(`gen_batch_1_${v}`, "succeeded");
  await page.clock.fastForward("00:07");
  await expect(page.getByTestId("toast")).toContainText("4 takes rendered. They are one strip in Takes.");
  await page.clock.fastForward("00:03");
  const landed = page.getByTestId("gen-batch");
  await expect(landed).toHaveCount(1);
  await expect(landed).toHaveAttribute("data-state", "done");
  await expect(landed.getByTestId("gen-batch-take").locator(".gx-asset-name")).toHaveText(["take 1", "take 2", "take 3", "take 4"]);
  await expect(landed.getByTestId("gen-batch-take").locator(".gx-asset-thumb")).toHaveCount(4);
  await floors(page, info);
  await clearOfTabBar(page);
  await shot(page, info, "workspace-landed");
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
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate 4 takes · 72 cr");
  await page.getByTestId("gen-generate").click();
  /* Nothing sent; the new total is on the button, said once. */
  await expect(page.getByRole("status").filter({ hasText: "The price is now 73 cr for 4 takes. Nothing was sent; press Generate again to approve it." })).toBeVisible();
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate 4 takes · 73 cr");
  expect(routes.charges).toEqual([]);
  expect(routes.quotes).toHaveLength(4);
  await expect(page.getByTestId("gen-batch")).toHaveCount(0);
  await floors(page, info);

  /* The second, deliberate press approves 73: takes 1–2 made and charged at their own ceilings; take 3 refused; take 4 never asked for. */
  await page.getByTestId("gen-generate").click();
  await expect(page.getByRole("status").filter({ hasText: "Takes 1–2 were sent at 37 cr. Takes 3–4 were not made (This workspace has reached its monthly cap on the platform's engines). Nothing was charged for them." })).toBeVisible();
  expect(routes.charges.map((c) => [c.variation, c.maxCredits])).toEqual([[1, PRICE], [2, PRICE + 1]]);
  expect(routes.quotes).toHaveLength(8);
  const strip = page.getByTestId("gen-batch");
  await expect(strip.getByTestId("gen-batch-take-status")).toHaveText(["Rendering", "Rendering", "Not made · not charged", "Not sent · not charged"]);
  await floors(page, info);
  await clearOfTabBar(page);
  await shot(page, info, "workspace-refused");
  expect(errors).toEqual([]);
});

test("this workspace's credits: when the credits run out mid-batch, takes 3–4 are held, said so, and not charged", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  const routes = await workspaceRoutes(page, { admit: (variation) => (variation >= 3 ? { hold: true } : null) });
  await gen(page);
  await page.getByTestId("gen-prompt").fill(PROMPT);
  await takes(page, 4);
  await page.getByTestId("gen-generate").click();
  await expect(page.getByRole("status").filter({ hasText: "Takes 1–2 were sent at 36 cr. Takes 3–4 are held, not charged until they run: top up to release them at the same price." })).toBeVisible();
  /* Two charges; two takes admitted as held, which cost nothing until they run. */
  expect(routes.charges.map((c) => c.variation)).toEqual([1, 2]);
  expect(routes.held).toEqual([3, 4]);
  const strip = page.getByTestId("gen-batch");
  await expect(strip.getByTestId("gen-batch-take-status")).toHaveText(["Rendering", "Rendering", "Held · needs credits", "Held · needs credits"]);
  await expect(strip.locator(".gx-batch-meta")).toContainText("72 cr");
  await floors(page, info);
  await clearOfTabBar(page);
  await shot(page, info, "workspace-held");
  expect(errors).toEqual([]);
});

/* ── The connected account ────────────────────────────────────────────── */

type Job = Record<string, unknown> & { id: string; status: string };
function connectedJob(n: number, variation: number, batchId: string, credits: number, status = "quoted"): Job {
  return {
    id: uuid(n), draftId: DRAFT, status, composer: "gen", batch: { id: batchId, variation },
    input: { type: "video", model: "seedance_2_5", prompt: PROMPT, parameters: { aspect_ratio: "16:9", duration: 5, resolution: "480p" }, medias: [] },
    model: { id: "seedance_2_5", name: "Seedance 2.5", outputType: "video" }, tool: null, sources: [],
    workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: credits, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000,
    providerJobId: status === "quoted" ? null : uuid(900 + n), result: null, originalAvailable: false, createdAt: Date.now(),
  };
}
const completed = (job: Job): Job => {
  const id = original(Number(job.id.slice(-2)));
  return {
    ...job, status: "completed", originalAvailable: true, originalAvailability: "available",
    result: { original: { generationId: id, providerJobId: job.providerJobId, creditUnit: "higgsfield_credits", credits: job.quoteCredits, sha256: "d".repeat(64), bytes: 2048, asset: { generationId: id, url: `/api/media/${id}`, kind: "video", mime: "video/mp4" } } },
  };
};

/** The connected route: the catalogue, one take's live quote, the batch quote/submit/check, and status reads — every paid call counted. */
async function connectedRoutes(page: Page, answer: { single?: number; price?: (variation: number, round: number) => number; submit?: (round: number) => "ok" | "lost"; check?: () => "landed" | "absent" } = {}) {
  const posts: Record<string, unknown>[] = [], paid: Record<string, unknown>[] = [];
  const jobs = new Map<string, Job>();
  let round = 0, n = 0;
  await page.route(/\/api\/higgsfield\/consumer\/generation(\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { connection: { connected: true }, capabilities: {}, jobs: [] } });
    const body = request.postDataJSON() as Record<string, unknown>;
    posts.push(body);
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: CATALOGUE, unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    if (body.action === "quote") return route.fulfill({ json: { job: connectedJob(99, 1, "b_single01", answer.single ?? PRICE) } });
    if (body.action === "quote-batch") {
      round++;
      const keys = body.idempotencyKeys as string[];
      const quoted = keys.map((_, i) => connectedJob(++n, i + 1, String(body.batchId), answer.price?.(i + 1, round) ?? answer.single ?? PRICE));
      for (const job of quoted) jobs.set(job.id, job);
      return route.fulfill({ json: { jobs: quoted } });
    }
    if (body.action === "submit-batch") {
      paid.push(body);
      const ids = body.ids as string[];
      for (const id of ids) jobs.set(id, { ...jobs.get(id)!, status: "accepted", providerJobId: uuid(900 + Number(id.slice(-2))) });
      if (answer.submit?.(round) === "lost") return route.abort("connectionreset");
      return route.fulfill({ json: { jobs: ids.map((id) => jobs.get(id)) } });
    }
    if (body.action === "check-batch") {
      const ids = body.ids as string[];
      const state = answer.check?.() ?? "landed";
      return route.fulfill({ json: { state, jobs: ids.map((id) => jobs.get(id)) } });
    }
    if (body.action === "status") return route.fulfill({ json: { job: jobs.get(String(body.id)), pollAfterSeconds: 15 } });
    return route.fulfill({ status: 400, json: { error: "unexpected in this spec" } });
  });
  return { posts, paid, jobs };
}

async function connectedGen(page: Page, single = PRICE) {
  await gen(page);
  await page.getByTestId("gen-model").click();
  const sheet = page.getByRole("dialog", { name: "Choose a model" });
  await sheet.getByRole("tab", { name: "Higgsfield catalogue" }).click();
  await sheet.getByRole("option", { name: /Seedance 2\.5/ }).first().click();
  await expect(sheet).toHaveCount(0);
  await page.getByTestId("gen-prompt").fill(PROMPT);
  await expect(page.getByTestId("gen-generate")).toHaveText(`Generate · ${single.toLocaleString("en-US")} connected cr`);
}

test("the connected account: one quote per take, ONE paid call for their exact sum, every take followed and filed into one strip", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, library } = await open(page, { owner: true });
  const routes = await connectedRoutes(page, { price: (variation, round) => (round === 1 && variation === 4 ? PRICE + 2 : PRICE) });
  await page.clock.install();
  await connectedGen(page);
  await takes(page, 4);
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate 4 takes · 72 connected cr");
  await floors(page, info);

  /* A moved price: four fresh quotes, NOTHING sent, and the new sum on the button. */
  await page.getByTestId("gen-generate").click();
  await expect(page.getByRole("status").filter({ hasText: "The price is now 74 connected cr for 4 takes. Nothing was sent; press Generate again to approve it." })).toBeVisible();
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate 4 takes · 74 connected cr");
  expect(routes.paid).toEqual([]);

  /* The next press approves 74, but the account now says 72 again: still nothing sent. Then 72 is approved and sent. */
  await page.getByTestId("gen-generate").click();
  await expect(page.getByRole("status").filter({ hasText: "The price is now 72 connected cr for 4 takes." })).toBeVisible();
  expect(routes.paid).toEqual([]);
  await page.getByTestId("gen-generate").click();
  await expect.poll(() => routes.paid.length).toBe(1);
  const batch = routes.posts.filter((p) => p.action === "quote-batch").at(-1)!;
  expect((batch.idempotencyKeys as string[]).length).toBe(4);
  expect(routes.paid[0]).toMatchObject({ action: "submit-batch", draftId: DRAFT, workspaceId: WALLET, credits: 72 });
  expect((routes.paid[0].ids as string[]).length).toBe(4);
  /* Never a single submit, never a second batch call. */
  expect(routes.posts.filter((p) => p.action === "submit")).toEqual([]);
  await expect(page.getByRole("status").filter({ hasText: "4 takes sent at 72 connected cr. They file into Takes as one strip as they land." })).toBeVisible();

  const strip = page.getByTestId("gen-batch");
  await expect(strip.getByTestId("gen-batch-take").locator(".gx-asset-name")).toHaveText(["take 1", "take 2", "take 3", "take 4"]);
  await expect(strip.getByTestId("gen-batch-take-status")).toHaveText(["Rendering", "Rendering", "Rendering", "Rendering"]);
  await floors(page, info);
  await shot(page, info, "connected-rendering");

  /* Every take is read until it lands (not only the last one sent); each finished original is filed. */
  const ids = routes.paid[0].ids as string[];
  for (const id of ids) routes.jobs.set(id, completed(routes.jobs.get(id)!));
  library.generations = ids.map((id, i) => generation({ id: original(Number(id.slice(-2))), kind: "video", title: PROMPT, prompt: PROMPT, provider: "higgsfield", params: { task: "connected-generation", batchId: String(batch.batchId), variation: i + 1 } }));
  await page.clock.fastForward("00:13");
  await expect.poll(() => new Set(routes.posts.filter((p) => p.action === "status").map((p) => p.id)).size).toBe(4);
  await expect(page.getByTestId("toast")).toContainText("4 takes rendered. They are one strip in Takes.");
  await page.clock.fastForward("00:03");
  await expect(page.getByTestId("gen-batch")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("gen-batch").getByTestId("gen-batch-take").locator(".gx-asset-thumb")).toHaveCount(4);
  await floors(page, info);
  await clearOfTabBar(page);
  await shot(page, info, "connected-landed");
  expect(routes.paid).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("the connected account: a lost reply is checked before anything else, followed where it landed, and never sent again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, { owner: true });
  let answer: "landed" | "absent" = "absent";
  /* A dear model: the longest total the button carries still fits the smallest phone. */
  const routes = await connectedRoutes(page, { single: 1234.5, submit: () => "lost", check: () => answer });
  await connectedGen(page, 1234.5);
  await takes(page, 4);
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate 4 takes · 4,938 connected cr");
  await floors(page, info);

  /* The reply never comes back: the batch is checked (and fenced) at once. It had not arrived: nothing charged, said so. */
  await page.getByTestId("gen-generate").click();
  await expect(page.getByRole("status").filter({ hasText: "The batch never reached the connected account. Nothing was charged; press Generate to send it again." })).toBeVisible();
  expect(routes.posts.map((p) => p.action).filter((a) => a !== "catalogue" && a !== "quote")).toEqual(["quote-batch", "submit-batch", "check-batch"]);
  expect(routes.posts.at(-1)!.ids).toEqual(routes.paid[0].ids);
  await expect(page.getByTestId("gen-batch")).toHaveCount(0);

  /* Again, and this time it had landed: followed as a strip, and no second paid call is ever made for it. */
  answer = "landed";
  await page.getByTestId("gen-generate").click();
  await expect(page.getByRole("status").filter({ hasText: "The answer was lost on the way back, so the batch was checked: it had reached the connected account." })).toBeVisible();
  await expect(page.getByTestId("gen-batch").getByTestId("gen-batch-take").locator(".gx-asset-name")).toHaveText(["take 1", "take 2", "take 3", "take 4"]);
  expect(routes.paid).toHaveLength(2);
  expect(routes.posts.filter((p) => p.action === "check-batch").map((p) => p.ids)).toEqual(routes.paid.map((p) => p.ids));
  /* Each batch was sent once: the check never re-sends. */
  expect(new Set(routes.paid.map((p) => JSON.stringify(p.ids))).size).toBe(2);
  await floors(page, info);
  await shot(page, info, "connected-lost-reply");
  expect(errors).toEqual([]);
});
