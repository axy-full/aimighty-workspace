import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets } from "./phoneFloors";
import { openAdvanced } from "./helpers/makeAdvanced";
import { projectName } from "./helpers/projectName";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here"); });

/**
 * Seedance 2.5 draft mode in Gen (lib/draftFinal.ts): "Draft first · 480p",
 * then "Make the 1080p final · N cr" on the draft's strip, approved with what
 * the final keeps from the draft and that fine detail can differ.
 *
 * Real local routes against an ENGINE_MOCK server: the mocked engine answers
 * in the vendor's own task shape, and `[mock:final-refused]` in a draft's
 * words has it refuse that draft's final at moderation. What each take was
 * charged is read from the server's own books (the project's jobs and the
 * workspace's meter), never from the page: the draft at the 480p price, the
 * final at the 1080p price, nothing twice. Nothing is billed for real.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const ENGINE = "dreamina-seedance-2-5-260628";
const WORDS = "A lighthouse keeper climbs the spiral stair at dusk, lamp in hand";
const MS_DAY = 24 * 60 * 60 * 1000;

type Sent = { path: string; key: string | undefined; body: Record<string, unknown> };

async function seeded(page: Page) {
  const signed = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), signed.workspace.id, 5000, "Local mock draft-mode fixture", "admin", "test", Date.now()],
    });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally {
    platform.close();
  }
  const project: Project = newProject(`Draft mode ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const read = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json()) as { project: Project };
  const productionId = String(read.project.productionProjectId);
  expect(productionId).toMatch(/\S/);
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const sent: Sent[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.startsWith("/api/generate")) sent.push({ path: url.pathname, key: request.headers()["idempotency-key"], body: request.postDataJSON() });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { project, scope, tenantUrl, workspaceId: signed.workspace.id, productionId, sent, errors };
}
type Seeded = Awaited<ReturnType<typeof seeded>>;

async function openGen(page: Page, project: Project) {
  await page.goto(`/suites?make=video&project=${project.id}`);
  await expect(page.getByTestId("gen-view")).toBeVisible({ timeout: 60_000 });
  await openAdvanced(page);
  await expect(projectName(page)).toHaveText(project.name, { timeout: 30_000 });
}

/** What the server quotes for a request right now, in credits (POST /api/generate/quote). */
async function quoted(page: Page, s: Seeded, body: Record<string, unknown>): Promise<number> {
  const reply = await page.request.post("/api/generate/quote", { headers: { "X-Workbench-Scope": s.scope }, data: body });
  const json = await reply.json();
  expect(reply.ok(), JSON.stringify(json)).toBeTruthy();
  return Number(json.estimatedCredits);
}
const take = (s: Seeded, resolution: string, words = WORDS) => ({ model: ENGINE, prompt: words, projectId: s.productionId, ratio: "16:9", resolution, duration: 5, refine: false });

/** A draft made the way Gen makes one (its approved quote as the ceiling), followed until it has rendered. */
async function draftByApi(page: Page, s: Seeded, words: string): Promise<string> {
  const body = { ...take(s, "480p", words), draft: true };
  const credits = await quoted(page, s, body);
  const reply = await page.request.post("/api/generate", { headers: { "X-Workbench-Scope": s.scope, "Idempotency-Key": `draft-${randomUUID()}` }, data: { ...body, maxCredits: credits } });
  const json = await reply.json();
  expect(reply.status(), JSON.stringify(json)).toBe(202);
  await expect.poll(async () => (await page.request.get(`/api/jobs/${json.id}`, { headers: { "X-Workbench-Scope": s.scope } }).then((r) => r.json())).generation?.status, { timeout: 90_000, intervals: [1_000] }).toBe("succeeded");
  return String(json.id);
}

