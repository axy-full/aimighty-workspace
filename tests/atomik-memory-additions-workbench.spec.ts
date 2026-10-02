import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
/* Grants in today's credits, saying so (unit_usd): the runner and the mock server share the default. */
import { creditUsd } from "../lib/creditTerms";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * Atomik › Memory after the owner's answers (29 Sep), on a local
 * ENGINE_MOCK=1 server with the real memory routes, a real workspace database
 * and the mock model:
 *  - only amounts are refused: a descriptive price-point note is kept, an
 *    amount is refused with the new copy;
 *  - an approved identity picked from Cast & Elements, a Soul ID included,
 *    kept by reference;
 *  - lines picked from the Business brand kit, each an ordinary entry;
 *  - Atomik reading a paste: priced first, approved at that price, its
 *    proposals reviewed, two kept — nothing kept before the ticks;
 *  - the whole page on a phone.
 * Every size checks: no sideways scroll, no serif, labels at the #7C7C84
 * floor, 44 px phone targets, and the last content above the tab bar.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const MEMORY = "/suites?suite=atomik&page=agent&sp=memory";
const DRAFT = "ws-memory-2";
/* Review screenshots only when MEMORY_SHOTS names a folder; CI takes none. */
const SHOTS = process.env.MEMORY_SHOTS;

type Entry = { id: string; kind: string; text: string; status: string; source: string; origin: string | null; scope: string; assetId: string | null; assetLabel: string | null; assetKind: string | null; available: boolean };
type Setup = { workspaceId: string; userId: string; headers: Record<string, string>; productionId: string; errors: string[]; paid: string[]; reads: { quote: boolean; body: Record<string, unknown>; key: string | null }[] };

const CAST = [
  { id: "cast-maya", name: "Maya", kind: "character" as const, description: "", prompt: "", takes: [] },
  { id: "cast-board", name: "The red board", kind: "element" as const, description: "", prompt: "", takes: [] },
];
const MOLECULR = {
  productName: "", productUrl: "", productAssetIds: [], castAssetIds: [], format: "poster" as const, hooks: [], notes: "", variants: [],
  brandKit: { name: "Driftline", tagline: "Ride the light", voice: "Warm, dry humour. Never salesy.", audience: "Skaters, 16 to 24, in coastal towns.",
    colors: ["#0FA3A3", "#E8D9B5"], font: "system" as const, description: "A skate brand from the coast. Boards from $120. Hand-shaped in Goa.", fontFamilies: ["Inter"] },
  products: [
    { id: "p-wave", name: "Wave Runner", url: "", description: "Breathable knit upper. Retails at $120.", brand: "Driftline", assetIds: [] },
    { id: "p-card", name: "Gift card", url: "", description: "$50.", brand: "", assetIds: [] },
  ],
};

/** The workspace's own database, for what the routes read on the server: a person's draft and a trained Soul ID. */
async function tenant<T>(workspaceId: string, work: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let url: string;
  try { url = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [workspaceId] })).rows[0].db_url); }
  finally { platform.close(); }
  const db = createClient({ url, timeout: 10_000 });
  try { return await work(db); } finally { db.close(); }
}

