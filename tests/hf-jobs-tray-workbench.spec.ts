import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import type { TrayJob, TrayReply } from "../lib/jobsTray";
import type { Generation } from "../lib/jobs";

/**
 * The header's jobs tray. The pill counts every take this person has in
 * flight, waiting or held — from any page and either engine — the way the
 * rows are labelled, and opens a tray (a popover on desktop and on a phone on
 * its side, a bottom sheet on a phone) whose rows say each job's real stage,
 * how long it has run or when it finished, the ledger's figure, and one thing
 * to do: Open in Takes (that take), Release a held one (Top up when the
 * balance is short), Recreate a failed one in Gen, or open where a connected
 * tool made it. The route is exercised for real against seeded rows; the UI
 * tests answer the tray's read from a route mock. Nothing is paid for.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844"];
/* The phone floors (44px targets, no sideways scroll) hold on a phone on its side too. */
const TOUCH = [...PHONES, "workbench-844x390"];
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const SHOTS: Record<string, string> = Object.fromEntries(SIZES.map((name) => [name, name.replace("workbench-", "")]));
const DRAFT = "ws-tray";
const MIN = 60_000;
const fixture = (): Project => ({ ...newProject("Harbour launch spot"), id: DRAFT, productionProjectId: "prod-tray", shotMappings: {} });
/* A wider sans than macOS's, as CI's Linux fonts and many Android phones are: what fits must still fit. */
const WIDE_FONT = `.gx, .gx * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }`;

function job(fields: Partial<TrayJob> & Pick<TrayJob, "id" | "name" | "stage" | "label" | "tone">): TrayJob {
  return { source: "engine", kind: "video", mediaUrl: null, reason: null, progress: null, createdAt: Date.now(), settledAt: null, price: null, draftId: DRAFT, projectName: "Harbour launch spot", action: null, ...fields };
}
const recipe = (id: string, name: string, prompt: string) => ({ prompt, model: "dreamina-seedance-2-5-260628", type: "video" as const, billing: "workspace" as const, picks: { ratio: "16:9", duration: 5 }, from: { id, name }, note: `Recreate · ${name}` });
function busyTray(): TrayJob[] {
  const now = Date.now();
  return [
    job({ id: "gen_held", name: "Harbour at dawn", stage: "held", label: "Held · needs 43 cr", tone: "amber", action: "release", releaseCredits: 43, createdAt: now - 12 * MIN }),
    job({ id: "gen_run", name: "A wide shot on the water at first light", stage: "rendering", label: "Rendering", tone: "blue", price: { amount: 13, unit: "cr" }, createdAt: now - 4 * MIN }),
    job({ id: "3f7a1c2e-5b6d-4e8f-9a0b-1c2d3e4f5a6b", source: "account", name: "Product spins on a marble plinth", stage: "rendering", label: "Rendering", tone: "blue", price: { amount: 40, unit: "account-cr" }, createdAt: now - 2 * MIN, draftId: "ws-other", projectName: "Trail bottle ads" }),
    job({ id: "gen_slot", name: "Nets drying on the quay", stage: "queued", label: "Queued", tone: "blue", reason: "Waiting for a free slot", price: { amount: 7, unit: "cr" }, createdAt: now - MIN }),
    job({ id: "gen_fail", name: "Lighthouse at dusk", stage: "failed", label: "Failed · not billed", tone: "red", reason: "Refused by the content filter", action: "recreate", createdAt: now - 30 * MIN, settledAt: now - 20 * MIN,
      preset: recipe("gen_fail", "Lighthouse at dusk", "A slow push-in on a lighthouse at dusk") }),
    job({ id: "gen_done", kind: "image", name: "Gulls over the pier", stage: "complete", label: "Complete", tone: "green", mediaUrl: "/api/media/gen_done", action: "open", takeId: "generation:gen_done", price: { amount: 3, unit: "cr" }, createdAt: now - 50 * MIN, settledAt: now - 45 * MIN }),
    job({ id: "gen_gone", name: "Harbour at noon", stage: "cancelled", label: "Discarded", tone: "idle", action: "recreate", createdAt: now - 70 * MIN, settledAt: now - 60 * MIN,
      preset: recipe("gen_gone", "Harbour at noon", "The harbour at noon") }),
  ];
}

