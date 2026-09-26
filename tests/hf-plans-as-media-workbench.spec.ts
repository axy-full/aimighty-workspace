import { test, expect, type Page, type Route, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";

/**
 * Idea 24 — plans and credits as media. A plan card, the rate card and the
 * Workspace balance say what credits make ("≈ 22 videos a month", "≈ 30
 * videos left at your usual settings"), and every one of those figures is the
 * Generate button's own quote (GET /api/workbench/engines?model=…) for the
 * settings it names. Real local routes on a mock engine; nothing is rendered
 * or paid for. Screenshots are opt-in: PLANS_MEDIA_SHOTS=<dir>.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.PLANS_MEDIA_SHOTS;

type Take = { kind: "video" | "image"; engine: string; label: string; resolution: string; ratio: string; durationS: number | null; audio: boolean; credits: number };
type WorkspaceTake = Take & { basis: "usual" | "default"; left: number };
type Group = { kind: "video" | "image"; axis: string; seconds: number | null; rows: { engine: string; label: string; audio: boolean; cells: { option: string; credits: number }[] }[] };
type Plans = { plans: { id: string; label: string; includedCredits: number; reach?: { videos: number | null; images: number | null } }[]; reference: { video: Take | null; image: Take | null } | null; rates: Group[] | null };
type Billing = { credits: { balance: number }; reach: { video: WorkspaceTake | null; image: WorkspaceTake | null } | null; rates: Group[] | null };

const SEEDANCE = "dreamina-seedance-2-5-260628";
const KLING = "fal-ai/kling-video/v3/standard";
const GPT_IMAGE = "gpt-image-2.5-flare";

const n = (v: number) => v.toLocaleString("en-US");
const option = (o: string) => (/^\d+k$/i.test(o) ? o.toUpperCase() : /^\d+$/.test(o) ? `${o} px` : o);
const settings = (t: Take) => [t.label, option(t.resolution), t.durationS ? `${t.durationS} s` : null, t.audio ? "sound" : null].filter(Boolean).join(" · ") + ` · ${n(t.credits)} cr each`;

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace("workbench-", "")}.png`, fullPage: true });
}

/** The Generate button's price for a take at these settings: the quote route the composer reads. */
async function buttonQuote(page: Page, t: Pick<Take, "engine" | "resolution" | "ratio" | "durationS">) {
  const q = new URLSearchParams({ model: t.engine, resolution: t.resolution, ratio: t.ratio, duration: String(t.durationS ?? 5) });
  const response = await page.request.get(`/api/workbench/engines?${q}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).credits as number;
}

async function tenantOf(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    return String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url);
  } finally { platform.close(); }
}

async function grant(workspaceId: string, credits: number) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, credits, "Plans as media", "manual", "test", Date.now()] });
  } finally { platform.close(); }
}

/** Finished takes written straight into this login's tenant database, newest last. */
async function takes(workspaceId: string, rows: { kind: "video" | "image"; model: string; params: Record<string, unknown>; provider?: string; billedTo?: string }[]) {
  const url = await tenantOf(workspaceId);
  expect(url).toMatch(/^file:/);
  const tenant = createClient({ url, timeout: 10_000 });
  try {
    let at = Date.now() - rows.length * 1000;
    for (const row of rows) {
      const id = `gen_reach_${randomUUID().replaceAll("-", "")}`;
      at += 1000;
      await tenant.execute({
        sql: "INSERT INTO generations(id,model,prompt,params,status,stored_url,kind,provider,billed_to,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [id, row.model, "A harbour at dawn", JSON.stringify(row.params), "succeeded", `/api/media/${id}`, row.kind, row.provider ?? "byteplus", row.billedTo ?? null, "test", at, at],
      });
    }
  } finally { tenant.close(); }
}

/**
 * Floors for the new elements (the page chrome around them is measured by its
 * own specs): no sideways scroll, nothing under 12px, no text dimmer than
 * #7C7C84 once composited onto the ground it really sits on, no serif.
 */
async function floors(page: Page, scope: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow").toBe(true);
  const problems = await page.evaluate((scope) => {
    const out: string[] = [];
    const rgba = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    /* The colour a text actually lands on: its own ground composited over every ground beneath it. */
    const ground = (el: Element | null): number[] => {
      const stack: number[][] = [];
      for (let node = el; node; node = node.parentElement) {
        const [r, g, b, a = 1] = rgba(getComputedStyle(node).backgroundColor);
        if (a > 0) stack.push([r, g, b, a]);
        if (a >= 1) break;
      }
      let base = [0, 0, 0];
      for (const [r, g, b, a] of stack.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
      return base;
    };
    const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const floor = lum([0x7c, 0x7c, 0x84]) - 0.5;
    for (const root of Array.from(document.querySelectorAll(scope))) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node.textContent ?? "").trim();
        const el = node.parentElement;
        if (!text || !el || !el.getClientRects().length || el.closest(".mr-sr")) continue;
        const style = getComputedStyle(el);
        if (Number.parseFloat(style.fontSize) < 12) out.push(`${style.fontSize}: “${text.slice(0, 30)}”`);
        const [r, g, b, a = 1] = rgba(style.color);
        const under = ground(el);
        const seen = [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
        if (lum(seen) < floor) out.push(`dim ${style.color} on rgb(${under.map(Math.round).join(",")}): “${text.slice(0, 30)}”`);
        const family = style.fontFamily.split(",")[0].trim().replace(/["']/g, "").toLowerCase();
        if (/^(serif|times|georgia|garamond|palatino|cambria)/.test(family)) out.push(`serif ${family}: “${text.slice(0, 30)}”`);
      }
    }
    return out;
  }, scope);
  expect(problems, `${scope}: text floors`).toEqual([]);
}

test("Pricing: every plan says what a month of its credits makes, at the Generate button's own price, beside every engine's price per take", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const body = (await (await page.request.get("/api/plans")).json()) as Plans;
  const video = body.reference!.video!, image = body.reference!.image!;
  /* The takes plans are counted in: the platform's default engines at 5 s, 720p, 16:9 — each the Generate button's own price. */
  expect(video).toMatchObject({ kind: "video", ratio: "16:9", durationS: 5, audio: false });
  expect(image).toMatchObject({ kind: "image", durationS: null });
  expect(await buttonQuote(page, video)).toBe(video.credits);
  expect(await buttonQuote(page, image)).toBe(image.credits);
  /* Only credits on the wire: no vendor dollar, margin or money. */
  expect(JSON.stringify({ reference: body.reference, rates: body.rates, reach: body.plans.map((p) => p.reach) })).not.toMatch(/usd|margin|cost|\$/i);

  await page.goto("/pricing");
  const paid = body.plans.filter((p) => p.id !== "invite");
  for (const plan of paid) {
    const reach = page.getByTestId(`plan-reach-${plan.id}`);
    const videos = Math.floor(plan.includedCredits / video.credits), images = Math.floor(plan.includedCredits / image.credits);
    expect(plan.reach).toEqual({ videos, images });
    await expect(reach.locator(".mr-tile")).toHaveCount(2);
    await expect(reach.locator(".mr-tile").first()).toHaveText(`≈ ${n(videos)}videos a month${settings(video)}`);
    await expect(reach.locator(".mr-tile").nth(1)).toHaveText(`≈ ${n(images)}images a month${settings(image)}`);
    await expect(reach.locator(".mr-or")).toHaveText("or");
    await expect(reach.getByRole("group").first()).toHaveAttribute("aria-label", `About ${n(videos)} videos a month: ${settings(video)}`);
  }

  /* The rate card: every engine's price per take, the cells plans are counted at outlined. */
  const card = page.getByTestId("rate-card");
  await expect(card).toBeVisible();
  const groups = body.rates!.filter((g) => g.rows.length);
  await expect(card.getByRole("table")).toHaveCount(groups.length);
  await expect(card.getByTestId("rate-row")).toHaveCount(groups.reduce((sum, g) => sum + g.rows.length, 0));
  const videoRow = card.locator(`[data-testid="rate-row"][data-engine="${video.engine}"]`).first();
  await expect(videoRow.getByRole("rowheader")).toHaveText(video.label);
  await expect(videoRow.locator(".mr-cell[data-reference]")).toHaveAttribute("data-option", video.resolution);
  await expect(videoRow.locator(".mr-cell[data-reference] .mr-cell-cr")).toHaveText(n(video.credits));
  await expect(card.locator(`[data-testid="rate-row"][data-engine="${image.engine}"] .mr-cell[data-reference]`)).toHaveAttribute("data-option", image.resolution);
  await expect(card.locator(".mr-cell[data-reference]")).toHaveCount(2);
  await expect(page.getByTestId("rate-card-legend")).toHaveText("Plans are counted at the outlined prices.");
  /* Sound is its own row where it costs more, so turning it on never costs more than the card says. */
  const kling = card.locator(`[data-testid="rate-row"][data-engine="${KLING}"]`);
  await expect(kling).toHaveCount(2);
  await expect(kling.nth(1).getByRole("rowheader")).toHaveText("Kling 3.0 · with sound");
  /* An engine that does not offer a size says so, rather than showing a price. */
  await expect(kling.first().getByRole("cell").first()).toContainText("not offered");

  await floors(page, ".plan-grid .mr-reach, .commercial-rates");
  if ((await card.boundingBox())!.width <= 520) {
    /* Narrow: each engine's prices sit under its name and name their own size. */
    await expect(videoRow.locator(".mr-cell-opt").first()).toBeVisible();
  } else {
    await expect(card.getByRole("columnheader", { name: "720p" }).first()).toBeVisible();
    await expect(videoRow.locator(".mr-cell-opt").first()).toBeHidden();
  }
  await shot(page, info, "pricing");
  expect(errors).toEqual([]);
});

test("Every price on the rate card is the Generate button's quote for that engine, size and length", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop: the check is the wire, not the layout");
  await signInLocally(page.request);
  const body = (await (await page.request.get("/api/plans")).json()) as Plans;
  const checked: string[] = [];
  for (const group of body.rates!) {
    for (const row of group.rows.filter((r) => !r.audio)) {
      for (const cell of row.cells) {
        const ratio = "16:9";
        const credits = await buttonQuote(page, { engine: row.engine, resolution: cell.option, ratio, durationS: group.seconds ?? 5 }).catch(() => null);
        /* A still engine without 16:9 prices the same at any aspect; ask at its first. */
        const got = credits ?? await buttonQuote(page, { engine: row.engine, resolution: cell.option, ratio: "1:1", durationS: 5 });
        expect(got, `${row.label} ${cell.option}`).toBe(cell.credits);
        checked.push(`${row.engine}:${cell.option}`);
      }
    }
  }
  expect(checked.length).toBeGreaterThan(20);
});

test("Workspace › Plans & credits: the balance reads as videos or images left at the settings this workspace actually renders", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { workspace } = await signInLocally(page.request);
  await forbidPaidWork(page);
  await grant(workspace.id, 1050);
  await takes(workspace.id, [
    /* The connected account's takes are the provider's own credits: many, and never counted. */
    ...Array.from({ length: 6 }, () => ({ kind: "video" as const, model: SEEDANCE, params: { resolution: "480p", ratio: "9:16", duration: 12 }, provider: "higgsfield", billedTo: "higgsfield" })),
    { kind: "video", model: KLING, params: { resolution: "1080p", ratio: "16:9", duration: 5 }, provider: "fal" },
    ...Array.from({ length: 3 }, () => ({ kind: "video" as const, model: SEEDANCE, params: { resolution: "1080p", ratio: "16:9", duration: 5 } })),
    ...Array.from({ length: 2 }, () => ({ kind: "image" as const, model: GPT_IMAGE, params: { resolution: "High", ratio: "1:1" }, provider: "openai" })),
  ]);
  const billing = (await (await page.request.get("/api/billing")).json()) as Billing;
  const video = billing.reach!.video!, image = billing.reach!.image!;
  expect(video).toMatchObject({ basis: "usual", engine: SEEDANCE, resolution: "1080p", ratio: "16:9", durationS: 5 });
  expect(image).toMatchObject({ basis: "usual", engine: GPT_IMAGE, resolution: "High" });
  /* Each "per take" is what Generate charges for exactly those settings. */
  expect(await buttonQuote(page, video)).toBe(video.credits);
  expect(await buttonQuote(page, image)).toBe(image.credits);
  expect(video.left).toBe(Math.floor(billing.credits.balance / video.credits));
  expect(image.left).toBe(Math.floor(billing.credits.balance / image.credits));

  await page.goto("/suites?view=workspace&tab=credits");
  await expect(page.getByTestId("workspace-balance")).toBeVisible();
  const tiles = page.getByTestId("workspace-reach");
  await expect(page.getByTestId("workspace-reach-video")).toHaveText(`≈ ${n(video.left)}videos left at your usual settings${settings(video)}`);
  await expect(page.getByTestId("workspace-reach-image")).toHaveText(`≈ ${n(image.left)}images left at your usual settings${settings(image)}`);
  await expect(tiles.locator(".mr-or")).toHaveText("or");
  await expect(page.getByTestId("workspace-reach-loading")).toHaveCount(0);

  /* The balance above refreshes on its own (every 30 s, on focus, on request); the counts follow it, never a stale read. */
  let billingReads = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/billing") billingReads += 1; });
  await grant(workspace.id, 540);
  const balance = billing.credits.balance + 540;
  await page.evaluate(() => window.dispatchEvent(new Event("particl-account-refresh")));
  await expect(page.getByTestId("workspace-balance")).toContainText(n(balance));
  await expect(page.getByTestId("workspace-reach-video")).toContainText(`≈\u00a0${n(Math.floor(balance / video.credits))}videos left`);
  await expect(page.getByTestId("workspace-reach-image")).toContainText(`≈\u00a0${n(Math.floor(balance / image.credits))}images left`);
  expect(billingReads).toBe(0);

  /* The rate card folds under the balance; the cells the balance is counted at are outlined. */
  const rates = page.getByTestId("workspace-rates");
  await expect(page.getByTestId("workspace-rate-card")).toBeHidden();
  await rates.locator("summary").click();
  const card = page.getByTestId("workspace-rate-card");
  await expect(card).toBeVisible();
  await expect(card.locator(`[data-testid="rate-row"][data-engine="${SEEDANCE}"] .mr-cell[data-reference]`)).toHaveAttribute("data-option", "1080p");
  await expect(card.locator(`[data-testid="rate-row"][data-engine="${GPT_IMAGE}"] .mr-cell[data-reference]`)).toHaveAttribute("data-option", "High");
  await expect(page.getByTestId("workspace-rate-card-legend")).toHaveText("Your balance is counted at the outlined prices.");
  await floors(page, '[data-testid="workspace-reach"], [data-testid="workspace-rates"]');
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, '[data-testid="ws-plans"]'), "targets under 44×44").toEqual([]);
    const summary = await rates.locator("summary").boundingBox();
    expect(Math.round(summary!.height * 100) / 100).toBeGreaterThanOrEqual(44);
  }
  await shot(page, info, "workspace-usual");
});

test("A workspace that has made nothing yet is counted at its default engines, and says so", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "a phone and a desktop");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  const billing = (await (await page.request.get("/api/billing")).json()) as Billing;
  /* Only the starter production's demo takes exist, and nobody rendered those. */
  const video = billing.reach!.video!, image = billing.reach!.image!;
  expect(video).toMatchObject({ basis: "default", resolution: "720p", durationS: 5 });
  expect(image.basis).toBe("default");
  await page.goto("/suites?view=workspace&tab=credits");
  await expect(page.getByTestId("workspace-reach-video")).toHaveText(`≈ ${n(video.left)}videos left at the default settings${settings(video)}`);
  await expect(page.getByTestId("workspace-reach-image")).toHaveText(`≈ ${n(image.left)}images left at the default settings${settings(image)}`);
  await shot(page, info, "workspace-default");
});

test("Billing: the balance and each plan read as takes too", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  const billing = (await (await page.request.get("/api/billing")).json()) as Billing;
  const plans = (await (await page.request.get("/api/plans")).json()) as Plans;
  await page.goto("/billing");
  const balance = page.getByTestId("billing-balance-reach");
  await expect(balance.locator(".mr-tile").first()).toHaveText(`≈ ${n(billing.reach!.video!.left)}videos left at the default settings${settings(billing.reach!.video!)}`);
  const agency = plans.plans.find((p) => p.id === "agency")!;
  await expect(page.getByTestId("billing-plan-reach-agency").locator(".mr-tile").first()).toContainText(`≈ ${n(agency.reach!.videos!)}videos a month`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow").toBe(true);
  await floors(page, '[data-testid="billing-balance-reach"], [data-testid^="billing-plan-reach-"]');
  await shot(page, info, "billing");
});

test("States: counting, a refused read, no translation, nothing priceable, and figures too big for a phone", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  const real = (await (await page.request.get("/api/billing")).json()) as Billing;

  /* Loading: the balance says it is counting, then the figures replace it. */
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/billing", async (route) => { await held; await route.fallback(); });
  await page.goto("/suites?view=workspace&tab=credits");
  await expect(page.getByTestId("workspace-reach-loading")).toHaveText("Counting what that buys…");
  release();
  await expect(page.getByTestId("workspace-reach-video")).toBeVisible();
  await expect(page.getByTestId("workspace-reach-loading")).toHaveCount(0);
  await page.unroute("**/api/billing");

  /* A refused read says so, and nothing is left counting. */
  await page.route("**/api/billing", (route) => route.fulfill({ status: 500, json: { error: "Billing could not be read. Try again in a minute." } }));
  await page.reload();
  await expect(page.getByTestId("ws-plans").getByRole("alert").first()).toHaveText("Billing could not be read. Try again in a minute.");
  await expect(page.getByTestId("workspace-reach-loading")).toHaveCount(0);
  await expect(page.getByTestId("workspace-reach")).toHaveCount(0);
  await page.unroute("**/api/billing");

  /* Long figures and names: a very large balance and a long engine name stay inside a phone. The
     count follows the balance the page shows (GET /api/me), so that is the balance raised here. */
  const huge = 22_222_206;
  const raise = async (route: Route) => {
    const json = await (await route.fetch()).json();
    return route.fulfill({ json: { ...json, credits: { ...json.credits, balance: huge } } });
  };
  await page.route("**/api/me", raise);
  await page.route("**/api/billing", async (route) => {
    const json = await (await route.fetch()).json();
    return route.fulfill({ json: { ...json, credits: { ...json.credits, balance: huge }, reach: { video: { ...real.reach!.video!, label: "Seedance 2.5 Cinematic Extended Preview" }, image: real.reach!.image } } });
  });
  await page.reload();
  await expect(page.getByTestId("workspace-reach-video")).toContainText(`≈\u00a0${n(Math.floor(huge / real.reach!.video!.credits))}`);
  await expect(page.getByTestId("workspace-reach-image")).toContainText(`≈\u00a0${n(Math.floor(huge / real.reach!.image!.credits))}`);
  await floors(page, '[data-testid="workspace-reach"], [data-testid="workspace-rates"]');
  await shot(page, info, "workspace-long");
  await page.unroute("**/api/me");
  await page.unroute("**/api/billing");

  /* Pricing without the translation still sells the plans, and says less. */
  await page.route("**/api/plans", async (route) => {
    const json = await (await route.fetch()).json();
    return route.fulfill({ json: { ...json, reference: null, rates: null, plans: json.plans.map((plan: object) => ({ ...plan, reach: undefined })) } });
  });
  await page.goto("/pricing");
  await expect(page.locator(".plan-card")).toHaveCount(3);
  await expect(page.locator(".mr-tile")).toHaveCount(0);
  await expect(page.getByTestId("rate-card")).toHaveCount(0);
  await page.unroute("**/api/plans");

  /* Nothing priceable: the card says so and where a price still comes from. */
  await page.route("**/api/plans", async (route) => {
    const json = await (await route.fetch()).json();
    return route.fulfill({ json: { ...json, rates: json.rates.map((g: Group) => ({ ...g, rows: [] })) } });
  });
  await page.reload();
  await expect(page.getByTestId("rate-card")).toHaveText("No engine can be priced right now. Every take is still priced on its Generate button before it runs.");
  await shot(page, info, "pricing-empty");
});