async function setup(page: Page, opts: { credits?: number; soul?: boolean } = {}): Promise<Setup> {
  const { workspace } = await signInLocally(page.request);
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const headers = { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` };
  const made = await page.request.post("/api/projects", { data: { name: "Coastal light study" } });
  expect(made.ok(), await made.text()).toBe(true);
  const productionId = ((await made.json()) as { id: string }).id;
  const project = { ...newProject("Coastal light study"), id: DRAFT, productionProjectId: productionId, shotMappings: {}, production: { cast: { entries: CAST } }, moleculr: MOLECULR } as unknown as Project;
  /* The identities route makes its table on first read; the draft is this person's, as the Cast & Elements page saves it. */
  expect((await page.request.get(`/api/soul/identities?projectId=${DRAFT}`, { headers })).ok()).toBe(true);
  await tenant(workspace.id, async (db) => {
    await db.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)", args: [`${me.id}:${DRAFT}`, me.id, DRAFT, project.name, JSON.stringify(project), Date.now()] });
    if (opts.soul) await db.execute({
      sql: `INSERT INTO soul_identities(id,owner,production_project_id,name,description,subject_type,references_json,status,credential_fingerprint,settled_at,created_at,updated_at,consent_at,provider_origin,model_version)
            VALUES(?,?,?,?,'','character','[]','ready','fp',1,1,1,1,'api-v1','v1')`,
      args: [`soul_${randomUUID().slice(0, 8)}`, me.id, productionId, "Maya on the key"],
    });
  });
  if (opts.credits) {
    const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try { await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at,unit_usd) VALUES(?,?,?,?,?,?,?,?)", args: [randomUUID(), workspace.id, opts.credits, "Local mock Memory read", "admin", "test", Date.now(), creditUsd()] }); }
    finally { platform.close(); }
  }
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: project });
  await mockLibrary(page, { uploads: [], generations: [] });
  const paid: string[] = [];
  await page.route("**/api/workbench/atomik**", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: false, models: [], jobs: [] } });
    paid.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 409, json: { error: "No agent request is allowed in this test." } });
  });
  const reads: Setup["reads"] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if (path === "/api/atomik/memory/read") {
      const body = request.postDataJSON() as Record<string, unknown>;
      reads.push({ quote: body.quoteOnly === true, body, key: request.headers()["idempotency-key"] ?? null });
      return;
    }
    if (/^\/api\/(generate|audio|atomik\/(?!memory)|workbench\/atomik)/.test(path)) paid.push(`POST ${path}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /same key|unique "key"|Maximum update depth|Cannot update a component|hydrat/i.test(message.text())) errors.push(message.text().slice(0, 300));
  });
  return { workspaceId: workspace.id, userId: me.id, headers, productionId, errors, paid, reads };
}

async function entries(page: Page, s: Setup): Promise<Entry[]> {
  const reply = await page.request.get(`/api/atomik/memory?projectId=${encodeURIComponent(s.productionId)}`, { headers: s.headers });
  expect(reply.ok(), await reply.text()).toBe(true);
  return ((await reply.json()) as { entries: Entry[] }).entries;
}

/** No sideways scroll; nothing off either edge; no serif; on a phone every target 44px; labels never dimmer than #7C7C84. */
async function floors(page: Page, root: string, phone: boolean) {
  const problems = await page.evaluate(({ root, phone }) => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`document scrolls sideways: ${document.documentElement.scrollWidth} > ${innerWidth}`);
    const scope = document.querySelector<HTMLElement>(root);
    if (!scope) return [`no ${root}`];
    const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("details:not([open]) > :not(summary)"); };
    const name = (el: HTMLElement) => el.dataset.testid || el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 30) || el.className || el.tagName;
    for (const el of [scope, ...Array.from(scope.querySelectorAll<HTMLElement>("*"))]) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > innerWidth + 1 || r.left < -1) out.push(`${name(el)} runs off the viewport (${Math.round(r.left)}–${Math.round(r.right)})`);
      if (/(^|[^-])\bserif\b/i.test(getComputedStyle(el).fontFamily)) out.push(`serif face on ${name(el)}`);
    }
    if (phone) {
      for (const el of Array.from(scope.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, summary"))) {
        if (!shown(el)) continue;
        /* A checkbox, a radio or a file input's target is its label; a segmented option may be 40px inside its 44px track. */
        const label = el.tagName === "INPUT" ? el.closest("label") : null;
        const box = (label ?? el).getBoundingClientRect();
        const track = el.classList.contains("gx-seg-btn") ? el.closest(".gx-seg") : null;
        const floor = track && track.getBoundingClientRect().height >= 43.5 ? 40 : 44;
        if (box.height < floor - 0.5 || box.width < 44 - 0.5) out.push(`${name(el)} is ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
    }
    const lum = (r: number, g: number, b: number) => [r, g, b].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
    const floor = lum(0x7c, 0x7c, 0x84);
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>(".tc-intro, .tc-note, .tc-summary, .tc-pill, .am-meta, .am-label, .am-confirm, .gx-empty, .gx-eyebrow, p, label, em, span"))) {
      if (!shown(el) || !el.textContent?.trim()) continue;
      const m = getComputedStyle(el).color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m) continue;
      const a = m[4] == null ? 1 : Number(m[4]);
      /* Measured over the darkest ground the page uses; a tinted panel only lightens it. */
      const over = (c: number, bg: number) => c * a + bg * (1 - a);
      if (lum(over(+m[1], 13), over(+m[2], 13), over(+m[3], 16)) + 1e-6 < floor) out.push(`${name(el)}: ${getComputedStyle(el).color} is dimmer than #7C7C84`);
    }
    return out;
  }, { root, phone });
  expect(problems).toEqual([]);
}

