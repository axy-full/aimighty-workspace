import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type CanvasNode, type Project } from "../lib/workbench/studio";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import type { SoulIdentity } from "../lib/workbench/soul-identity";
import { DESKTOP, PHONE, generation, mockMedia, upload } from "./helpers/workspaceFixtures";

/**
 * The phone's six page templates and Edit & Sound's own layout (wave M-B,
 * 05-mobile "Page templates").
 *
 * What it proves: each template renders from seeded data at all three phone
 * viewports, the shot list opens the Inspector sheet, the Form blocks on a stale
 * quote WITHOUT a single paid request, the accordion opens one section at a time,
 * and the three floors hold on every page — nothing under 12px, no target under
 * 44×44, and the last row of every scroller clearing the pinned block. At 1440
 * and 1920 the desktop pages are unchanged.
 */

const SHOTS = "/private/tmp/mobile-pages-shots";
const PROJECT = "ws-mb";
const PRODUCTION = "prod-mb";

/* ── Seeded data. Test fixtures only; the app reads them from the real routes. ─ */

const image = (id: string, name: string, category: string, extra: Partial<Asset> = {}): Asset => ({
  id, name, kind: "image", category, url: `/api/uploads/${id}`, uploadId: id, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra,
});
const ref = (id: string, title: string, type: CanvasNode["type"], assetId: string): CanvasNode =>
  ({ id, title, type, assetId, role: "", x: 0, y: 0, width: 240, linked: [] });
const shot = (id: string, title: string, text: string, linked: string[], extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title, type: "scene", text, x: 0, y: 0, width: 300, linked, ...extra });

function fixture(): Project {
  return {
    ...newProject("Coastal light study"),
    id: PROJECT,
    description: "Product film · Spot 02",
    productionProjectId: PRODUCTION,
    shotMappings: {},
    aspect: "16:9",
    fps: 24,
    moleculr: { ...EMPTY_MOLECULR, productName: "Daily serum", productUrl: "https://example.test/serum", productAssetIds: ["up_bottle"], hooks: ["Quiet mornings"] },
    assets: [
      image("up_lead", "Lead", "Character", { soulIdentityId: "id_lead", version: 2 }),
      image("up_sphere", "Chrome sphere", "Element", { description: "chrome" }),
      image("up_plate", "Harbour plate", "Environment", { description: "warm daylight" }),
      image("up_bottle", "Bottle", "Element", { description: "product" }),
    ],
    nodes: [
      ref("n-look", "Look board", "moodboard", "up_plate"),
      ref("n-lead", "Lead", "character", "up_lead"),
      ref("n-sphere", "Chrome sphere", "element", "up_sphere"),
      shot("s1", "The approach", "Wide. The water holds still.", ["n-look"], { status: "approved" }),
      shot("s2", "The encounter", "The lead enters frame.", ["n-look", "n-lead", "n-sphere"]),
      shot("s3", "Mirror fold", "The sphere takes the frame.", ["n-sphere"]),
    ],
  };
}

const identity: SoulIdentity = {
  id: "id_lead", name: "Lead", projectId: PROJECT, description: "", subjectType: "character", status: "ready",
  previewUrl: null, references: [], createdAt: 1, updatedAt: 1, creditsBilled: null, error: null,
};

const CLIP = upload({ id: "up_clip", filename: "wind-test.mp4", mime: "video/mp4", kind: "video", durationS: 12, bytes: 4_000_000 });
const STILL = upload({ id: "up_still", filename: "plate.webp" });
const RENDER = generation({ id: "gen_one", kind: "video", model: "seedance-2-5", creditsBilled: 18, durationS: 5, reviewState: "", shotId: "shot_s1" });

/** The stale quote the Form must refuse: this exact composition, aged out. */
const STALE_INPUT = { variant: "motion-transfer", resolution: "720p", prompt: "", source: { uploadId: CLIP.id }, references: [] };
const staleJob = () => ({
  id: "00000000-0000-4000-8000-000000000001",
  draftId: PROJECT,
  status: "quoted",
  input: STALE_INPUT,
  workspaceId: "w1",
  workspaceName: "Workspace",
  quoteCredits: 142,
  creditUnit: "higgsfield_credits",
  quoteExpiresAt: Date.now() - 60_000,
  providerJobId: null,
  createdAt: Date.now() - 120_000,
});