/** Every job this project has on the server, and every charge the workspace has on the meter. */
async function ledger(s: Seeded) {
  const tenant = createClient({ url: s.tenantUrl, timeout: 10_000 });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const jobs = (await tenant.execute({ sql: "SELECT id,status,params FROM generations WHERE project_id=? ORDER BY created_at", args: [s.productionId] })).rows
      .map((r) => ({ id: String(r.id), status: String(r.status), params: JSON.parse(String(r.params)) as Record<string, unknown> }));
    const charges = (await platform.execute({ sql: "SELECT id,status,billed_credits FROM meter_events WHERE workspace_id=? ORDER BY created_at", args: [s.workspaceId] })).rows
      .map((r) => ({ id: String(r.id), status: String(r.status), credits: Number(r.billed_credits) }));
    return { jobs, charges };
  } finally {
    tenant.close();
    platform.close();
  }
}
/** The books once every job has settled on the meter (a job's row is written, then its charge reserved, then settled). */
async function settled(s: Seeded, jobs: number) {
  await expect.poll(async () => {
    const books = await ledger(s);
    return [books.jobs.length, books.charges.filter((c) => c.status !== "running").length];
  }, { timeout: 90_000 }).toEqual([jobs, jobs]);
  return ledger(s);
}

const creditsIn = (label: string | null) => Number((label ?? "").replace(/.*· /, "").replace(/\D/g, ""));

/**
 * The strip keeps the phone's floors and the wide-font rule: nothing scrolls
 * sideways, every target is 44px, every word is no dimmer than #7C7C84 over
 * what it sits on, the priced buttons' labels fit whole (also in a wider
 * sans), and the strip's last line ends above the tab bar.
 */
async function floors(page: Page, info: TestInfo, strip: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const width = page.viewportSize()!.width;
  const box = await strip.boundingBox();
  expect(box && box.x >= -0.5 && box.x + box.width <= width + 0.5, "the strip fits the width").toBeTruthy();
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="gen-view"]'), "targets under 44×44").toEqual([]);
  const dim = await strip.evaluate((root) => {
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
    for (const el of [root as HTMLElement, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      if (!el.getClientRects().length || !Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim())) continue;
      if (el.closest("button:disabled")) continue;
      const [r, g, b, a = 1] = parse(getComputedStyle(el).color);
      const [br, bg, bb] = ground(el);
      if (lum([r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)]) < floor) out.push(`${el.className}: ${getComputedStyle(el).color} — “${el.textContent?.trim().slice(0, 24)}”`);
    }
    return out;
  });
  expect(dim, "words under #7C7C84").toEqual([]);
  const fits = () => strip.evaluate((root) => {
    const out: string[] = [];
    for (const button of Array.from(root.querySelectorAll<HTMLElement>(".gx-draft-go"))) {
      const box = button.getBoundingClientRect(), style = getComputedStyle(button);
      const left = box.left + parseFloat(style.paddingLeft) - 0.5, right = box.right - parseFloat(style.paddingRight) + 0.5;
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim() ?? "";
        if (!text || !node.parentElement?.getClientRects().length) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of Array.from(range.getClientRects())) if (r.width && (r.left < left || r.right > right || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)) out.push(`“${text}” runs past its button`);
      }
      if (button.scrollWidth > button.clientWidth + 1) out.push(`${button.dataset.testid} is ${button.scrollWidth - button.clientWidth}px too narrow`);
    }
    return out;
  });
  expect(await fits(), "priced labels fit their buttons").toEqual([]);
  const wide = await page.addStyleTag({ content: '.gx-draft-go, .gx-draft-go * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }' });
  expect(await fits(), "priced labels fit in a wide fallback sans").toEqual([]);
  await wide.evaluate((el) => (el as HTMLStyleElement).remove());
  /* On a phone the strip's end, scrolled into reach, sits above the tab bar. */
  const bar = page.getByTestId("tabbar");
  if (await bar.isVisible()) {
    const gap = await strip.evaluate((el) => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="gen-view"]')!;
      scroller.scrollTop = scroller.scrollHeight;
      const last = Array.from(el.querySelectorAll<HTMLElement>("*")).filter((n) => n.getClientRects().length).reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a), el as HTMLElement);
      return document.querySelector('[data-testid="tabbar"]')!.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
    });
    expect(gap, "the strip's last line ends above the tab bar").toBeGreaterThanOrEqual(0);
  }
}