type Tray = { reads: number; reply: () => { status?: number; json: unknown }; gate?: Promise<void> | null };
async function open(page: Page, tray: Tray, options: { url?: string; generations?: Generation[] } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture(), list: [{ id: DRAFT, name: "Harbour launch spot" }, { id: "ws-other", name: "Trail bottle ads" }] });
  await mockLibrary(page, { uploads: [], generations: options.generations ?? [] });
  await page.route(/\/api\/jobs\?view=tray/, async (route) => {
    tray.reads++;
    /* A spec can hold a read out, to see what is asked meanwhile. */
    if (tray.gate) await tray.gate;
    const { status, json } = tray.reply();
    return route.fulfill({ status: status ?? 200, json });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(options.url ?? "/suites?suite=studio&page=rig");
  await expect(page.getByTestId("project-name").first()).toHaveText("Harbour launch spot");
  return errors;
}
const reply = (jobs: TrayJob[], pollAfterSeconds = 10): { json: TrayReply } => ({ json: { jobs, pollAfterSeconds } });

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}
/** Every piece of the header inside the screen, on one row: none pushed past its edge (document.scrollWidth never sees that). */
async function headerFits(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".gx-header");
    if (!header) return ["no header"];
    const out: string[] = [];
    const width = window.innerWidth;
    if (header.scrollWidth > header.clientWidth + 0.5) out.push(`header scrolls: ${header.scrollWidth} > ${header.clientWidth}`);
    for (const child of Array.from(header.children) as HTMLElement[]) {
      const rect = child.getBoundingClientRect();
      if (!rect.width || getComputedStyle(child).position === "absolute") continue;
      if (rect.right > width + 0.5 || rect.left < -0.5) out.push(`${child.dataset.testid || child.className}: ${Math.round(rect.left)}–${Math.round(rect.right)} of ${width}`);
    }
    return out;
  });
}
/** No text in the tray dimmer than #7C7C84 on its ground (its colour laid over the backgrounds under it, down to black). */
async function dimText(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scope) => {
    const rgba = (c: string) => { const n = (c.match(/[\d.]+/g) ?? ["0", "0", "0"]).map(Number); return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
    const luminance = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const floor = luminance([0x7c, 0x7c, 0x84]) - 0.5;
    const root = document.querySelector(scope);
    if (!root) return [`no ${scope}`];
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !(node.textContent ?? "").trim() || !el.getClientRects().length) continue;
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
      let ground = [0, 0, 0];
      for (const e of chain) { const bg = rgba(getComputedStyle(e).backgroundColor); if (bg[3] > 0) ground = over(bg, ground); }
      const style = getComputedStyle(el);
      const ink = over(rgba(style.color), ground);
      if (luminance(ink) < floor) out.push(`${el.className || el.tagName}: ${style.color} — “${(node.textContent ?? "").trim().slice(0, 24)}”`);
    }
    return out;
  }, scope);
}
/** Nothing in the tray scrolls sideways, and every figure is whole. */
async function trayWhole(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tray = document.querySelector<HTMLElement>(".gx-jobs-tray");
    if (!tray) return ["no tray"];
    const out: string[] = [];
    const box = tray.getBoundingClientRect();
    for (const el of [tray, ...Array.from(tray.querySelectorAll<HTMLElement>(".gx-jobs-list, .gx-jobs-row"))])
      if (el.scrollWidth > el.clientWidth + 0.5) out.push(`${el.className} scrolls sideways: ${el.scrollWidth} > ${el.clientWidth}`);
    for (const price of Array.from(tray.querySelectorAll<HTMLElement>(".gx-jobs-price"))) {
      const rect = price.getBoundingClientRect();
      if (price.scrollWidth > price.clientWidth + 0.5 || rect.right > box.right + 0.5) out.push(`price cut: “${price.textContent}”`);
    }
    return out;
  });
}
/** At the list's end, the last row ends above the tab bar. */
async function lastRowAboveTabBar(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".gx-jobs-list");
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    if (!list) return ["no list"];
    if (!bar || !bar.getClientRects().length) return [];
    list.scrollTop = list.scrollHeight;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(".gx-jobs-row"));
    const last = rows[rows.length - 1];
    if (!last) return ["no rows"];
    const bottom = last.getBoundingClientRect().bottom, top = bar.getBoundingClientRect().top;
    return bottom <= top + 0.5 ? [] : [`last row ends at ${Math.round(bottom)}, the tab bar starts at ${Math.round(top)}`];
  });
}
async function shoot(page: Page, project: string, name: string) {
  const size = SHOTS[project];
  const dir = process.env.HF_JOBS_SHOTS;
  if (!size || !dir) return;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
}
/** The sheet rises and the popover pops in: measure it once it has arrived. */
async function arrived(page: Page) {
  await page.getByTestId("jobs-veil").evaluate((veil) => Promise.all(veil.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
}
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
const announce = (page: Page, id: string) => page.evaluate((job) => window.dispatchEvent(new CustomEvent("particl:jobs", { detail: { id: job } })), id);

test("the pill counts the rows the way they are labelled, fits the header, and opens a tray with each job's stage, time, figure and one action", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const touch = TOUCH.includes(info.project.name);
  const tray: Tray = { reads: 0, reply: () => reply(busyTray()) };
  const errors = await open(page, tray);

  const pill = page.getByTestId("running-jobs");
  /* Two rows say Rendering, one says Queued (waiting for a slot), one says Held: the pill says the same. */
  await expect(pill).toHaveAccessibleName("Jobs: 2 rendering · 1 queued · 1 held");
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  /* A phone and a phone on its side say the one figure, so the header keeps its row. */
  await expect(pill.locator(touch ? ".gx-jobs-short" : ".gx-jobs-long")).toHaveText(touch ? "4" : "2 rendering · 1 queued · 1 held");
  await expect(pill.locator(touch ? ".gx-jobs-long" : ".gx-jobs-short")).toBeHidden();
  if (touch) {
    const target = (await pill.boundingBox())!;
    expect(Math.round(target.height * 100) / 100).toBeGreaterThanOrEqual(44);
    expect(Math.round(target.width * 100) / 100).toBeGreaterThanOrEqual(44);
  }
  if (phone) {
    const [pillTop, avatarTop] = await Promise.all([pill, page.getByTestId("workspace-avatar")].map((l) => l.evaluate((el) => Math.round(el.getBoundingClientRect().top))));
    expect(avatarTop).toBe(pillTop);
  }
  expect(await headerFits(page), "header pieces past the screen's edge").toEqual([]);
  await noOverflow(page);
  await shoot(page, info.project.name, "jobs-pill");

  await pill.click();
  const panel = page.getByRole("dialog", { name: "Jobs" });
  await expect(panel).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("jobs-summary")).toHaveText("2 rendering · 1 queued · 1 held");
  const rows = panel.getByTestId("jobs-row");
  await expect(rows).toHaveCount(7);
  /* Held first (it waits on you), then what renders newest first, then what waits its turn, then what finished, latest first. */
  await expect(rows.locator(".gx-jobs-name")).toHaveText(["Harbour at dawn", "Product spins on a marble plinth", "A wide shot on the water at first light", "Nets drying on the quay", "Lighthouse at dusk", "Gulls over the pier", "Harbour at noon"]);
  await expect(rows.getByTestId("jobs-stage")).toHaveText(["Held · needs 43 cr", "Rendering", "Rendering", "Queued", "Failed · not billed", "Complete", "Discarded"]);
  /* How long it has been going; when it finished. */
  await expect(rows.getByTestId("jobs-when")).toHaveText(["12 min", "2 min", "4 min", "1 min", "20 min ago", "45 min ago", "1 h ago"]);
  /* The ledger's figure, whole; a held row's label already names what it needs. A connected job's is the account's own credits, and says so. */
  await expect(rows.nth(0).getByTestId("jobs-price")).toHaveCount(0);
  await expect(rows.getByTestId("jobs-price")).toHaveText(["40 connected cr", "13 cr", "7 cr", "3 cr"]);
  /* Made in another project: named, so the row says where Open would go. */
  await expect(rows.nth(1).getByTestId("jobs-where")).toHaveText("Trail bottle ads");
  await expect(rows.nth(2).getByTestId("jobs-where")).toHaveCount(0);
  /* No engine reports a percentage: an indeterminate bar on the two that render, and nothing on what waits. */
  await expect(panel.getByTestId("jobs-bar")).toHaveCount(2);
  await expect(rows.nth(0).getByTestId("jobs-bar")).toHaveCount(0);
  await expect(rows.nth(3).getByTestId("jobs-bar")).toHaveCount(0);
  await expect(panel.getByTestId("jobs-bar").first()).not.toHaveAttribute("aria-valuenow", /.*/);
  await expect(rows.nth(3).getByTestId("jobs-reason")).toHaveText("Waiting for a free slot");
  await expect(rows.nth(4).getByTestId("jobs-reason")).toHaveText("Refused by the content filter");
  /* Release carries the figure it approves. */
  await expect(rows.getByTestId("jobs-action")).toHaveText(["Release · 43 cr", "Recreate", "Open in Takes", "Recreate"]);
  await expect(rows.nth(5).locator(".gx-jobs-thumb img")).toBeVisible();
  await expect(rows.nth(6)).toHaveAttribute("data-tone", "idle");
  expect(errors).toEqual([]);

  /* Geometry: a bottom sheet across a phone, a popover under the pill elsewhere; nothing spills, nothing is dim, every figure whole. */
  await arrived(page);
  const box = (await panel.boundingBox())!;
  const view = page.viewportSize()!;
  if (phone) {
    expect(Math.round(box.width)).toBe(view.width);
    expect(Math.round(box.y + box.height)).toBe(view.height);
    expect(await lastRowAboveTabBar(page), "the last row and the tab bar").toEqual([]);
  } else {
    const pillBox = (await pill.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    expect(Math.abs(box.x + box.width - (pillBox.x + pillBox.width))).toBeLessThanOrEqual(2);
  }
  if (touch) expect(await smallTargets(page, ".gx-jobs-tray"), "targets under 44×44").toEqual([]);
  expect(await dimText(page, ".gx-jobs-tray"), "text dimmer than #7C7C84").toEqual([]);
  expect(await trayWhole(page)).toEqual([]);
  await noOverflow(page);
  await shoot(page, info.project.name, "jobs-tray");

  /* A modal tray keeps Tab inside it: past its last control is its first. */
  await rows.getByTestId("jobs-action").last().focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("jobs-close")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(rows.getByTestId("jobs-action").last()).toBeFocused();

  /* The same, set in a wider sans: the header still fits, and no figure is cut. */
  await page.addStyleTag({ content: WIDE_FONT });
  expect(await trayWhole(page), "with a wider font").toEqual([]);
  if (phone) expect(await lastRowAboveTabBar(page), "with a wider font").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(pill).toBeFocused();
  expect(await headerFits(page), "header with a wider font").toEqual([]);
  if (phone) {
    const [pillTop, avatarTop] = await Promise.all([pill, page.getByTestId("workspace-avatar")].map((l) => l.evaluate((el) => Math.round(el.getBoundingClientRect().top))));
    expect(avatarTop, "one header row with a wider font").toBe(pillTop);
  }
  await noOverflow(page);
});

test("a long list keeps a failed read's note in view at the top, above the rows it is about", async ({ page }, info) => {
  test.skip(![...DESKTOP, ...PHONES].includes(info.project.name), "desktop and phones");
  const many = Array.from({ length: 12 }, (_, i) => job({ id: `gen_${i}`, name: `Take ${i + 1} of the harbour`, stage: "complete", label: "Complete", tone: "green", action: "open", takeId: `generation:gen_${i}`, price: { amount: 3, unit: "cr" }, settledAt: Date.now() - i * MIN }));
  const tray: Tray = { reads: 0, reply: () => reply(many, 60) };
  await open(page, tray);
  await page.getByTestId("running-jobs").click();
  const panel = page.getByRole("dialog", { name: "Jobs" });
  await expect(panel.getByTestId("jobs-row")).toHaveCount(12);
  tray.reply = () => ({ status: 503, json: { error: "down" } });
  const failedAt = tray.reads;
  await announce(page, "gen_new");
  await expect.poll(() => tray.reads).toBe(failedAt + 1);
  const note = panel.getByTestId("jobs-error");
  await expect(note).toContainText("Jobs could not be read. Trying again shortly.");
  await arrived(page);
  await expect(panel.getByTestId("jobs-retry")).toHaveText("Try again");
  /* In view without scrolling, and before the first row. */
  const [noteBox, listBox, firstRow] = await Promise.all([note.boundingBox(), panel.getByTestId("jobs-list").boundingBox(), panel.getByTestId("jobs-row").first().boundingBox()]);
  expect(noteBox!.y).toBeGreaterThanOrEqual(listBox!.y - 0.5);
  expect(noteBox!.y + noteBox!.height).toBeLessThanOrEqual(listBox!.y + listBox!.height + 0.5);
  expect(noteBox!.y).toBeLessThan(firstRow!.y);
  expect(await dimText(page, ".gx-jobs-tray")).toEqual([]);
  await noOverflow(page);
  await shoot(page, info.project.name, "jobs-tray-read-failed");
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, ".gx-jobs-tray"), "targets under 44×44").toEqual([]);
    expect(await lastRowAboveTabBar(page), "the last row and the tab bar").toEqual([]);
  }
});