type State = { paid: string[]; project: Project; revision: number };

async function open(page: Page): Promise<State> {
  const state: State = { paid: [], project: fixture(), revision: 1 };
  await signInLocally(page.request);
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });

    if (path === "/api/workbench/projects") {
      if (method === "PUT") {
        const body = request.postDataJSON() as { project: Project; revision: number };
        if (body.revision !== state.revision) return json({ error: "This project changed in another window." }, 409);
        state.revision++;
        state.project = { ...body.project, productionProjectId: PRODUCTION, shotMappings: state.project.shotMappings ?? {} };
        return json({ revision: state.revision, productionProjectId: PRODUCTION, shotMappings: state.project.shotMappings });
      }
      if (method === "POST") {
        const body = request.postDataJSON() as { action?: string; nodeId?: string };
        if (body.action === "map-shot") return json({ productionProjectId: PRODUCTION, shotId: `shot_${String(body.nodeId)}` });
        state.paid.push(`POST ${path} ${String(body.action)}`);
        return json({ error: "Only map-shot is permitted in this test." }, 409);
      }
      const id = url.searchParams.get("id");
      return json({
        project: !id || id === PROJECT ? state.project : null,
        projects: [{ id: PROJECT, name: state.project.name, revision: state.revision, updatedAt: "2026-09-18T10:00:00Z" }],
        productions: [],
        revision: state.revision,
        shared: null,
      });
    }
    if (path === "/api/workbench/library") {
      if (method === "GET") {
        const source = url.searchParams.get("source");
        return json(source === "uploads" ? { uploads: [CLIP, STILL], nextCursor: null } : { generations: [RENDER], nextPageCursor: null });
      }
      state.paid.push(`${method} ${path}`);
      return json({ error: "No upload is permitted in this test." }, 409);
    }
    /* The live shot quote every Generate button prints. */
    if (path === "/api/workbench/engines") return json({ credits: 18, models: [] });
    if (path === "/api/soul/identities" && method === "GET")
      return json({ identities: [identity], terms: { minPhotos: 4, trainingCredits: 54 }, configured: true });
    if (path === "/api/higgsfield/consumer/genjutsu") {
      if (method !== "GET") {
        /* A paid transform must never be reachable from this screen. */
        state.paid.push(`${method} ${path} ${String(request.postDataJSON()?.action)}`);
        return json({ error: "No transform dispatch is permitted in this test." }, 409);
      }
      return json({ jobs: [staleJob()], connection: { connected: true, requiresReconnect: false } });
    }
    /* The shot and node thumbs read the workbench's own preview route. */
    if (path.startsWith("/api/workbench/preview/"))
      return route.fulfill({ body: readFileSync("public/campaign/environment.webp"), contentType: "image/webp" });
    if (path === "/api/me") return json({ id: "u1", owner: true, workspace: { id: "w1", suspended: false } });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/projects") return json({ projects: [{ id: PRODUCTION, credits: 96, capCredits: 500 }] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (method !== "GET") {
      state.paid.push(`${method} ${path}`);
      return json({ error: "No dispatch is permitted in this test." }, 409);
    }
    return json({});
  });
  /* Registered last, so stored media wins over the catch-all: Playwright runs
     the most recent matching handler first. */
  await mockMedia(page);
  return state;
}

const goTo = (page: Page, id: string, suite = "particl") => page.goto(`/workspace?project=${PROJECT}&suite=${suite}&page=${id}`);

/* ── The floors ──────────────────────────────────────────────────────────── */