/** Opt-in (DRAFT_SHOTS=<dir>): the page and the strip, for review. */
async function shot(page: Page, info: TestInfo, strip: Locator, name: string) {
  const dir = process.env.DRAFT_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const size = info.project.name.replace("workbench-", "");
  await strip.evaluate((el) => { (el as HTMLElement).style.scrollMarginBottom = "120px"; el.scrollIntoView({ block: "end" }); });
  await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
  /* The strip as it shows, clipped to the screen. An element shot taller than the viewport resizes the page to take it,
     and on a touch phone that leaves (pointer: coarse) off for the rest of the test: the next 44px check then measures
     desktop-sized controls (844×390's approval strip is taller than the screen). */
  const box = await strip.boundingBox();
  const view = page.viewportSize()!;
  if (!box) return;
  const x = Math.max(0, box.x), y = Math.max(0, box.y);
  const clip = { x, y, width: Math.min(box.x + box.width, view.width) - x, height: Math.min(box.y + box.height, view.height) - y };
  if (clip.width > 0 && clip.height > 0) await page.screenshot({ path: path.join(dir, `${name}-${size}-strip.png`), clip });
}

test("Draft first: approved at the price on the button, one 480p take, charged once at the 480p price", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(300_000);
  const s = await seeded(page);
  await openGen(page, s.project);
  await page.getByTestId("gen-prompt").fill(WORDS);

  /* Seedance 2.5 on this workspace's credits offers a draft first; it holds the size at 480p and one take. */
  const toggle = page.getByTestId("gen-draft-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: /480p/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: /1080p/ })).toBeDisabled();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("1");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/^Make draft · \d[\d,]* cr$/, { timeout: 60_000 });
  const draftPrice = creditsIn(await go.textContent());
  /* Exactly what any 480p take of these words costs. */
  expect(draftPrice).toBe(await quoted(page, s, take(s, "480p")));
  await go.click();
  /* The accepted press closes Make. */
  await expect(page.getByTestId("make-panel")).toHaveCount(0);

  /* The books: one job, one charge, at the price on the button; one paid request, at that figure as its ceiling. */
  const { jobs, charges } = await settled(s, 1);
  const [draft] = jobs;
  expect(draft.params).toMatchObject({ draft: true, resolution: "480p", watermark: true });
  expect(charges.map((c) => [c.id, c.status, c.credits])).toEqual([[draft.id, "succeeded", draftPrice]]);
  const posts = s.sent.filter((x) => x.path === "/api/generate");
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toMatchObject({ draft: true, resolution: "480p", maxCredits: draftPrice });
  expect(s.errors).toEqual([]);
});