/** On a phone, the page's last content ends above the floating tab bar when scrolled to the end. */
async function clearOfTabBar(page: Page, root: string) {
  const bar = page.getByTestId("tabbar");
  if (!(await bar.isVisible())) return;
  const gap = await page.evaluate((root) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="content"]')!;
    scroller.scrollTop = scroller.scrollHeight;
    const view = document.querySelector<HTMLElement>(root)!;
    const shown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const leaves = Array.from(view.querySelectorAll<HTMLElement>("*")).filter((el) => shown(el) && !Array.from(el.children).some(shown));
    const bottom = Math.max(...leaves.map((el) => el.getBoundingClientRect().bottom));
    return document.querySelector('[data-testid="tabbar"]')!.getBoundingClientRect().top - bottom;
  }, root);
  expect(gap, "the last content ends above the tab bar").toBeGreaterThanOrEqual(0);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = `${page.viewportSize()!.width}x${page.viewportSize()!.height}`;
  await page.screenshot({ path: `${SHOTS}/${name}-${size}.png`, fullPage: false });
}

async function openMemory(page: Page) {
  await page.goto(MEMORY);
  await expect(page.getByTestId("page-title")).toHaveText("Memory");
  const view = page.getByTestId("memory-view");
  await expect(view.getByTestId("memory-workspace-empty").or(view.getByTestId("memory-workspace").getByTestId("memory-row").first())).toBeVisible();
  return view;
}