/** Every visible text node, with its computed size: the 12px floor. */
async function smallText(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || !el.getClientRects().length) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size}px: “${text.slice(0, 40)}” (${el.className || el.tagName})`);
    }
    return out;
  });
}

/**
 * Every visible button on the screen is at least 44×44 — except a segmented
 * option, which 05-mobile allows at 40px inside its 44px control.
 */
async function smallTargets(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-screen="page"] button, [data-testid="mobile-actions"] button, [data-testid="mobile-dock"] button'))) {
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      const floor = el.classList.contains("pxm-seg") ? 40 : 44;
      if (rect.width < 44 || rect.height < floor) out.push(`${el.className}: ${Math.round(rect.width)}×${Math.round(rect.height)}`);
    }
    return out;
  });
}

/** At max scroll the last row is fully visible above whatever is pinned below. */
async function lastRowClearsPinned(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="mobile-scroll"]')!;
    scroller.scrollTop = scroller.scrollHeight;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>("button, p, div[data-door], div[data-stem], div[data-node-id]")).filter((el) => el.getClientRects().length);
    const last = rows[rows.length - 1];
    const problems: string[] = [];
    const box = scroller.getBoundingClientRect();
    for (const sel of ['[data-testid="mobile-actions"]', '[data-testid="mobile-dock"]']) {
      const block = document.querySelector<HTMLElement>(sel);
      if (block && box.bottom > block.getBoundingClientRect().top + 1) problems.push(`scroller (${box.bottom}) runs under ${sel}`);
    }
    if (last && last.getBoundingClientRect().bottom > box.bottom + 1)
      problems.push(`last row ends at ${last.getBoundingClientRect().bottom}, scroller ends at ${box.bottom}`);
    return problems;
  });
}

/**
 * No functional label is dimmer than #7C7C84 (the brief's floor). Kickers,
 * counts, mono values and lead chips all carry `data-functional-label`.
 */
async function dimLabels(page: Page) {
  return page.evaluate(() => {
    const luminance = (color: string) => {
      const [r, g, b] = (color.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    /* #7C7C84 itself, computed the same way, is the floor. */
    const floor = 0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-screen="page"] [data-functional-label]'))) {
      if (!el.getClientRects().length) continue;
      const style = getComputedStyle(el);
      /* A badge that carries its own background (the white shot number, the
         kind chip over media) owns its own contrast; the floor is about labels
         on the ground. */
      if (!/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(style.backgroundColor)) continue;
      const color = style.color;
      if (luminance(color) < floor) out.push(`${el.className || el.tagName}: ${color} — “${(el.textContent ?? "").trim().slice(0, 24)}”`);
    }
    return out;
  });
}

async function floors(page: Page, where: string) {
  expect(await smallText(page), `${where}: text under 12px`).toEqual([]);
  expect(await smallTargets(page), `${where}: targets under 44×44`).toEqual([]);
  expect(await dimLabels(page), `${where}: functional labels under #7C7C84`).toEqual([]);
  expect(await lastRowClearsPinned(page), `${where}: clearance at max scroll`).toEqual([]);
}

/* ── The templates ───────────────────────────────────────────────────────── */