test.fixme("Draft first, then the 1080p final: approved at the price on each button, charged once each — the draft at the 480p price, the final at the 1080p price — the final's UI half has no Release 1 screen: DraftFinalBar is mounted only by the old Inspector and strip (components/graphite/DraftFinal.tsx); owner question: where does a draft's final live? Its server side runs in the API twins; the draft half runs above", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(300_000);
  const s = await seeded(page);
  await openGen(page, s.project);
  await page.getByTestId("gen-prompt").fill(WORDS);

  /* Seedance 2.5 on this workspace's credits offers a draft first; it holds the size at 480p and one take. */
  const toggle = page.getByTestId("gen-draft-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: "480p" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: "1080p" })).toBeDisabled();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("1");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveAttribute("aria-label", /^Make draft · \d[\d,]* cr$/, { timeout: 60_000 });
  const draftPrice = creditsIn(await go.getAttribute("aria-label"));
  /* Exactly what any 480p take of these words costs. */
  expect(draftPrice).toBe(await quoted(page, s, take(s, "480p")));
  await go.click();

  /* The draft lands as its own strip, with its watermark, its date and its final's price. */
  await page.getByTestId("make-tab-recent").click();
  const strip = page.getByTestId("gen-draft").first();
  await expect(strip.getByTestId("draft-final-facts")).toHaveText(/^Watermarked 480p draft · Final available until \w{3} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/, { timeout: 120_000 });
  const make = strip.getByTestId("draft-final-make");
  await expect(make).toHaveAttribute("aria-label", /^Make the 1080p final · \d[\d,]* cr$/, { timeout: 60_000 });
  const finalPrice = creditsIn(await make.getAttribute("aria-label"));
  /* Exactly what a 1080p take of these words costs. */
  expect(finalPrice).toBe(await quoted(page, s, take(s, "1080p")));
  expect(finalPrice).toBeGreaterThan(draftPrice);
  await floors(page, info, strip);
  await shot(page, info, strip, "draft-ready");

  /* Its approval says what cannot change and that fine detail may differ, before anything is sent. */
  const before = s.sent.filter((x) => x.path === "/api/generate").length;
  await make.click();
  const approval = strip.getByTestId("draft-final-approve");
  await expect(approval).toContainText("Its prompt, references, length and shape come from this draft and can’t change.");
  await expect(approval).toContainText("fine detail such as texture or small text can differ slightly");
  await expect(approval.getByTestId("draft-final-approve-send")).toBeFocused();
  await expect(approval.getByTestId("draft-final-approve-send")).toHaveAttribute("aria-label", `Approve · ${finalPrice.toLocaleString("en-US")} cr`);
  expect(s.sent.filter((x) => x.path === "/api/generate").length).toBe(before);
  await floors(page, info, strip);
  await shot(page, info, strip, "draft-approve");
  await approval.getByTestId("draft-final-approve-send").click();

  /* The final lands beside its draft, without the watermark. */
  await expect(strip.getByTestId("draft-final-status")).toHaveText("The 1080p final is made, without the watermark.", { timeout: 120_000 });
  await expect(strip.getByTestId("gen-draft-take")).toHaveCount(2);
  await expect(strip.locator('[data-pair="draft"] [data-testid="gen-draft-take-note"]')).toHaveText("Watermarked");
  await expect(strip.locator('[data-pair="final"] [data-testid="gen-draft-take-note"]')).toHaveText("No watermark");
  await expect(strip.getByTestId("draft-final-make")).toHaveCount(0);

  /* The books: two jobs, two charges, each at the price on its button. */
  const { jobs, charges } = await settled(s, 2);
  const [draft, final] = jobs;
  expect(draft.params).toMatchObject({ draft: true, resolution: "480p", watermark: true, finalGenId: final.id });
  expect(final.params).toMatchObject({ finalOf: draft.id, resolution: "1080p", watermark: false });
  expect(charges.map((c) => [c.id, c.status, c.credits])).toEqual([[draft.id, "succeeded", draftPrice], [final.id, "succeeded", finalPrice]]);
  /* Two paid requests: the draft's words and settings, then the draft alone at its approved ceiling. */
  const posts = s.sent.filter((x) => x.path === "/api/generate");
  expect(posts).toHaveLength(2);
  expect(posts[0].body).toMatchObject({ draft: true, resolution: "480p", maxCredits: draftPrice });
  expect(Object.keys(posts[1].body).sort()).toEqual(["finalOf", "maxCredits", "model", "quoteFingerprint", "refine"]);
  expect(posts[1].body).toMatchObject({ finalOf: draft.id, maxCredits: finalPrice });
  expect(posts[1].key).toBeTruthy();
  await floors(page, info, strip);
  await shot(page, info, strip, "draft-final");

  /* (The Takes desk that filed the pair under its shot is deleted with the stage pages: the board's Shots region draws it.) */
  /* The Library's flat grid keeps the pair together, each card named as the draft or the final. */
  await openGen(page, s.project);
  if (await page.getByTestId("make-open-library").isVisible()) await page.getByTestId("make-open-library").click();
  await expect(page.getByTestId("library").getByTestId("take-pair")).toHaveText(["FINAL", "DRAFT"], { timeout: 60_000 });
  expect(s.errors).toEqual([]);
});