test("Release approves the figure on its button; short, a moved price and a lost reply are said, and a second press is never a second charge", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const tray: Tray = { reads: 0, reply: () => reply(busyTray()) };
  await open(page, tray);
  const releases: { path: string; credits: unknown }[] = [];
  let answer: "short" | "lost" | "moved" | "already" = "short";
  await page.route(/\/api\/jobs\/[^/]+\/release$/, (route) => {
    releases.push({ path: new URL(route.request().url()).pathname, credits: (route.request().postDataJSON() as { credits?: unknown } | null)?.credits });
    if (answer === "short") return route.fulfill({ status: 402, json: { error: "Still short: this needs 43 credits and 5 are left.", credits: 43 } });
    if (answer === "lost") return route.abort("connectionreset");
    if (answer === "moved") return route.fulfill({ status: 409, json: { error: "The price is now 45 cr. Press Release again to approve it.", credits: 45 } });
    /* Released by the press whose reply was lost: from now on the read has it queued, and this press charges nothing more. */
    tray.reply = () => reply(busyTray().map((j) => (j.id === "gen_held" ? { ...j, stage: "queued", label: "Queued", tone: "blue", action: null, releaseCredits: null } : j)));
    return route.fulfill({ json: { released: true, id: "gen_held", already: true } });
  });
  await page.getByTestId("running-jobs").click();
  const held = page.getByTestId("jobs-row").filter({ hasText: "Harbour at dawn" });
  await held.getByRole("button", { name: "Release · 43 cr: Harbour at dawn" }).click();
  await expect(held.getByTestId("jobs-problem")).toHaveText("Still short: this needs 43 credits and 5 are left.");
  await expect(held.getByTestId("jobs-action")).toHaveText("Top up");
  expect(releases).toEqual([{ path: "/api/jobs/gen_held/release", credits: 43 }]);
  await arrived(page);
  if (TOUCH.includes(info.project.name)) expect(await smallTargets(page, ".gx-jobs-tray"), "targets under 44×44").toEqual([]);
  expect(await dimText(page, ".gx-jobs-tray")).toEqual([]);
  await shoot(page, info.project.name, "jobs-tray-short");

  /* Top up goes where credits are bought; the tray closes. */
  await held.getByTestId("jobs-action").click();
  await expect(page.getByRole("dialog", { name: "Jobs" })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("credits");
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("workspace");

  /* Topped up: the reply to the next press is lost. Said so, and pressing again is safe. */
  answer = "lost";
  await page.getByTestId("running-jobs").click();
  await expect(page.getByRole("dialog", { name: "Jobs" })).toBeVisible();
  await held.getByRole("button", { name: "Release · 43 cr: Harbour at dawn" }).click();
  await expect(held.getByTestId("jobs-problem")).toHaveText("The release was not confirmed. Press Release again to check — it is never charged twice.");
  /* The price moved meanwhile: the route names it, and the button now approves that figure — nothing started at the old one. */
  answer = "moved";
  await held.getByRole("button", { name: "Release · 43 cr: Harbour at dawn" }).click();
  await expect(held.getByTestId("jobs-problem")).toHaveText("The price is now 45 cr. Press Release again to approve it.");
  await expect(held.getByTestId("jobs-action")).toHaveText("Release · 45 cr");
  /* Pressed at the new figure: the lost press had started it after all, so this one is answered "already" and charges nothing. */
  answer = "already";
  const before = tray.reads;
  await held.getByRole("button", { name: "Release · 45 cr: Harbour at dawn" }).click();
  await expect(page.getByTestId("toast")).toHaveText("Harbour at dawn was already released.");
  await expect.poll(() => tray.reads).toBeGreaterThan(before);
  expect(releases.map((r) => r.credits)).toEqual([43, 43, 43, 45]);
  await expect(held.getByTestId("jobs-stage")).toHaveText("Queued");
  await expect(page.getByTestId("running-jobs")).toHaveAccessibleName("Jobs: 2 rendering · 2 queued");
});