test("Amounts only: a descriptive price-point note is kept, and an amount is refused with the new copy", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const s = await setup(page);
  const view = await openMemory(page);
  await view.getByTestId("memory-add-open").click();
  await view.getByTestId("memory-text").fill("A premium price point: budget-friendly for teams, never discount-led.");
  await expect(view.getByTestId("memory-money")).toHaveCount(0);
  await expect(view.getByTestId("memory-save")).toBeEnabled();
  await view.getByTestId("memory-save").click();
  const project = view.getByTestId("memory-project");
  await expect(project.getByTestId("memory-words")).toHaveText("A premium price point: budget-friendly for teams, never discount-led.");

  /* An amount: refused before anything is sent, with the amount named. */
  await view.getByTestId("memory-add-open").click();
  await view.getByTestId("memory-kind-note").click();
  await view.getByTestId("memory-text").fill("Packs are $49 each, a premium price point.");
  await expect(view.getByTestId("memory-money")).toHaveText("Amounts can't be remembered: prices, costs, credits and markups go out of date. Take out “$49” and save it again. Words such as “premium price point” are fine.");
  await expect(view.getByTestId("memory-save")).toBeDisabled();
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory2-amount");
  /* The server refuses the same, whoever asks: credits, a markup. */
  for (const [line, found] of [["Each take is 25 credits.", "25 credits"], ["We work at a 30% markup.", "30% markup"]]) {
    const refused = await page.request.post("/api/atomik/memory", { headers: s.headers, data: { action: "add", kind: "note", text: line } });
    expect(refused.status()).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain(`Take out “${found}”`);
  }
  await view.getByTestId("memory-text").fill("Cost-effective, never cheap-looking.");
  await expect(view.getByTestId("memory-money")).toHaveCount(0);
  await view.getByTestId("memory-save").click();
  await expect(project.getByTestId("memory-row")).toHaveCount(2);
  expect((await entries(page, s)).map((e) => [e.kind, e.text]).sort()).toEqual([["brand", "A premium price point: budget-friendly for teams, never discount-led."], ["note", "Cost-effective, never cheap-looking."]]);
  await clearOfTabBar(page, '[data-testid="memory-view"]');
  expect(s.paid).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("Cast & Elements: an approved identity is picked from the cast or the Soul IDs, and kept by reference", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const s = await setup(page, { soul: true });
  const view = await openMemory(page);
  await view.getByTestId("memory-add-open").click();
  await view.getByTestId("memory-kind-identity").click();
  await view.getByTestId("memory-identity-cast").click();
  const picker = view.getByTestId("memory-elements");
  await expect(picker.getByTestId("memory-element")).toHaveCount(3);
  await expect(picker.getByTestId("memory-element").nth(0)).toContainText("Maya");
  await expect(picker.getByTestId("memory-element").nth(0)).toContainText("Character · Cast & Elements");
  await expect(picker.getByTestId("memory-element").nth(1)).toContainText("Element · Cast & Elements");
  await expect(picker.getByTestId("memory-element").nth(2)).toContainText("Maya on the key");
  await expect(picker.getByTestId("memory-element").nth(2)).toContainText("Soul ID · character");
  /* Nothing picked, nothing to keep. */
  await expect(view.getByTestId("memory-save")).toBeDisabled();
  await picker.locator(`[data-ref="cast:${s.productionId}:cast-maya"]`).click();
  await view.getByTestId("memory-text").fill("The approved lead for the spring campaign.");
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory2-cast-pick");
  await view.getByTestId("memory-save").click();
  const project = view.getByTestId("memory-project");
  const row = project.locator('[data-kind="identity"]');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("memory-kind")).toHaveText("Approved identity");
  await expect(row.getByTestId("memory-asset")).toHaveText("Maya");
  await expect(row.getByTestId("memory-source")).toHaveText("Cast & Elements · Character");
  await expect(row.getByTestId("memory-words")).toHaveText("The approved lead for the spring campaign.");

  /* The Soul ID, for the whole workspace, with no words of its own. */
  await view.getByTestId("memory-add-open").click();
  await view.getByTestId("memory-kind-identity").click();
  await view.getByTestId("memory-identity-cast").click();
  await view.getByTestId("memory-elements").getByTestId("memory-element").filter({ hasText: "Maya on the key" }).click();
  await view.getByTestId("memory-add-form").getByTestId("memory-where-workspace").click();
  await view.getByTestId("memory-save").click();
  const everyone = view.getByTestId("memory-workspace");
  await expect(everyone.getByTestId("memory-row")).toHaveCount(1);
  await expect(everyone.getByTestId("memory-asset")).toHaveText("Maya on the key");
  await expect(everyone.getByTestId("memory-source")).toHaveText("Soul ID");

  /* By reference: the element's id and the person's words, nothing copied from the element. */
  const kept = await entries(page, s);
  expect(kept.map((e) => [e.kind, e.scope, e.assetId?.replace(/^soul:soul_\w+$/, "soul:<id>"), e.assetLabel, e.assetKind, e.text]).sort()).toEqual([
    ["identity", "project", `cast:${s.productionId}:cast-maya`, "Maya", "character", "The approved lead for the spring campaign."],
    ["identity", "workspace", "soul:<id>", "Maya on the key", "Soul ID", ""],
  ].sort());
  /* Renamed in the Soul IDs: the page shows the name it has now. */
  await tenant(s.workspaceId, (db) => db.execute("UPDATE soul_identities SET name = 'Maya, approved'"));
  await page.reload();
  await expect(page.getByTestId("memory-workspace").getByTestId("memory-asset")).toHaveText("Maya, approved");
  await floors(page, '[data-testid="memory-view"]', phone);
  await clearOfTabBar(page, '[data-testid="memory-view"]');
  expect(s.paid).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("Brand kit: lines are picked from the Business brand kit, and each lands as an ordinary entry", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const s = await setup(page);
  const view = await openMemory(page);
  const kit = view.getByTestId("memory-brandkit");
  await expect(kit.getByTestId("memory-brandkit-summary")).toHaveText("8 lines to pick from");
  await kit.getByTestId("memory-brandkit-open").click();
  const picks = kit.getByTestId("memory-brandkit-pick");
  await expect(picks).toHaveCount(9);
  /* A sentence with an amount is taken out; a line that is only an amount cannot be kept. */
  await expect(kit.locator('[data-key="about"]')).toContainText("About Driftline: A skate brand from the coast. Hand-shaped in Goa.");
  await expect(kit.locator('[data-key="about"]')).toContainText("1 sentence with an amount left out.");
  await expect(kit.locator('[data-key="product:p-card"]')).toContainText("Has an amount (“$50”), so it can’t be kept.");
  await expect(kit.locator('[data-key="product:p-card"] input')).toBeDisabled();
  /* Nothing is kept until the person picks. */
  await expect(kit.getByTestId("memory-brandkit-keep")).toBeDisabled();
  for (const key of ["name", "voice", "audience", "product:p-wave"]) await kit.locator(`[data-key="${key}"]`).click();
  await kit.getByTestId("memory-where-workspace").click();
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory2-brandkit");
  await expect(kit.getByTestId("memory-brandkit-keep")).toHaveText("Keep 4");
  await kit.getByTestId("memory-brandkit-keep").click();
  await expect(kit.getByTestId("memory-brandkit-result")).toHaveText("Kept 4 lines from the brand kit.");
  const everyone = view.getByTestId("memory-workspace");
  await expect(everyone.getByTestId("memory-row")).toHaveCount(4);
  await expect(everyone.getByTestId("memory-meta").first()).toContainText("From the brand kit, added by you");
  /* What is kept says so, and the summary counts what is left. */
  await expect(kit.locator('[data-key="name"]')).toContainText("Already kept.");
  await expect(kit.getByTestId("memory-brandkit-summary")).toHaveText("4 lines to pick from");
  const kept = await entries(page, s);
  expect(kept.map((e) => [e.kind, e.scope, e.source, e.origin, e.text]).sort()).toEqual([
    ["audience", "workspace", "person", "brand-kit", "Skaters, 16 to 24, in coastal towns."],
    ["brand", "workspace", "person", "brand-kit", "Brand name: Driftline."],
    ["brand", "workspace", "person", "brand-kit", "Brand voice: Warm, dry humour. Never salesy."],
    ["note", "workspace", "person", "brand-kit", "Product: Wave Runner — Breathable knit upper."],
  ]);
  await kit.getByTestId("memory-brandkit-cancel").click();
  await floors(page, '[data-testid="memory-view"]', phone);
  await clearOfTabBar(page, '[data-testid="memory-view"]');
  expect(s.paid).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("Read with Atomik: priced first, approved at that price, its proposals reviewed, and two kept", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const s = await setup(page, { credits: 2000 });
  const view = await openMemory(page);
  const card = view.getByTestId("memory-import");
  await card.getByTestId("memory-import-text").fill([
    "- Brand colours are teal and warm sand",
    "- Our audience is skaters in coastal towns",
    "- Packs are $49 each",
    "- A premium price point, never discount-led",
    "- Always end on the board",
  ].join("\n"));
  /* The free import stays the default; reading with Atomik is the explicit, paid choice. */
  await expect(card.getByTestId("memory-import-go")).toHaveText("Turn into entries");
  await card.getByTestId("memory-read-open").click();
  const panel = view.getByTestId("memory-read");
  const go = panel.getByTestId("memory-read-go");
  await expect(go).toHaveText(/^Read · about \d[\d,]*(?:\.\d)? cr$/);
  /* A figure may carry one decimal (tenths of a credit); the page writes it as it is read here. */
  const figure = (await go.textContent())!.match(/about (\d[\d,]*(?:\.\d)?) cr/)![1];
  const credits = Number(figure.replace(/,/g, ""));
  await expect(panel.getByTestId("memory-read-estimate")).toHaveText(`about ${figure} cr · charged what the read actually costs, with up to ${figure} cr reserved until it finishes.`);
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory2-read-quote");
  /* Only the price was asked for: nothing sent, nothing kept. */
  expect(s.reads.length).toBeGreaterThan(0);
  expect(s.reads.every((r) => r.quote)).toBe(true);
  expect(await entries(page, s)).toEqual([]);

  await go.click();
  const summary = panel.getByTestId("memory-proposals-summary");
  await expect(summary).toContainText("Atomik proposed 4 entries. 1 line with an amount left out.");
  const billed = Number((await summary.textContent())!.match(/Read for (\d[\d,]*(?:\.\d)?) cr\./)![1].replace(/,/g, ""));
  expect(billed).toBeGreaterThanOrEqual(0.1);
  expect(billed).toBeLessThanOrEqual(credits);
  const proposals = panel.getByTestId("memory-proposal");
  await expect(proposals).toHaveCount(4);
  await expect(proposals.nth(0)).toContainText("Brand colours are teal and warm sand");
  /* Sent once, at the approved price, under its own key. */
  const sent = s.reads.filter((r) => !r.quote);
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ maxCredits: credits });
  expect(sent[0].key).toMatch(/^[\w-]{8,}$/);
  /* Nothing is kept before the ticks. */
  expect(await entries(page, s)).toEqual([]);
  await expect(panel.getByTestId("memory-proposals-keep")).toBeDisabled();
  await proposals.nth(0).click();
  await proposals.nth(2).click();
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory2-read-review");
  await expect(panel.getByTestId("memory-proposals-keep")).toHaveText("Keep 2");
  await panel.getByTestId("memory-proposals-keep").click();
  await expect(card.getByTestId("memory-import-result")).toHaveText("Kept 2 entries Atomik read.");
  await expect(view.getByTestId("memory-read")).toHaveCount(0);
  const everyone = view.getByTestId("memory-workspace");
  await expect(everyone.getByTestId("memory-row")).toHaveCount(2);
  await expect(everyone.getByTestId("memory-meta").first()).toContainText("Read by Atomik, kept by you");
  expect((await entries(page, s)).map((e) => [e.kind, e.source, e.origin, e.text]).sort()).toEqual([
    ["brand", "import", "atomik-read", "Brand colours are teal and warm sand"],
    ["note", "import", "atomik-read", "A premium price point, never discount-led"],
  ]);
  /* Charged once, what the read cost, in credits: the meter's one event is the figure the page showed. */
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const events = (await platform.execute({ sql: "SELECT kind,status,billed_credits FROM meter_events WHERE workspace_id=?", args: [s.workspaceId] })).rows;
    expect(events.map((e) => [e.kind, e.status, Number(e.billed_credits)])).toEqual([["text", "succeeded", billed]]);
  } finally { platform.close(); }
  expect(s.reads.filter((r) => !r.quote)).toHaveLength(1);
  await clearOfTabBar(page, '[data-testid="memory-view"]');
  expect(s.paid).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("The phone Memory page: every part fits, reads and can be pressed, and ends above the tab bar", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const s = await setup(page, { soul: true });
  /* A page with something in every part: kept for the project and the workspace, an identity by reference, a suggestion waiting, a gone element. */
  const add = async (data: Record<string, unknown>) => expect((await page.request.post("/api/atomik/memory", { headers: s.headers, data: { action: "add", ...data } })).ok()).toBe(true);
  await add({ kind: "brand", text: "Warm, dry humour. A premium price point, said plainly.", projectId: s.productionId });
  await add({ kind: "audience", text: "Skaters, 16 to 24, in coastal towns." });
  await add({ kind: "identity", text: "The approved lead.", assetId: `cast:${s.productionId}:cast-maya`, projectId: s.productionId });
  await add({ kind: "identity", text: "", assetId: `cast:${s.productionId}:cast-board` });
  expect((await page.request.post("/api/atomik/memory", { headers: s.headers, data: { action: "import", from: "claude", text: "- Always end on the board\n- Night riders, after dark" } })).status()).toBe(201);
  /* The board leaves Cast & Elements: its entry stays, said to be gone, and no plan reads it. */
  await tenant(s.workspaceId, async (db) => {
    const row = (await db.execute({ sql: "SELECT body FROM workbench_projects WHERE project_id = ?", args: [DRAFT] })).rows[0];
    const body = JSON.parse(String(row.body)) as { production: { cast: { entries: { id: string }[] } } };
    body.production.cast.entries = body.production.cast.entries.filter((e) => e.id !== "cast-board");
    await db.execute({ sql: "UPDATE workbench_projects SET body = ? WHERE project_id = ?", args: [JSON.stringify(body), DRAFT] });
  });
  const view = await openMemory(page);
  await expect(view.getByTestId("memory-waiting").getByTestId("memory-row")).toHaveCount(2);
  await expect(view.getByTestId("memory-project").getByTestId("memory-row")).toHaveCount(2);
  const board = view.getByTestId("memory-workspace").locator('[data-kind="identity"]');
  await expect(board.getByTestId("memory-gone")).toHaveText("No longer in Cast & Elements, so Atomik leaves it out.");
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory2-page");
  await clearOfTabBar(page, '[data-testid="memory-view"]');

  /* Each part opened, at this size: the identity picker, the brand kit, the read's price. */
  await view.getByTestId("memory-add-open").click();
  await view.getByTestId("memory-kind-identity").click();
  await view.getByTestId("memory-identity-cast").click();
  await expect(view.getByTestId("memory-elements").getByTestId("memory-element")).toHaveCount(3);
  await floors(page, '[data-testid="memory-view"]', phone);
  await view.getByTestId("memory-add-cancel").click();
  await view.getByTestId("memory-brandkit").getByTestId("memory-brandkit-open").click();
  await floors(page, '[data-testid="memory-view"]', phone);
  await view.getByTestId("memory-brandkit-cancel").click();
  await view.getByTestId("memory-import-text").fill("- Teal and sand\n- Packs are $49");
  await view.getByTestId("memory-read-open").click();
  await expect(view.getByTestId("memory-read-go")).toHaveText(/^Read · about \d[\d,]*(?:\.\d)? cr$/);
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory2-page-read");
  await clearOfTabBar(page, '[data-testid="memory-view"]');
  await view.getByTestId("memory-read-cancel").click();
  await expect(view.getByTestId("memory-read")).toHaveCount(0);
  /* Nothing read, nothing spent. */
  expect(s.reads.every((r) => r.quote)).toBe(true);
  expect(s.paid).toEqual([]);
  expect(s.errors).toEqual([]);
});