test("a draft is one take at its button's price: takes set before Draft first do not reach the credits pill's last quote", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const s = await seeded(page);
  const balance = Number((await (await page.request.get("/api/me")).json()).credits.balance);
  /* The Generate button's own price read, answered with a figure one take can afford and two cannot (as in the credits-out spec). */
  const price = Math.max(1, balance - 10);
  await page.route(/\/api\/workbench\/engines\?.*model=/, async (route) => {
    const response = await route.fetch();
    return route.fulfill({ response, json: { ...(await response.json()), credits: price } });
  });
  await openGen(page, s.project);
  await page.getByTestId("gen-prompt").fill(WORDS);
  const pill = page.getByTestId("workspace-credits");
  const go = page.getByTestId("gen-generate");
  await page.getByTestId("gen-takes-2").click();
  await expect(go).toHaveText(`Make 2 takes · ${(2 * price).toLocaleString("en-US")} cr`, { timeout: 60_000 });
  await expect(pill).toHaveAttribute("data-low", "true");
  /* Draft first: one take, at one take's price, and that is the last quote the pill measures the balance against. */
  await page.getByTestId("gen-draft-toggle").click();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("1");
  await expect(go).toHaveText(`Make draft · ${price.toLocaleString("en-US")} cr`);
  await expect(pill).not.toHaveAttribute("data-low");
  expect(s.sent.filter((x) => x.path === "/api/generate")).toHaveLength(0);
  expect(s.errors).toEqual([]);
});

/** The server's side of a draft's final, with no screen: quote it fresh, then send it at that figure as its ceiling, with its own key. */
async function finalByApi(page: Page, s: Seeded, draftId: string, maxCredits?: number) {
  const reply = await page.request.post("/api/generate/quote", { headers: { "X-Workbench-Scope": s.scope }, data: { model: ENGINE, finalOf: draftId } });
  const quote = await reply.json();
  expect(reply.ok(), JSON.stringify(quote)).toBeTruthy();
  const credits = Number(quote.estimatedCredits);
  const sent = await page.request.post("/api/generate", { headers: { "X-Workbench-Scope": s.scope, "Idempotency-Key": `final-${randomUUID()}` },
    data: { finalOf: draftId, model: ENGINE, refine: false, maxCredits: maxCredits ?? credits, quoteFingerprint: quote.fingerprint } });
  return { credits, sent, body: await sent.json() };
}

test("API: a draft past its seven days cannot make a final: the server refuses to price or send one, and nothing is charged for it", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "a route check, once");
  test.setTimeout(240_000);
  const s = await seeded(page);
  const draftId = await draftByApi(page, s, WORDS);
  /* Eight days on. */
  const tenant = createClient({ url: s.tenantUrl, timeout: 10_000 });
  try {
    await tenant.execute({ sql: "UPDATE generations SET created_at=created_at-? WHERE id=?", args: [8 * MS_DAY, draftId] });
  } finally {
    tenant.close();
  }
  const quote = await page.request.post("/api/generate/quote", { headers: { "X-Workbench-Scope": s.scope }, data: { model: ENGINE, finalOf: draftId } });
  expect(quote.status()).toBe(409);
  expect((await quote.json()).error).toMatch(/expired on .* seven days/);
  const forced = await page.request.post("/api/generate", { headers: { "X-Workbench-Scope": s.scope, "Idempotency-Key": `late-final-${randomUUID()}` }, data: { model: ENGINE, finalOf: draftId, maxCredits: 999 } });
  expect(forced.status()).toBe(409);
  const { jobs, charges } = await settled(s, 1);
  expect(jobs.map((j) => j.id)).toEqual([draftId]);
  expect(charges).toHaveLength(1);
  expect(s.sent.filter((x) => x.path === "/api/generate")).toHaveLength(0);
});