test("Open in Takes opens the take that was clicked — also when Takes is already open — and Recreate hands Gen its recipe without sending anything", async ({ page }, info) => {
  test.skip(![...DESKTOP, "workbench-390x844", "workbench-844x390"].includes(info.project.name), "desktop, a phone, and a phone on its side");
  const now = Date.now();
  const older = generation({ id: "gen_older", title: "Older still: nets drying on the quay", projectId: "prod-tray", createdAt: now - 40 * MIN });
  const newer = generation({ id: "gen_newer", title: "Newer still: a gull on a bollard", projectId: "prod-tray", createdAt: now - 5 * MIN });
  const finished = (g: Generation, minutes: number) => job({ id: g.id, kind: "image", name: g.title!, stage: "complete", label: "Complete", tone: "green", mediaUrl: `/api/media/${g.id}`, action: "open", takeId: `generation:${g.id}`, price: { amount: 3, unit: "cr" }, createdAt: g.createdAt, settledAt: now - minutes * MIN });
  const tray: Tray = { reads: 0, reply: () => reply([...busyTray().filter((j) => j.stage === "failed"), finished(newer, 4), finished(older, 39)], 60) };
  const errors = await open(page, tray, { generations: [newer, older] });
  const paid: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && /\/api\/(generate|audio|jobs\/[^/]+\/retry)(\?|$)/.test(new URL(request.url()).pathname)) paid.push(request.url()); });
  const selected = page.locator("[data-section='edit-panel']");

  /* The older of two finished takes: Takes opens on it, not on the newest. */
  await page.getByTestId("running-jobs").click();
  await page.getByRole("button", { name: "Open in Takes: Older still: nets drying on the quay" }).click();
  await expect(page.getByRole("dialog", { name: "Jobs" })).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect(selected).toContainText("Selected · Older still: nets drying on the quay");
  await shoot(page, info.project.name, "jobs-open-in-takes");
  /* Takes already open: the other take is picked the same way. */
  await page.getByTestId("running-jobs").click();
  await page.getByRole("button", { name: "Open in Takes: Newer still: a gull on a bollard" }).click();
  await expect(selected).toContainText("Selected · Newer still: a gull on a bollard");

  /* Recreate: the failed take's recipe, in Gen, priced again there; nothing is sent from here. */
  await page.getByTestId("running-jobs").click();
  await page.getByRole("button", { name: "Recreate: Lighthouse at dusk" }).click();
  await expect(page.getByRole("dialog", { name: "Jobs" })).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("A slow push-in on a lighthouse at dusk");
  await expect(page.getByTestId("toast")).toHaveText("Lighthouse at dusk’s recipe is in Gen.");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Lighthouse at dusk");
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("the tray reads at the server's pace, not while the tab is hidden, and soon after a job starts or ends or the tray opens", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await page.clock.install();
  /* Freeze before navigation: cold compilation must not advance the poll clock. */
  await page.clock.pauseAt(Date.now() + 50);
  let completedReads = 0;
  page.on("requestfinished", (request) => {
    if (request.method() === "GET" && /\/api\/jobs\?view=tray/.test(request.url())) completedReads++;
  });
  const tray: Tray = { reads: 0, reply: () => reply(busyTray(), 10) };
  await open(page, tray);
  /* Strict Mode may abort its probe read; only completed responses advance the pace. */
  await expect.poll(() => completedReads).toBe(1);
  /* The response must have reached React before advancing the next poll's clock. */
  await expect(page.getByTestId("running-jobs")).toBeVisible();
  await page.waitForTimeout(250);

  /* Never sooner than the 10 s the server asked for (plus the margin), nor much later. */
  await page.clock.runFor(9_000);
  await page.waitForTimeout(300);
  expect(completedReads).toBe(1);
  await page.clock.runFor(4_000);
  await expect.poll(() => completedReads).toBe(2);
  await page.waitForTimeout(250);

  /* Hidden: nothing is asked; back: the read that fell due is made at once. */
  await setHidden(page, true);
  await page.clock.runFor(60_000);
  await page.waitForTimeout(300);
  expect(completedReads).toBe(2);
  await setHidden(page, false);
  await expect.poll(() => completedReads).toBe(3);
  await page.waitForTimeout(250);

  /* A job started or ended anywhere is read for soon; two said together are one read. */
  await announce(page, "gen_new");
  await announce(page, "gen_new");
  await page.clock.runFor(200);
  await expect.poll(() => completedReads).toBe(4);
  await page.waitForTimeout(250);
  await page.clock.runFor(200);
  await page.waitForTimeout(250);
  expect(completedReads).toBe(4);

  /* Another is announced while that read is still out: one more read the moment it is back, not on the next turn. */
  const startedBeforeGate = tray.reads;
  let letGo: () => void = () => {};
  tray.gate = new Promise<void>((resolve) => { letGo = resolve; });
  await announce(page, "gen_a");
  await page.clock.runFor(200);
  await expect.poll(() => tray.reads).toBe(startedBeforeGate + 1);
  await announce(page, "gen_b");
  await page.clock.runFor(200);
  await page.waitForTimeout(250);
  expect(tray.reads).toBe(startedBeforeGate + 1);
  expect(completedReads).toBe(4);
  tray.gate = null;
  letGo();
  await page.waitForTimeout(250);
  await page.clock.runFor(50);
  await expect.poll(() => completedReads).toBe(6);
  await page.waitForTimeout(250);
  await page.clock.runFor(2_000);
  await page.waitForTimeout(250);
  expect(completedReads).toBe(6);

  /* Opening the tray reads it fresh. */
  await page.getByTestId("running-jobs").click();
  await expect.poll(() => completedReads).toBe(7);
  await page.waitForTimeout(250);

  /* Nothing left: the open tray says what happened and offers the next step (the pill stays while it is open). */
  tray.reply = () => reply([], 60);
  await page.getByTestId("jobs-close").click();
  await page.getByTestId("running-jobs").click();
  await expect(page.getByTestId("jobs-empty").locator("p")).toHaveText("Nothing is rendering or waiting, and nothing finished in the last 6 hours.");
  await expect(page.getByTestId("jobs-summary")).toHaveCount(0);
  await expect(page.getByTestId("jobs-generate")).toHaveText("Generate");
  await expect(page.getByTestId("running-jobs")).toHaveAccessibleName("Jobs");

  /* A failed read says so, keeps asking on its own, and Try again asks at once. */
  tray.reply = () => ({ status: 503, json: { error: "down" } });
  const failedAt = completedReads;
  await page.clock.runFor(75_000);
  await expect.poll(() => completedReads).toBe(failedAt + 1);
  await expect(page.getByTestId("jobs-error")).toContainText("Jobs could not be read. Trying again shortly.");
  await expect(page.getByTestId("jobs-empty")).toHaveCount(0);
  tray.reply = () => reply(busyTray());
  await page.getByTestId("jobs-retry").click();
  await expect.poll(() => completedReads).toBe(failedAt + 2);
  await expect(page.getByTestId("jobs-error")).toHaveCount(0);
  await expect(page.getByTestId("jobs-row")).toHaveCount(7);
  await page.waitForTimeout(250);

  /* Signed out: said as that, and asked again (less often), so signing back in brings the jobs back. */
  tray.reply = () => ({ status: 401, json: { error: "Not signed in" } });
  const outAt = completedReads;
  await page.clock.runFor(13_000);
  await expect.poll(() => completedReads).toBe(outAt + 1);
  await expect(page.getByTestId("jobs-error")).toHaveText("You are signed out. Sign in again to see your jobs.Try again");
  tray.reply = () => reply(busyTray());
  /* The failed read doubled the wait: the next comes within half a minute, on its own. */
  await page.clock.runFor(26_000);
  await expect.poll(() => completedReads).toBeGreaterThan(outAt + 1);
  await expect(page.getByTestId("jobs-error")).toHaveCount(0);
  await page.waitForTimeout(250);

  /* This tab is no longer the signed-in workspace: it stops asking and says why, keeping the rows. */
  tray.reply = () => ({ status: 409, json: { error: "Reload this page" } });
  const stoppedAt = completedReads;
  await page.clock.runFor(13_000);
  await expect.poll(() => completedReads).toBe(stoppedAt + 1);
  await expect(page.getByTestId("jobs-error")).toHaveText("Jobs stopped: this tab's account or workspace changed.");
  await expect(page.getByTestId("jobs-retry")).toHaveCount(0);
  await expect(page.getByTestId("jobs-row")).toHaveCount(7);
  await page.clock.runFor(5 * 60_000);
  await announce(page, "x");
  await page.clock.runFor(200);
  await page.waitForTimeout(500);
  expect(completedReads).toBe(stoppedAt + 1);
  /* Closed, the pill goes: the last count is not the changed account's. */
  await page.getByTestId("jobs-close").click();
  await expect(page.getByTestId("running-jobs")).toHaveCount(0);
  expect(completedReads).toBe(stoppedAt + 1);
});