test("the shot list and the flow: the same shots, and the Inspector sheet", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await open(page);
  const capture = info.project.name === "workbench-390x844";

  await goTo(page, "rig");
  await expect(page.getByTestId("mobile-shot-list")).toBeVisible();
  const rows = page.locator(".pxm-shot-row");
  await expect(rows).toHaveCount(3);
  /* The row carries the number, the name, the note, the chip and the mono line. */
  await expect(rows.first().locator(".pxm-shot-num")).toHaveText("01");
  await expect(rows.first().locator(".pxm-shot-name")).toHaveText("The approach");
  await expect(rows.first().locator(".pxm-shot-note")).toHaveText("Wide. The water holds still.");
  await expect(rows.first().locator(".pxm-status-chip-label")).toHaveText("Approved");
  await expect(rows.first().locator(".pxm-shot-meta")).toContainText("·");
  /* The derived sub is the desktop's: counted, never stored. */
  await expect(page.getByTestId("mobile-page-title")).toHaveText("Rig");
  await expect(page.locator(".pxm-page-sub")).toHaveText("3 shots · 1 approved");
  await floors(page, "shot list");
  if (capture) await page.screenshot({ path: `${SHOTS}/shot-list-390x844.png`, animations: "disabled" });

  /* Tapping a shot selects it and opens the Inspector sheet. */
  await rows.nth(1).click();
  await expect(page.getByTestId("mobile-sheet")).toBeVisible();
  await expect(page.locator(".pxm-sheet-title")).toHaveText("Inspector");
  await expect(page).toHaveURL(/sel=shot%3As2|sel=shot:s2/);
  await page.locator(".pxm-sheet-close").click();
  await expect(page.getByTestId("mobile-sheet")).toHaveCount(0);

  /* The flow is Rig's second tab, and the same graph: blue in, grey after. */
  await page.locator('[data-testid="mobile-page-views"] [data-view="graph"]').click();
  await expect(page.getByTestId("mobile-flow")).toBeVisible();
  await expect(page.locator(".pxm-flow-step")).toHaveCount(6);
  await expect(page.locator('.pxm-flow-step[data-scene]')).toHaveCount(1);
  await expect(page.locator('.pxm-flow-step[data-scene]')).toHaveAttribute("data-node-id", "s2");
  const wires = await page.locator(".pxm-flow-wire").evaluateAll((els) => els.map((el) => el.getAttribute("data-wire")));
  expect(wires.slice(0, 3)).toEqual(["blue", "blue", "blue"]);
  expect(wires.slice(3)).toEqual(["grey", "grey"]);
  /* 15px pins, and the scene's own ring — the only loader on the phone. */
  const pin = await page.locator(".pxm-flow-pin").first().boundingBox();
  expect(Math.round(pin!.width)).toBe(15);
  await expect(page.locator('.pxm-flow-step[data-scene] .pxm-ring')).toHaveCount(1);
  await floors(page, "flow");
  if (capture) await page.screenshot({ path: `${SHOTS}/flow-390x844.png`, animations: "disabled" });

  expect(state.paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("cards: Cast & Elements and Takes, 2-up from the real project", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await open(page);
  const capture = info.project.name === "workbench-390x844";

  await goTo(page, "cast");
  await expect(page.getByTestId("mobile-cards")).toBeVisible();
  /* One cast card and three element cards, from the draft's own categories. */
  await expect(page.locator('[data-cast-id]')).toHaveCount(4);
  await expect(page.locator('[data-cast-id="up_lead"] .pxm-tile-name')).toHaveText("Lead");
  await expect(page.locator('[data-cast-id="up_lead"] .pxm-tile-tag-label')).toHaveText("Identity locked");
  await expect(page.locator('[data-cast-id="up_lead"] .pxm-tile-badge')).toHaveText("IDENTITY");
  await expect(page.locator(".pxm-page-sub")).toHaveText("1 cast · 3 elements");
  await floors(page, "cast cards");
  if (capture) await page.screenshot({ path: `${SHOTS}/cards-cast-390x844.png`, animations: "disabled" });
  /* A card opens the Inspector sheet, as every phone detail does. */
  await page.locator('[data-cast-id="up_lead"]').click();
  await expect(page.getByTestId("mobile-sheet")).toBeVisible();
  await page.getByTestId("mobile-sheet-scrim").click({ position: { x: 20, y: 10 } });

  await goTo(page, "takes");
  await expect(page.getByTestId("mobile-take-grid")).toBeVisible();
  await expect(page.locator("[data-take-id]")).toHaveCount(3);
  /* The settled figure is the ledger's, through the desktop page's own formula. */
  await expect(page.locator('[data-kind="GEN"] [data-testid="mobile-take-cost"]').first()).toHaveText("18 cr");
  await expect(page.locator('[data-kind="UPLOAD"] [data-testid="mobile-take-cost"]').first()).toHaveText("—");
  await expect(page.locator(".pxm-page-sub")).toHaveText("3 assets · 18 cr settled");
  /* The filter is the desktop's segmented control, on the same state. */
  await page.locator('[data-testid="mobile-page-views"] [data-view="Uploads"]').click();
  await expect(page.locator("[data-take-id]")).toHaveCount(2);
  await floors(page, "takes cards");
  expect(state.paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("rows: the same groups, cards and states the desktop spec page shows", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await open(page);
  const capture = info.project.name === "workbench-390x844";

  await goTo(page, "brief");
  await expect(page.getByTestId("mobile-rows")).toBeVisible();
  const groups = page.locator('[data-testid="mobile-rows"] section');
  await expect(groups).toHaveCount(2);
  await expect(groups.first().locator(".pxm-kicker")).toHaveText("DOCUMENT");
  const rows = page.locator(".pxm-spec-row");
  await expect(rows).toHaveCount(7);
  /* A 36px mono lead chip, a name, a sub and a right-aligned value. */
  const lead = await rows.first().locator(".pxm-lead").boundingBox();
  expect([Math.round(lead!.width), Math.round(lead!.height)]).toEqual([36, 36]);
  await expect(rows.first().locator(".pxm-spec-name")).not.toHaveText("");
  await expect(rows.first().locator(".pxm-spec-value")).not.toHaveText("");
  await floors(page, "rows");
  if (capture) await page.screenshot({ path: `${SHOTS}/rows-brief-390x844.png`, animations: "disabled" });

  /* Every rows page in every suite renders from its own spec config. */
  for (const [suite, id, count] of [["particl", "deliver", 5], ["atomik", "budget", 4], ["subatomik", "sources", 4]] as const) {
    await goTo(page, id, suite);
    await expect(page.getByTestId("mobile-rows")).toBeVisible();
    await expect(page.locator(".pxm-spec-row")).toHaveCount(count);
  }
  expect(state.paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("the accordion opens one section at a time", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await open(page);
  const capture = info.project.name === "workbench-390x844";

  await goTo(page, "marketing", "moleculr");
  await expect(page.getByTestId("mobile-accordion")).toBeVisible();
  const sections = page.locator(".pxm-acc");
  await expect(sections).toHaveCount(7);
  /* The first opens on arrival; exactly one body is ever visible. */
  await expect(page.locator(".pxm-acc-body:visible")).toHaveCount(1);
  await expect(page.locator('[data-section="product"]')).toHaveAttribute("data-open", "");
  /* Its rows are the brief's own values, and an empty field is a dash. */
  await expect(page.locator('[data-section="product"] .pxm-acc-row-value').first()).toHaveText("saved");
  if (capture) await page.screenshot({ path: `${SHOTS}/accordion-390x844.png`, animations: "disabled" });

  await page.locator('[data-section="brand"] .pxm-acc-head').click();
  await expect(page.locator(".pxm-acc-body:visible")).toHaveCount(1);
  await expect(page.locator('[data-section="brand"]')).toHaveAttribute("data-open", "");
  await expect(page.locator('[data-section="product"]')).not.toHaveAttribute("data-open", "");
  /* Tapping the open one closes it: none open is a state too. */
  await page.locator('[data-section="brand"] .pxm-acc-head').click();
  await expect(page.locator(".pxm-acc-body:visible")).toHaveCount(0);
  await floors(page, "accordion");
  expect(state.paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("the form blocks on a stale quote, and sends nothing", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await open(page);
  const capture = info.project.name === "workbench-390x844";

  await goTo(page, "motion", "subatomik");
  await expect(page.getByTestId("mobile-form")).toBeVisible();
  /* Nothing chosen yet: the quote is missing and the primary says so. */
  await expect(page.getByTestId("mobile-form-quote-figure")).toHaveText("—");
  await expect(page.getByTestId("mobile-primary")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("mobile-form-blocked")).toContainText("source video");

  /* Choose the project's own source video: now a quote exists for exactly this
     composition — and it has aged out, so it still blocks and prints no figure. */
  await page.getByTestId("mobile-form-source").click();
  await page.locator(`[data-pick="upload:${CLIP.id}"]`).click();
  await expect(page.getByTestId("mobile-form-source")).toContainText("wind-test.mp4");
  await expect(page.getByTestId("mobile-form-quote")).toHaveAttribute("data-quote", "expired");
  await expect(page.getByTestId("mobile-form-quote-figure")).toHaveText("—");
  await expect(page.getByTestId("mobile-form-blocked")).toContainText("aged out");
  await expect(page.getByTestId("mobile-primary")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("mobile-primary")).not.toContainText("142");

  /* The reference strip keeps its order, and the resolution is the form's. */
  await page.getByTestId("mobile-form-add-ref").click();
  await page.locator(`[data-pick="upload:${STILL.id}"]`).click();
  await expect(page.locator(".pxm-ref-index")).toHaveText(["01"]);
  await page.getByTestId("mobile-form-prompt").fill("Hold the camera move exactly as filmed.");
  await page.locator('[data-res="1080p"]').click();
  await expect(page.locator('[data-res="1080p"]')).toHaveAttribute("aria-pressed", "true");
  /* The composition changed, so the old estimate no longer applies at all. */
  await expect(page.getByTestId("mobile-form-quote")).toHaveAttribute("data-quote", "changed");
  await floors(page, "form");
  if (capture) await page.screenshot({ path: `${SHOTS}/form-motion-390x844.png`, animations: "disabled" });

  /* Pressing the blocked primary says why and dispatches nothing. It is
     aria-disabled, not disabled, so a thumb still reaches it — and gets the
     reason rather than silence. `force` is what that tap is. */
  await page.getByTestId("mobile-primary").click({ force: true });
  await expect(page.locator(".pxw-toast")).toContainText(/estimate/i);
  expect(state.paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("Edit & Sound: the assembly, three lanes, five doors and the versions", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const state = await open(page);

  await goTo(page, "edit");
  await expect(page.getByTestId("mobile-edit")).toBeVisible();
  await expect(page.getByTestId("mobile-assembly")).toContainText("Assembly · 00:00");
  /* Three lanes, because the edit has three; ambience is a bed on the effects lane. */
  await expect(page.locator("[data-stem]")).toHaveCount(3);
  await expect(page.locator("[data-stem]").nth(0)).toHaveAttribute("data-stem", "dialogue");
  await expect(page.locator("[data-stem]").nth(1)).toHaveAttribute("data-stem", "sfx");
  await expect(page.locator("[data-stem]").nth(2)).toHaveAttribute("data-stem", "music");
  await expect(page.getByTestId("mobile-edit")).toContainText("Ambience has no lane of its own");
  /* Five doors: the three generators plus the two tools on a stored original. */
  await expect(page.locator("[data-door]")).toHaveCount(5);
  await expect(page.locator(".pxm-versions .pxm-version-row")).toHaveCount(3);
  await floors(page, "edit");
  expect(state.paid).toEqual([]);
  expect(errors).toEqual([]);
});

/* ── The desktop is untouched ────────────────────────────────────────────── */

test("above the breakpoint the desktop pages are unchanged", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);

  await goTo(page, "rig");
  await expect(page.getByTestId("rig-list")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(page.locator(".pxw-rig-row")).toHaveCount(3);
  /* Nothing of the phone exists here. */
  await expect(page.getByTestId("phone-shell")).toHaveCount(0);
  await expect(page.getByTestId("mobile-dock")).toHaveCount(0);
  await expect(page.getByTestId("mobile-shot-list")).toHaveCount(0);

  await goTo(page, "brief");
  await expect(page.getByTestId("spec-page")).toBeVisible();
  await expect(page.locator(".pxw-spec-card")).toHaveCount(7);
  await expect(page.getByTestId("mobile-rows")).toHaveCount(0);

  await goTo(page, "marketing", "moleculr");
  await expect(page.getByTestId("spec-page")).toBeVisible();
  await expect(page.getByTestId("mobile-accordion")).toHaveCount(0);

  await goTo(page, "edit");
  await expect(page.getByTestId("assembly")).toBeVisible();
  await expect(page.getByTestId("mobile-edit")).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