test("API: a final refused at moderation is not charged on the books, and the draft can make its final again at today's quote", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "a route check, once");
  test.setTimeout(300_000);
  const s = await seeded(page);
  const draftId = await draftByApi(page, s, `${WORDS} [mock:final-refused]`);
  const first = await finalByApi(page, s, draftId);
  expect(first.sent.status(), JSON.stringify(first.body)).toBe(202);
  /* Refused by the (mocked) engine once its status is read (as the card does): the final's job failed and its charge released. */
  await expect.poll(async () => (await page.request.get(`/api/jobs/${first.body.id}`, { headers: { "X-Workbench-Scope": s.scope } }).then((r) => r.json())).generation?.status, { timeout: 90_000, intervals: [1_000] }).toBe("failed");
  const { jobs, charges } = await settled(s, 2);
  const final = jobs.find((j) => j.params.finalOf === draftId)!;
  expect(final.status).toBe("failed");
  expect(charges.find((c) => c.id === final.id)).toMatchObject({ status: "failed", credits: 0 });
  expect(charges.find((c) => c.id === draftId)!.credits).toBeGreaterThan(0);
  /* The draft's price for its final is the same again: it is still offered at the quote. */
  const again = await page.request.post("/api/generate/quote", { headers: { "X-Workbench-Scope": s.scope }, data: { model: ENGINE, finalOf: draftId } });
  expect(again.ok()).toBe(true);
  expect(Number((await again.json()).estimatedCredits)).toBe(first.credits);
});

test.fixme("a draft past its seven days cannot make a final: the button is off, it says why, and nothing can be charged for one — no Release 1 screen for a draft's final; see the API twin above for the server side", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(240_000);
  const s = await seeded(page);
  const draftId = await draftByApi(page, s, WORDS);
  /* Eight days on. */
  const tenant = createClient({ url: s.tenantUrl, timeout: 10_000 });
  try {
    await tenant.execute({ sql: "UPDATE generations SET created_at=created_at-? WHERE id=?", args: [8 * MS_DAY, draftId] });
  } finally {
    tenant.close();
  }
  await openGen(page, s.project);
  await page.getByTestId("make-tab-recent").click();
  const strip = page.getByTestId("gen-draft").first();
  await expect(strip).toHaveAttribute("data-batch-id", `draft:${draftId}`, { timeout: 60_000 });
  const status = strip.getByTestId("draft-final-status");
  await expect(status).toHaveText(/^This draft expired on \w{3} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M: a final can only be made within seven days of its draft\.$/);
  const make = strip.getByTestId("draft-final-make");
  await expect(make).toBeDisabled();
  await expect(make).toHaveText("Make the 1080p final");
  const describedBy = await make.getAttribute("aria-describedby");
  expect(describedBy).toBe(await status.getAttribute("id"));
  await floors(page, info, strip);
  await shot(page, info, strip, "draft-expired");

  /* The server says the same, and nothing is priced, sent or charged. */
  const quote = await page.request.post("/api/generate/quote", { headers: { "X-Workbench-Scope": s.scope }, data: { model: ENGINE, finalOf: draftId } });
  expect(quote.status()).toBe(409);
  expect((await quote.json()).error).toMatch(/expired on .* seven days/);
  const forced = await page.request.post("/api/generate", { headers: { "X-Workbench-Scope": s.scope, "Idempotency-Key": `late-final-${randomUUID()}` }, data: { model: ENGINE, finalOf: draftId, maxCredits: 999 } });
  expect(forced.status()).toBe(409);
  const { jobs, charges } = await settled(s, 1);
  expect(jobs.map((j) => j.id)).toEqual([draftId]);
  expect(charges).toHaveLength(1);
  expect(s.sent.filter((x) => x.path === "/api/generate")).toHaveLength(0);
  expect(s.errors).toEqual([]);
});