test("with nothing running, what finished is news until it is seen; then the pill stays, quiet, so the rows can be reached again", async ({ page }, info) => {
  test.skip(![...DESKTOP, ...TOUCH].includes(info.project.name), "desktop, phones and a phone on its side");
  const tray: Tray = { reads: 0, reply: () => reply([]) };
  await open(page, tray);
  await expect.poll(() => tray.reads).toBeGreaterThan(0);
  await expect(page.getByTestId("running-jobs")).toHaveCount(0);
  /* Two takes finish after the page opened. */
  const at = Date.now();
  const finished = [
    job({ id: "gen_a", name: "Gulls over the pier", stage: "complete", label: "Complete", tone: "green", action: "open", takeId: "generation:gen_a", settledAt: at }),
    job({ id: "gen_b", name: "Lighthouse at dusk", stage: "failed", label: "Failed · not billed", tone: "red", action: "recreate", settledAt: at, preset: recipe("gen_b", "Lighthouse at dusk", "Lighthouse") }),
  ];
  tray.reply = () => reply(finished, 60);
  await announce(page, "gen_a");
  const pill = page.getByTestId("running-jobs");
  await expect(pill).toHaveAccessibleName("Jobs: 1 done · 1 failed");
  await expect(pill).toHaveAttribute("data-tone", "red");
  await pill.click();
  await expect(page.getByTestId("jobs-row")).toHaveCount(2);
  await expect(page.getByTestId("jobs-summary")).toHaveText("1 done · 1 failed");
  /* A third finishes while the tray is open, in plain view: seen then, never news afterwards. */
  tray.reply = () => reply([...finished, job({ id: "gen_c", name: "Nets drying", stage: "complete", label: "Complete", tone: "green", action: "open", takeId: "generation:gen_c", settledAt: Date.now() })], 60);
  await announce(page, "gen_c");
  await expect(page.getByTestId("jobs-row")).toHaveCount(3);
  await page.getByTestId("jobs-close").click();
  /* Seen: quiet, but still there, and still there after a reload — never a dead end while the tray has rows. */
  await expect(pill).toHaveAccessibleName("Jobs");
  await expect(pill).toHaveAttribute("data-kind", "quiet");
  await expect(pill).toHaveAttribute("data-tone", "idle");
  if (TOUCH.includes(info.project.name)) {
    /* Short of room it is the jobs glyph alone, on a 44px target, and the header keeps its one row. */
    await expect(pill.locator(".gx-jobs-short svg")).toBeVisible();
    const target = (await pill.boundingBox())!;
    expect(Math.round(target.width * 100) / 100).toBeGreaterThanOrEqual(44);
    expect(Math.round(target.height * 100) / 100).toBeGreaterThanOrEqual(44);
    const [pillTop, avatarTop] = await Promise.all([pill, page.getByTestId("workspace-avatar")].map((l) => l.evaluate((el) => Math.round(el.getBoundingClientRect().top))));
    expect(avatarTop).toBe(pillTop);
  } else await expect(pill.locator(".gx-jobs-long")).toHaveText("Jobs");
  expect(await headerFits(page), "the quiet pill in the header").toEqual([]);
  await shoot(page, info.project.name, "jobs-pill-quiet");
  const beforeReload = tray.reads;
  await page.reload();
  await expect(page.getByTestId("project-name").first()).toHaveText("Harbour launch spot");
  await expect.poll(() => tray.reads).toBeGreaterThan(beforeReload);
  await expect(pill).toHaveAccessibleName("Jobs");
  await pill.click();
  await expect(page.getByTestId("jobs-row")).toHaveCount(3);
  await expect(page.getByTestId("jobs-summary")).toHaveText("Nothing running");
  await arrived(page);
  if (TOUCH.includes(info.project.name)) expect(await smallTargets(page, ".gx-jobs-tray"), "targets under 44×44").toEqual([]);
  await shoot(page, info.project.name, "jobs-tray-quiet");
  await page.getByTestId("jobs-close").click();
  await page.addStyleTag({ content: WIDE_FONT });
  expect(await headerFits(page), "the quiet pill with a wider font").toEqual([]);
  if (TOUCH.includes(info.project.name)) {
    const [pillTop, avatarTop] = await Promise.all([pill, page.getByTestId("workspace-avatar")].map((l) => l.evaluate((el) => Math.round(el.getBoundingClientRect().top))));
    expect(avatarTop, "with a wider font").toBe(pillTop);
  }
  await page.getByTestId("running-jobs").click();
  /* The failed one can still be made again from here. */
  await page.getByRole("button", { name: "Recreate: Lighthouse at dusk" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
});

test("a failed first jobs read keeps recovery reachable without inventing an empty queue", async ({ page }, info) => {
  const tray: Tray = { reads: 0, reply: () => ({ status: 503, json: { error: "Unavailable" } }) };
  const errors = await open(page, tray);
  const pill = page.getByTestId("running-jobs");
  await expect(pill).toHaveAccessibleName("Jobs could not be read. Open to try again.");
  await expect(pill).toHaveAttribute("data-tone", "red");
  expect(await headerFits(page)).toEqual([]);
  await noOverflow(page);
  await pill.click();
  await expect(page.getByTestId("jobs-error")).toContainText("Jobs could not be read. Trying again shortly.");
  await expect(page.getByTestId("jobs-empty")).toHaveCount(0);
  await expect(page.getByTestId("jobs-row")).toHaveCount(0);
  await arrived(page);
  if (TOUCH.includes(info.project.name)) expect(await smallTargets(page, ".gx-jobs-tray")).toEqual([]);
  tray.reply = () => reply(busyTray());
  await page.getByTestId("jobs-retry").click();
  await expect(page.getByTestId("jobs-row")).toHaveCount(7);
  await expect(page.getByTestId("jobs-error")).toHaveCount(0);
  await expect(pill).toHaveAccessibleName("Jobs: 2 rendering · 1 queued · 1 held");
  expect(errors).toEqual([]);
});

test("a tray that cannot be drawn costs the pill, not the header, and Try again brings it back", async ({ page }, info) => {
  test.skip(!["workbench-1440x900", "workbench-390x844"].includes(info.project.name), "a desktop and a phone");
  const tray: Tray = { reads: 0, reply: () => reply(busyTray()) };
  await page.addInitScript(() => { (window as unknown as { __particlCrash?: string[] }).__particlCrash = ["jobs"]; });
  await open(page, tray);
  const fault = page.getByTestId("jobs-fault");
  await expect(fault).toBeVisible();
  await expect(fault).toHaveAccessibleName("The jobs tray could not be shown. Try again");
  await expect(page.getByTestId("workspace-avatar")).toBeVisible();
  expect(await headerFits(page)).toEqual([]);
  await page.evaluate(() => { (window as unknown as { __particlCrash?: string[] }).__particlCrash = []; });
  await fault.click();
  await expect(page.getByTestId("running-jobs")).toHaveAccessibleName("Jobs: 2 rendering · 1 queued · 1 held");
});

test("GET /api/jobs?view=tray lists this person's own takes from both engines, with the ledger's figures and real settle times, and nothing of anyone else's", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one API run");
  const account = await signInLocally(page.request);
  /* The platform's meter is shared by every workspace on this server: this run's takes have ids of their own. */
  const tag = randomBytes(3).toString("hex");
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string } };
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  /* The first read makes sure the tables exist in this workspace. */
  const first = await page.request.get("/api/jobs?view=tray&sync=0", { headers });
  expect(first.ok(), await first.text()).toBeTruthy();
  const empty = await first.json() as TrayReply;
  /* A new workspace's starter production is demo takes nobody rendered: never listed as jobs. */
  expect(empty).toEqual({ jobs: [], pollAfterSeconds: 60 });

  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
  expect(tenantUrl).toMatch(/^file:/);
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const now = Date.now();
  const ENGINE = "dreamina-seedance-2-5-260628";
  try {
    await tenant.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", args: ["prod-tray", "Harbour launch spot", now] });
    await tenant.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,?,?)",
      args: [`${me.id}:${DRAFT}`, me.id, DRAFT, "Harbour launch spot", JSON.stringify({ id: DRAFT, name: "Harbour launch spot", productionProjectId: "prod-tray" }), 1, now] });
    const gen = (id: string, status: string, fields: { params?: object; createdBy?: string; createdAt?: number; updatedAt?: number; settledAt?: number | null; stored?: string | null; cost?: number | null; error?: string | null; deleted?: number; title?: string | null } = {}) =>
      tenant.execute({
        sql: "INSERT INTO generations(id,project_id,kind,model,prompt,title,params,status,created_by,created_at,updated_at,settled_at,stored_url,cost_usd,error,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [id, "prod-tray", "video", ENGINE, `Prompt for ${id}`, fields.title ?? null, JSON.stringify(fields.params ?? { resolution: "720p", ratio: "16:9", duration: 5 }), status,
          fields.createdBy ?? me.id, fields.createdAt ?? now - 5 * MIN, fields.updatedAt ?? now - MIN, fields.settledAt ?? null, fields.stored ?? null, fields.cost ?? null, fields.error ?? null, fields.deleted ?? 0],
      });
    await gen(`gen_t${tag}_queued`, "queued");
    await gen(`gen_t${tag}_running`, "running", { params: { resolution: "1080p", ratio: "16:9", duration: 5, inputSeconds: 5 } });
    await gen(`gen_t${tag}_held`, "held", { params: { resolution: "1080p", ratio: "16:9", duration: 5, held: { why: "credits", needs: 40, estUsd: 2.86, at: now } } });
    /* Held at a figure the terms have since moved from: far more than any local balance covers, so Release is refused and nothing starts. */
    await gen(`gen_t${tag}_held_big`, "held", { params: { resolution: "1080p", ratio: "16:9", duration: 5, held: { why: "credits", needs: 10, estUsd: 400, at: now } } });
    await gen(`gen_t${tag}_done`, "succeeded", { stored: "https://blob.invalid/x.mp4", cost: 1.16 });
    await gen(`gen_t${tag}_failed`, "failed", { error: "fal.ai returned 503 upstream", cost: 0 });
    await gen(`gen_t${tag}_failed_open`, "failed", { error: "The render never came back" });
    await gen(`gen_t${tag}_discarded`, "cancelled", { error: "Discarded before it started. Nothing was charged.", params: { held: { why: "credits" }, discardedAt: now - MIN } });
    /* Finished two days ago; approved and renamed today. Nothing rendered today, so it is not listed. */
    await gen(`gen_t${tag}_old`, "succeeded", { stored: "https://blob.invalid/y.mp4", cost: 1.16, createdAt: now - 2 * 24 * 3_600_000, updatedAt: now - 2 * 24 * 3_600_000, settledAt: now - 2 * 24 * 3_600_000 });
    /* Settled before settle times were kept: when is unknown, so it is not called recent. */
    await tenant.execute({ sql: `UPDATE generations SET settled_at=NULL WHERE id='gen_t${tag}_done'` });
    await gen(`gen_t${tag}_done_new`, "running");
    await gen(`gen_t${tag}_theirs`, "running", { createdBy: "someone-else" });
    await gen(`gen_t${tag}_deleted`, "running", { deleted: 1 });
    await gen(`gen_t${tag}_demo`, "succeeded", { stored: "https://blob.invalid/d.mp4", params: { demo: true, demoCostUsd: 1.2 } });
    await gen(`gen_hfc_${"b".repeat(40)}`, "succeeded", { stored: "https://blob.invalid/z.mp4" });

    /* The meter: what admission reserved for the running take (a video-input edit, which a fresh estimate gets wrong), and what the failed ones settled at. */
    const meter = (id: string, status: string, credits: number) => platform.execute({
      sql: `INSERT INTO meter_events(id,workspace_id,project_id,shot_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,duration_ms,created_by,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, account.workspace.id, "prod-tray", null, "video", "byteplus", ENGINE, status, credits ? 1.5 : 0, credits, 1, null, me.id, now - 5 * MIN, now - MIN],
    });
    await meter(`gen_t${tag}_running`, "running", 52);
    await meter(`gen_t${tag}_queued`, "running", 26);
    await meter(`gen_t${tag}_failed`, "failed", 0);
    await meter(`gen_t${tag}_done_new`, "running", 18);

    const consumer = (id: string, status: string, fields: { user?: string; claim?: boolean; manifest?: object | null; failure?: string | null; released?: number | null; updatedAt?: number; workflow?: string } = {}) =>
      tenant.execute({
        sql: `INSERT INTO higgsfield_consumer_jobs(id,user_id,draft_id,connected_owner_id,connection_generation,higgsfield_workspace_id,workflow,idempotency_key,payload_json,payload_hash,immutable_hash,
          quote_credits,quote_expires_at,original_asset_ids,status,provider_job_id,dispatch_claim_hash,result_manifest,provider_receipt,failure_code,created_at,updated_at,released_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, fields.user ?? me.id, DRAFT, fields.user ?? me.id, "g1", "w1", fields.workflow ?? "generation", `k-${id}`,
          JSON.stringify({ input: { type: "video", model: "seedance_2_0", prompt: `Account prompt ${id}`, parameters: { aspect_ratio: "9:16", duration: 5 }, medias: [] }, model: { id: "seedance_2_0", name: "Seedance 2.0", outputType: "video" }, workspaceName: "Fixture wallet", params: {} }),
          "h", "i", 40, now + MIN, "[]", status, fields.claim === false ? null : `p-${id}`, fields.claim === false ? null : "claim", fields.manifest ? JSON.stringify(fields.manifest) : null, null,
          fields.failure ?? null, now - 3 * MIN, fields.updatedAt ?? now - MIN, fields.released ?? null],
      });
    await consumer("c-accepted", "accepted");
    await consumer("c-quoted", "quoted", { claim: false });
    await consumer("c-done", "completed", { manifest: { original: { generationId: `gen_hfc_${"b".repeat(40)}`, kind: "video" } } });
    await consumer("c-failed", "failed", { failure: "provider_failed" });
    await consumer("c-set-aside", "uncertain", { released: now - MIN, updatedAt: now - 7 * 3_600_000 });
    await consumer("c-theirs", "accepted", { user: "someone-else" });
  } finally {
    tenant.close();
  }

  /* An old take approved and renamed today, through the real routes. */
  for (const body of [{ reviewState: "approved" }, { title: "Renamed today" }]) {
    const patched = await page.request.patch(`/api/jobs/gen_t${tag}_old`, { headers, data: body });
    expect(patched.ok(), await patched.text()).toBeTruthy();
  }
  /* The worker finishes a take: the status change stamps when. */
  const worker = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    await worker.execute({ sql: `UPDATE generations SET status='succeeded', stored_url='https://blob.invalid/n.mp4', updated_at=? WHERE id='gen_t${tag}_done_new'`, args: [Date.now()] });
  } finally { worker.close(); }
  await platform.execute({ sql: `UPDATE meter_events SET status='succeeded', billed_credits=17, updated_at=? WHERE id='gen_t${tag}_done_new'`, args: [Date.now()] });

  const response = await page.request.get("/api/jobs?view=tray&sync=0", { headers });
  expect(response.ok(), await response.text()).toBeTruthy();
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = await response.json() as TrayReply;
  const text = JSON.stringify(body);
  expect(body.pollAfterSeconds).toBe(10);
  expect(body.partial).toBeUndefined();
  const byId = new Map(body.jobs.map((j) => [j.id, j]));
  expect([...byId.keys()].sort()).toEqual(["c-accepted", "c-done", "c-failed", `gen_t${tag}_discarded`, `gen_t${tag}_done_new`, `gen_t${tag}_failed`, `gen_t${tag}_failed_open`, `gen_t${tag}_held`, `gen_t${tag}_held_big`, `gen_t${tag}_queued`, `gen_t${tag}_running`]);
  /* In flight: the figure admission reserved when it was approved, read off the meter — never estimated again. */
  expect(byId.get(`gen_t${tag}_running`)).toMatchObject({ stage: "rendering", price: { amount: 52, unit: "cr" }, settledAt: null });
  expect(byId.get(`gen_t${tag}_queued`)).toMatchObject({ stage: "queued", price: { amount: 26, unit: "cr" } });
  /* Just finished: stamped by its status change, priced at what the meter billed. */
  const fresh = byId.get(`gen_t${tag}_done_new`)!;
  expect(fresh).toMatchObject({ stage: "complete", action: "open", takeId: `generation:gen_t${tag}_done_new`, price: { amount: 17, unit: "cr" } });
  expect(Math.abs(fresh.settledAt! - Date.now())).toBeLessThan(60_000);
  /* Held: the figure its release is measured against, from the kept estimate at today's terms. */
  expect(byId.get(`gen_t${tag}_held`)).toMatchObject({ stage: "held", tone: "amber", action: "release", label: "Held · needs 43 cr", releaseCredits: 43, draftId: DRAFT });
  /* Failed: "not billed" only where the meter shows nothing charged; unmetered, nothing is claimed. */
  expect(byId.get(`gen_t${tag}_failed`)).toMatchObject({ stage: "failed", label: "Failed · not billed", price: null, action: "recreate", reason: "The engine hit an error" });
  expect(byId.get(`gen_t${tag}_failed`)!.preset).toMatchObject({ prompt: `Prompt for gen_t${tag}_failed`, billing: "workspace", from: { id: `gen_t${tag}_failed` } });
  expect(byId.get(`gen_t${tag}_failed_open`)).toMatchObject({ label: "Failed", price: null, reason: "The engine timed out" });
  expect(byId.get(`gen_t${tag}_discarded`)).toMatchObject({ stage: "cancelled", label: "Discarded", tone: "idle", reason: null });
  expect(byId.get("c-accepted")).toMatchObject({ source: "account", stage: "rendering", price: { amount: 40, unit: "account-cr" }, name: "Account prompt c-accepted", projectName: "Harbour launch spot" });
  expect(byId.get("c-done")).toMatchObject({ stage: "complete", takeId: `generation:gen_hfc_${"b".repeat(40)}`, mediaUrl: `/api/media/gen_hfc_${"b".repeat(40)}` });
  expect(byId.get("c-failed")).toMatchObject({ stage: "failed", label: "Failed", price: null, action: "recreate" });
  /* A failed connected Generate is made again on the account, with the words and settings it was sent with. */
  expect(byId.get("c-failed")!.preset).toMatchObject({ prompt: "Account prompt c-failed", model: "seedance_2_0", billing: "connected", picks: { ratio: "9:16", duration: 5 } });
  /* Held first, then the running ones, then what finished. */
  expect(body.jobs[0].stage).toBe("held");
  /* Never a vendor dollar, a payload, a receipt or the account's own name. */
  for (const secret of ["estUsd", "costUsd", "cost_usd", "engine_cost", "payload", "Receipt", "providerJobId", "Fixture wallet", "claim", "fal.ai", "demo"]) expect(text).not.toContain(secret);

  /* The list route's status filter takes a comma list. */
  const listed = await page.request.get("/api/jobs?status=queued,running,held&mine=1&sync=0", { headers }).then((r) => r.json()) as { generations: { id: string }[] };
  expect(listed.generations.map((g) => g.id).sort()).toEqual([`gen_t${tag}_held`, `gen_t${tag}_held_big`, `gen_t${tag}_queued`, `gen_t${tag}_running`]);
  const single = await page.request.get("/api/jobs?status=held&sync=0", { headers }).then((r) => r.json()) as { generations: { id: string }[] };
  expect(single.generations.map((g) => g.id).sort()).toEqual([`gen_t${tag}_held`, `gen_t${tag}_held_big`]);

  /* An older approval cannot start a repriced take; approving the current quote still cannot exceed the balance. */
  const big = byId.get(`gen_t${tag}_held_big`)!;
  expect(big.releaseCredits).toBeGreaterThan(1_000);
  expect(big.label).toBe(`Held · needs ${big.releaseCredits!.toLocaleString("en-US")} cr`);
  const stale = await page.request.post(`/api/jobs/gen_t${tag}_held_big/release`, { headers, data: { credits: 10 } });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ credits: big.releaseCredits });
  const refused = await page.request.post(`/api/jobs/gen_t${tag}_held_big/release`, { headers, data: { credits: big.releaseCredits } });
  expect(refused.status()).toBe(402);
  const answer = (await refused.json()) as { error: string; credits: number };
  expect(answer.error).toMatch(/^Still short: this needs [\d,]+ credits and [\d,]+ are left\.$/);
  expect(answer.credits).toBeGreaterThan(1_000);
  expect(Number(/needs ([\d,]+) credits/.exec(answer.error)![1].replace(/,/g, ""))).toBe(answer.credits);

  /* Every slot busy (someone else's renders fill them), and a held take the balance covers: nothing starts, and the
     answer is the slot, never a cap refusal left on the take by an earlier attempt. */
  const slots = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    for (const n of [1, 2, 3, 4]) await slots.execute({ sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      args: [`gen_t${tag}_slot_${n}`, "prod-tray", "video", ENGINE, "busy", "{}", "running", "someone-else", now, now] });
    /* Released by an earlier press whose reply was lost. */
    await slots.execute({ sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      args: [`gen_t${tag}_released`, "prod-tray", "video", ENGINE, "released", JSON.stringify({ releasedAt: now - MIN }), "queued", me.id, now - MIN, now - MIN] });
    await slots.execute({ sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,created_by,created_at,updated_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      args: [`gen_t${tag}_held_free`, "prod-tray", "video", ENGINE, "free", JSON.stringify({ held: { why: "credits", needs: 0, estUsd: 0, at: now } }), "held", me.id, now - 9 * MIN, now - 9 * MIN, "The production is over the cap."] });
  } finally { slots.close(); }
  const busy = await page.request.post(`/api/jobs/gen_t${tag}_held_free/release`, { headers, data: { credits: 0 } });
  expect(busy.status()).toBe(409);
  expect(((await busy.json()) as { error: string }).error).toBe("Every render slot is busy. It starts on its own when one is free.");
  /* Pressed again after a lost reply: answered "already", and nothing more is charged. */
  const again = await page.request.post(`/api/jobs/gen_t${tag}_released/release`, { headers, data: { credits: 43 } });
  expect(again.status()).toBe(200);
  expect(await again.json()).toEqual({ released: true, id: `gen_t${tag}_released`, already: true });
  const still = await page.request.get("/api/jobs?status=held&sync=0", { headers }).then((r) => r.json()) as { generations: { id: string }[] };
  expect(still.generations.map((g) => g.id)).toContain(`gen_t${tag}_held_free`);
  platform.close();

  /* Another workspace sees none of it. */
  await signInLocally(page.request);
  const other = await page.request.get("/api/jobs?view=tray&sync=0").then((r) => r.json()) as TrayReply;
  expect(other.jobs).toEqual([]);
  expect(await page.request.get("/api/jobs?view=elsewhere&sync=0").then((r) => r.status())).toBe(400);
});