test.fixme("a final refused at moderation is not charged on the books, its card says why, and the draft can make its final again at the price on the button — no Release 1 screen for a draft's final; see the API twin above for the server side", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(300_000);
  const s = await seeded(page);
  const draftId = await draftByApi(page, s, `${WORDS} [mock:final-refused]`);
  await openGen(page, s.project);
  await page.getByTestId("make-tab-recent").click();
  const strip = page.getByTestId("gen-draft").first();
  await expect(strip).toHaveAttribute("data-batch-id", `draft:${draftId}`, { timeout: 60_000 });
  const make = strip.getByTestId("draft-final-make");
  await expect(make).toHaveAttribute("aria-label", /^Make the 1080p final · \d[\d,]* cr$/, { timeout: 60_000 });
  const finalPrice = creditsIn(await make.getAttribute("aria-label"));
  await make.click();
  await strip.getByTestId("draft-final-approve-send").click();

  /* Refused by the (mocked) engine: the final's card says it failed and why (the card contract, components/graphite/TakeTile.tsx),
     and the draft offers its final again. What it cost is the books' to say (below): the card shows only that receipt —
     the released reservation, "Not billed" — and nothing on the page guesses beyond it. */
  await expect(strip.locator('[data-pair="final"] [data-testid="take-chip"]')).toHaveText("Failed", { timeout: 120_000 });
  await expect(strip.locator('[data-pair="final"] [data-testid="take-reason"]')).toHaveText("Refused by the content filter");
  await expect(strip.locator('[data-pair="final"] [data-testid="take-charge"]')).toHaveText("Not billed", { timeout: 60_000 });
  await expect(strip.getByTestId("draft-final-status")).toHaveText("The last final did not render.");
  await expect(strip.getByTestId("draft-final-make")).toHaveAttribute("aria-label", `Make the 1080p final · ${finalPrice.toLocaleString("en-US")} cr`, { timeout: 60_000 });
  await expect(strip).not.toContainText(/not charged|nothing was charged|refunded/i);
  await expect(strip.getByText(/not billed/i)).toHaveCount(1);
  await floors(page, info, strip);
  await shot(page, info, strip, "final-refused");

  const { jobs, charges } = await settled(s, 2);
  const final = jobs.find((j) => j.params.finalOf === draftId)!;
  expect(final.status).toBe("failed");
  expect(charges.find((c) => c.id === final.id)).toMatchObject({ status: "failed", credits: 0 });
  expect(charges.find((c) => c.id === draftId)!.credits).toBeGreaterThan(0);
  /* One paid request for the final, never repeated on its own. */
  expect(s.sent.filter((x) => x.path === "/api/generate")).toHaveLength(1);
  expect(s.errors).toEqual([]);
});

test.fixme("a final that never reached the server is checked on the next press, never sent again: the final goes once, under a new key — no Release 1 screen for a draft's final (owner question); the lost-request check and key set-aside have no API twin yet", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  test.setTimeout(300_000);
  const s = await seeded(page);
  const draftId = await draftByApi(page, s, WORDS);
  await openGen(page, s.project);
  await page.getByTestId("make-tab-recent").click();
  const strip = page.getByTestId("gen-draft").first();
  await expect(strip).toHaveAttribute("data-batch-id", `draft:${draftId}`, { timeout: 60_000 });
  const make = strip.getByTestId("draft-final-make");
  await expect(make).toHaveAttribute("aria-label", /^Make the 1080p final · \d[\d,]* cr$/, { timeout: 60_000 });
  const finalPrice = creditsIn(await make.getAttribute("aria-label"));

  /* The final's request is cut off before it reaches the server. */
  let armed = true;
  await page.route("**/api/generate", async (route) => {
    if (!armed || route.request().method() !== "POST") return route.fallback();
    armed = false;
    return route.abort("internetdisconnected");
  });
  await make.click();
  await strip.getByTestId("draft-final-approve-send").click();
  await expect(strip.getByTestId("draft-final-note")).toContainText("never sent twice", { timeout: 60_000 });
  const lost = s.sent.filter((x) => x.path === "/api/generate");
  expect(lost).toHaveLength(1);

  /* The next press asks after the lost request by its key first: it never arrived, so it is set aside, and this press goes. */
  await page.reload();
  await page.getByTestId("make-tab-recent").click();
  const again = page.getByTestId("gen-draft").first();
  await expect(again.getByTestId("draft-final-make")).toHaveAttribute("aria-label", `Make the 1080p final · ${finalPrice.toLocaleString("en-US")} cr`, { timeout: 60_000 });
  const mark = s.sent.length;
  await again.getByTestId("draft-final-make").click();
  await again.getByTestId("draft-final-approve-send").click();
  await expect(again.getByTestId("draft-final-status")).toHaveText("The 1080p final is made, without the watermark.", { timeout: 120_000 });
  const after = s.sent.slice(mark).map((x) => x.path);
  expect(after.indexOf("/api/generate/check")).toBeGreaterThanOrEqual(0);
  expect(after.indexOf("/api/generate/check")).toBeLessThan(after.indexOf("/api/generate"));
  const posted = s.sent.slice(mark).filter((x) => x.path === "/api/generate");
  expect(posted).toHaveLength(1);
  expect(posted[0].key).not.toBe(lost[0].key);
  expect(posted[0].body).toMatchObject({ finalOf: draftId, maxCredits: finalPrice });

  /* The lost request can never land later: its key was set aside when it was checked. */
  const late = await page.request.post("/api/generate", { headers: { "X-Workbench-Scope": s.scope, "Idempotency-Key": lost[0].key! }, data: lost[0].body });
  expect(late.status()).toBe(409);
  const { jobs, charges } = await settled(s, 2);
  expect(jobs.filter((j) => j.params.finalOf === draftId)).toHaveLength(1);
  expect(charges.map((c) => c.credits)).toEqual([charges[0].credits, finalPrice]);
  expect(s.errors).toEqual([]);
});


test.fixme("a moved final quote needs fresh approval and sends no render — no Release 1 screen for a draft's final (owner question); a moved quote needing fresh approval has no screen to test", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const s = await seeded(page);
  await draftByApi(page, s, WORDS);
  let moved = false;
  await page.route("**/api/generate/quote", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (!body.finalOf) return route.fallback();
    const reply = await route.fetch();
    const data = await reply.json();
    return route.fulfill({ json: { ...data, estimatedCredits: Number(data.estimatedCredits) + (moved ? 1 : 0) } });
  });
  await openGen(page, s.project);
  await page.getByTestId("make-tab-recent").click();
  const strip = page.getByTestId("gen-draft").first();
  const make = strip.getByTestId("draft-final-make");
  await expect(make).toHaveAttribute("aria-label", /^Make the 1080p final · \d[\d,]* cr$/, { timeout: 60_000 });
  const original = creditsIn(await make.getAttribute("aria-label"));
  await make.click();
  const approve = strip.getByTestId("draft-final-approve-send");
  moved = true;
  await approve.click();
  await expect(strip.getByTestId("draft-final-note")).toContainText(`The estimate is now about ${original + 1} cr. Approve again`);
  await expect(approve).toHaveAttribute("aria-label", `Approve · ${original + 1} cr`);
  expect(s.sent.filter((x) => x.path === "/api/generate")).toHaveLength(0);
  expect((await ledger(s)).jobs).toHaveLength(1);
  await floors(page, info, strip);
  await strip.getByTestId("draft-final-cancel").click();
  await expect(make).toBeFocused();
  expect(s.errors).toEqual([]);
});