test("own-key failed jobs keep unknown charges distinct from a recorded zero", async ({ page }) => {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json()) as { id: string };
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const initial = await page.request.get("/api/jobs?view=tray&sync=0", { headers });
  expect(initial.ok(), await initial.text()).toBe(true);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
    await platform.execute({ sql: "UPDATE workspaces SET uses_platform_keys=0 WHERE id=?", args: [account.workspace.id] });
  } finally { platform.close(); }
  expect(tenantUrl).toMatch(/^file:/);
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  const tag = randomBytes(6).toString("hex");
  const now = Date.now();
  try {
    for (const [suffix, status, cost] of [["unknown", "failed", null], ["zero", "failed", 0], ["cancelled", "cancelled", null]] as const) {
      await tenant.execute({
        sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_by,created_at,updated_at,settled_at,cost_usd,error) VALUES(?,'video',?,?,'{}',?,?,?,?,?,?,?)",
        args: [`gen_${tag}_${suffix}`, "dreamina-seedance-2-5-260628", "A quiet harbour", status, me.id, now, now, now, cost, "The engine stopped."],
      });
    }
    /* A separate zero-cost refinement cannot prove the missing render charge was zero. */
    await tenant.execute({ sql: "UPDATE generations SET refine_cost_usd=0 WHERE id=?", args: [`gen_${tag}_unknown`] });
    const response = await page.request.get("/api/jobs?view=tray&sync=0", { headers });
    expect(response.ok(), await response.text()).toBe(true);
    const body = await response.json() as TrayReply;
    const rows = new Map(body.jobs.map((job) => [job.id, job]));
    expect(rows.get(`gen_${tag}_unknown`)).toMatchObject({ label: "Failed", price: null });
    expect(rows.get(`gen_${tag}_zero`)).toMatchObject({ label: "Failed · not billed", price: null });
    expect(rows.get(`gen_${tag}_cancelled`)).toMatchObject({ label: "Cancelled", price: null });
    const stored = await tenant.execute({ sql: "SELECT cost_usd FROM generations WHERE id=?", args: [`gen_${tag}_unknown`] });
    expect(stored.rows[0].cost_usd).toBeNull();
  } finally { tenant.close(); }
});
