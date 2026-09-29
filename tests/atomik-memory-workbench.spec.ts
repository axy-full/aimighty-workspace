import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdirSync, readFileSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { newProject } from "../lib/workbench/studio";

/**
 * Atomik › Memory, built in Particl, on a local
 * ENGINE_MOCK=1 server with the real memory routes and a real workspace
 * database: a person adds, edits and forgets what Atomik keeps (forget
 * archives, an edit archives the version it replaces); a paste from another
 * assistant waits for review; Remember on an asset keeps it by its Library
 * id; "Forget …" and "Remember …" in the Agent, and Remember on its proposal
 * and on one of its assumptions. Nothing here quotes, plans or renders: the
 * Agent's paid route is refused if anything reaches it.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const MEMORY = "/suites?suite=atomik&page=agent&sp=memory";
const AGENT = "/suites?suite=atomik&page=agent&sp=agent";
/* Review screenshots only when MEMORY_SHOTS names a folder; CI takes none. */
const SHOTS = process.env.MEMORY_SHOTS;

type Entry = { id: string; kind: string; text: string; status: string; source: string; scope: string; assetId: string | null; assetLabel: string | null };
type Setup = { workspaceId: string; headers: Record<string, string>; productionId: string; uploadId: string | null; errors: string[]; paid: string[] };

async function setup(page: Page, opts: { upload?: boolean; jobs?: unknown[] } = {}): Promise<Setup> {
  const { workspace } = await signInLocally(page.request);
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const headers = { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` };
  /* A real production (memory is kept against it) and, when asked, a real upload (a reference is a Library asset). */
  const made = await page.request.post("/api/projects", { data: { name: "Coastal light study" } });
  expect(made.ok(), await made.text()).toBe(true);
  const productionId = ((await made.json()) as { id: string }).id;
  let uploadId: string | null = null;
  if (opts.upload) {
    const sent = await page.request.post("/api/uploads", { headers, multipart: { file: { name: "Hero still.webp", mimeType: "image/webp", buffer: readFileSync("public/campaign/hero.webp") } } });
    expect(sent.ok(), await sent.text()).toBe(true);
    uploadId = ((await sent.json()) as { id: string }).id;
  }
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject("Coastal light study"), id: "ws-memory", productionProjectId: productionId, shotMappings: {} } });
  await mockLibrary(page, { uploads: uploadId ? [upload({ id: uploadId, filename: "Hero still.webp" })] : [], generations: [] });
  const paid: string[] = [];
  await page.route("**/api/workbench/atomik**", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: false, models: [], jobs: opts.jobs ?? [] } });
    paid.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 409, json: { error: "No agent request is allowed in this test." } });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET" && /^\/api\/(generate|audio|atomik\/(?!memory)|workbench\/atomik)/.test(path)) paid.push(`${request.method()} ${path}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* React's own complaints (a repeated key, an update loop, a hydration mismatch) count as errors here. */
  page.on("console", (message) => {
    if (message.type() === "error" && /same key|unique "key"|Maximum update depth|Cannot update a component|hydrat/i.test(message.text())) errors.push(message.text().slice(0, 300));
  });
  return { workspaceId: workspace.id, headers, productionId, uploadId, errors, paid };
}

async function entries(page: Page, s: Setup): Promise<Entry[]> {
  const reply = await page.request.get(`/api/atomik/memory?projectId=${encodeURIComponent(s.productionId)}`, { headers: s.headers });
  expect(reply.ok(), await reply.text()).toBe(true);
  return ((await reply.json()) as { entries: Entry[] }).entries;
}
async function keep(page: Page, s: Setup, data: Record<string, unknown>) {
  const reply = await page.request.post("/api/atomik/memory", { headers: s.headers, data: { action: "add", ...data } });
  expect(reply.ok(), await reply.text()).toBe(true);
}
/** The workspace database's archive, read directly: forget and edit keep a copy there. */
async function archive(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const url = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [workspaceId] })).rows[0].db_url);
    const tenant = createClient({ url, timeout: 10_000 });
    try {
      const rs = await tenant.execute("SELECT reason, archived_by, body FROM archived_rows WHERE table_name='atomik_memory' ORDER BY archived_at");
      return rs.rows.map((r) => ({ reason: String(r.reason), body: JSON.parse(String(r.body)) as Record<string, unknown> }));
    } finally { tenant.close(); }
  } finally { platform.close(); }
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
        /* A checkbox's target is its label; a segmented option may be 40px inside its 44px track. */
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
    /* The content itself — what has no shown element inside it — not a padded box around it. */
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

test("Memory: a person adds, edits and forgets what Atomik keeps; money is refused; a failed read says Try again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const s = await setup(page);
  /* The first read fails, and says so with Try again (never "Retry", which is a paid re-render). */
  let failFirst = true;
  await page.route("**/api/atomik/memory?**", (route) => {
    if (failFirst && route.request().method() === "GET") { failFirst = false; return route.fulfill({ status: 500, json: { error: "Memory could not be loaded." } }); }
    return route.fallback();
  });
  await page.goto(MEMORY);
  await expect(page.getByTestId("page-title")).toHaveText("Memory");
  /* Memory has its own controls and costs nothing: no "Run stage" here. */
  await expect(page.getByTestId("primary-action")).toHaveCount(0);
  const view = page.getByTestId("memory-view");
  await expect(view.getByTestId("memory-error")).toContainText("Memory could not be loaded.");
  await expect(view.getByTestId("memory-error-retry")).toHaveText("Try again");
  await view.getByTestId("memory-error-retry").click();
  await expect(view.getByTestId("memory-error")).toHaveCount(0);
  await expect(view.getByTestId("memory-project-empty")).toBeVisible();
  await expect(view.getByTestId("memory-workspace-empty")).toBeVisible();
  await floors(page, '[data-testid="memory-view"]', phone);

  /* Money is refused before anything is sent. */
  await view.getByTestId("memory-add-open").click();
  await view.getByTestId("memory-text").fill("Our Studio plan is $49 a month.");
  await expect(view.getByTestId("memory-money")).toBeVisible();
  await expect(view.getByTestId("memory-save")).toBeDisabled();
  await view.getByTestId("memory-text").fill("Teal and sand. Warm, dry humour.");
  await expect(view.getByTestId("memory-money")).toHaveCount(0);
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory-add");
  await view.getByTestId("memory-save").click();
  const project = view.getByTestId("memory-project");
  await expect(project.getByTestId("memory-row")).toHaveCount(1);
  await expect(project.getByTestId("memory-words")).toHaveText("Teal and sand. Warm, dry humour.");
  await expect(project.getByTestId("memory-kind")).toHaveText("Brand");
  await expect(project.getByTestId("memory-meta")).toContainText("Added by you");

  /* An audience line for the whole workspace. */
  await view.getByTestId("memory-add-open").click();
  await view.getByTestId("memory-kind-audience").click();
  await view.getByTestId("memory-text").fill("Night riders in coastal towns.");
  await view.getByTestId("memory-add-form").getByTestId("memory-where-workspace").click();
  await view.getByTestId("memory-save").click();
  const everyone = view.getByTestId("memory-workspace");
  await expect(everyone.getByTestId("memory-row")).toHaveCount(1);
  await expect(everyone.getByTestId("memory-kind")).toHaveText("Audience");

  /* Edit: the earlier words go to the archive. */
  await project.getByTestId("memory-edit").click();
  await project.getByTestId("memory-edit-text").fill("Teal, sand and warm grey. Dry humour.");
  await floors(page, '[data-testid="memory-view"]', phone);
  await project.getByTestId("memory-edit-save").click();
  await expect(project.getByTestId("memory-words")).toHaveText("Teal, sand and warm grey. Dry humour.");

  /* Forget asks first, then archives. */
  await everyone.getByTestId("memory-forget").click();
  await expect(everyone.getByText("Forget this? A copy stays in the workspace archive.")).toBeVisible();
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory-forget");
  await everyone.getByTestId("memory-forget-confirm").click();
  await expect(everyone.getByTestId("memory-row")).toHaveCount(0);
  await expect(view.getByTestId("memory-workspace-empty")).toBeVisible();

  expect((await entries(page, s)).map((e) => [e.kind, e.scope, e.text])).toEqual([["brand", "project", "Teal, sand and warm grey. Dry humour."]]);
  const archived = await archive(s.workspaceId);
  expect(archived.map((a) => [a.reason, a.body.text])).toEqual([["edited", "Teal and sand. Warm, dry humour."], ["forgotten", "Night riders in coastal towns."]]);
  await clearOfTabBar(page, '[data-testid="memory-view"]');
  expect(s.paid).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("Import: a paste from another assistant waits for review; a person keeps one and dismisses one", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const s = await setup(page);
  await page.goto(MEMORY);
  const view = page.getByTestId("memory-view");
  await expect(view.getByTestId("memory-workspace-empty")).toBeVisible();
  await view.getByTestId("memory-from-claude").click();
  await view.getByTestId("memory-import-text").fill([
    "Here is what I remember about you:",
    "- Brand colours are teal and warm sand",
    "- Your audience is teenagers in coastal towns",
    "- You pay $20 a month for the Pro plan",
    "- Always end on the product",
  ].join("\n"));
  await floors(page, '[data-testid="memory-view"]', phone);
  await view.getByTestId("memory-import-go").click();
  await expect(view.getByTestId("memory-import-result")).toHaveText("3 entries are waiting for you above. 1 line about money left out.");
  const waiting = view.getByTestId("memory-waiting");
  await expect(waiting.getByTestId("memory-row")).toHaveCount(3);
  await expect(waiting.getByTestId("memory-meta").first()).toContainText("Imported from Claude");
  await expect(waiting.getByTestId("memory-kind")).toHaveText(["Brand", "Audience", "Note"]);
  await floors(page, '[data-testid="memory-view"]', phone);
  await shot(page, "memory-import");
  /* Nothing imported is read by a planner until someone keeps it. */
  expect((await entries(page, s)).every((e) => e.status === "proposed")).toBe(true);

  await waiting.locator('[data-kind="brand"]').getByTestId("memory-accept").click();
  await expect(view.getByTestId("memory-workspace").getByTestId("memory-row")).toHaveCount(1);
  await expect(view.getByTestId("memory-workspace").getByTestId("memory-meta")).toContainText("Imported from Claude, kept by you");
  await waiting.locator('[data-kind="note"]').getByTestId("memory-forget").click();
  await expect(waiting.getByText("Dismiss this suggestion?")).toBeVisible();
  await waiting.locator('[data-kind="note"]').getByTestId("memory-forget-confirm").click();
  await expect(waiting.getByTestId("memory-row")).toHaveCount(1);

  const now = await entries(page, s);
  expect(now.map((e) => [e.kind, e.status, e.source])).toEqual(expect.arrayContaining([["brand", "active", "import"], ["audience", "proposed", "import"]]));
  expect(now).toHaveLength(2);
  expect((await archive(s.workspaceId)).map((a) => [a.reason, a.body.text])).toEqual([["dismissed", "Always end on the product"]]);
  await clearOfTabBar(page, '[data-testid="memory-view"]');
  expect(s.paid).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("Remember on an asset keeps it as a reference, by its Library id, and the Memory page shows it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const s = await setup(page, { upload: true });
  const assetId = `upload:${s.uploadId}`;
  await page.goto(MEMORY);
  await expect(page.getByTestId("page-title")).toHaveText("Memory");
  /* The asset is picked where a person picks it: the Library's Assets, which opens it in the Inspector. */
  if (!WIDE.includes(info.project.name)) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  await page.getByTestId("library-assets").locator(`[data-asset="${assetId}"] .gx-asset-thumb`).click();
  const inspector = page.getByTestId("asset-inspector");
  await expect(inspector.getByTestId("inspector-title")).toHaveText("Hero still.webp");
  await inspector.getByTestId("inspector-remember").click();
  const form = page.getByTestId("remember-asset");
  await expect(form).toBeVisible();
  await form.getByTestId("remember-note").fill("Our hero angle: low, wide and warm.");
  await form.scrollIntoViewIfNeeded();
  await floors(page, '[data-testid="remember-asset"]', phone);
  await shot(page, "memory-remember-asset");
  await form.getByTestId("remember-save").click();
  await expect(page.getByTestId("toast")).toContainText("Atomik will remember Hero still.webp.");
  await expect(form).toHaveCount(0);

  const kept = await entries(page, s);
  expect(kept.map((e) => [e.kind, e.scope, e.assetId, e.assetLabel, e.text])).toEqual([["reference", "project", assetId, "Hero still.webp", "Our hero angle: low, wide and warm."]]);
  /* The open Memory page reads it again on its own. */
  if (!WIDE.includes(info.project.name)) await page.getByTestId("close-inspector").click();
  const row = page.getByTestId("memory-project").getByTestId("memory-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("memory-kind")).toHaveText("Reference");
  await expect(row.getByTestId("memory-asset")).toHaveText("Hero still.webp");
  await floors(page, '[data-testid="memory-view"]', phone);
  expect(s.paid).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("Forget and Remember in the Agent: it proposes, a person confirms, and nothing is quoted or spent", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const job = {
    id: "wb_atomik_job", requestId: "request-memory-1", projectId: "ws-memory", productionProjectId: null, suite: "atomik", status: "succeeded",
    request: "[atomik] Plan the harbour teaser", model: "anthropic/claude-fixture", depth: "Deep", refs: [], estimateUsd: 0, estimateCredits: 7, costUsd: null, credits: 3, error: null, createdAt: 1, updatedAt: 1,
    plan: { id: "wb_atomik_job", request: "[atomik] Plan the harbour teaser", model: "anthropic/claude-fixture", depth: "Deep", refs: [], applied: false, intent: "shots",
      summary: "A three-shot teaser that opens on the harbour at dawn and ends on the board.", steps: ["Board the harbour at dawn."],
      suiteAgent: { suite: "atomik", projectId: "ws-memory", actions: [{ kind: "image", title: "Harbour at dawn", prompt: "The harbour at dawn, low mist, a skateboard on the quay.", referenceIds: [] }], hooks: [], assumptions: ["The audience is night riders in coastal towns."] } },
  };
  const s = await setup(page, { jobs: [job] });
  await keep(page, s, { kind: "brand", text: "Teal #0FA3A3 and warm sand.", projectId: s.productionId });
  await keep(page, s, { kind: "note", text: "Teal light in the night scenes." });
  await keep(page, s, { kind: "audience", text: "Skaters, 16 to 24." });
  await page.goto(AGENT);
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  const panel = page.getByRole("region", { name: "Production orchestrator" });
  const box = panel.getByLabel("Creative request");
  await expect(box).toBeEnabled();

  /* "Forget …": the Agent finds what it is about; the plain match is chosen; a person confirms. */
  await box.fill("Forget the teal palette");
  await panel.getByTestId("agent-memory-command").click();
  const forget = page.getByTestId("agent-forget");
  await expect(forget.getByTestId("agent-forget-match")).toHaveCount(2);
  await expect(forget.getByTestId("agent-forget-match").first()).toContainText("Teal #0FA3A3 and warm sand.");
  await expect(forget.getByRole("checkbox").first()).toBeChecked();
  await expect(forget.getByRole("checkbox").nth(1)).not.toBeChecked();
  await floors(page, '[data-testid="agent-forget"]', phone);
  await shot(page, "memory-agent-forget");
  await clearOfTabBar(page, '[data-tool-body="agent"]');
  await forget.getByTestId("agent-forget-confirm").click();
  await expect(panel.getByTestId("agent-memory-note")).toHaveText("Forgot 1 entry. A copy of each stays in the workspace archive.");
  await expect(box).toHaveValue("");
  expect((await entries(page, s)).map((e) => e.text).sort()).toEqual(["Skaters, 16 to 24.", "Teal light in the night scenes."]);

  /* "Remember …": a line a person confirms, sorted into its kind. */
  await box.fill("Remember that our audience is night riders");
  await panel.getByTestId("agent-memory-command").click();
  const remember = page.getByTestId("agent-remember");
  await expect(remember.getByTestId("agent-remember-text")).toHaveValue("our audience is night riders");
  await expect(remember.getByTestId("agent-remember-kind-audience")).toHaveAttribute("aria-pressed", "true");
  await floors(page, '[data-testid="agent-remember"]', phone);
  await remember.getByTestId("agent-remember-save").click();
  await expect(panel.getByTestId("agent-memory-note")).toHaveText("Atomik will remember that.");

  /* Remember on the proposal (a person's choice), and on one of Atomik's assumptions (Atomik proposed, a person keeps). */
  await panel.getByTestId("agent-remember-summary").click();
  await expect(page.getByTestId("agent-remember").getByTestId("agent-remember-text")).toHaveValue("A three-shot teaser that opens on the harbour at dawn and ends on the board.");
  await page.getByTestId("agent-remember").getByTestId("agent-remember-kind-note").click();
  await page.getByTestId("agent-remember").getByTestId("agent-remember-save").click();
  await expect(panel.getByTestId("agent-memory-note")).toHaveText("Atomik will remember that.");
  await panel.getByText("Assumptions to review").click();
  await panel.getByTestId("agent-remember-assumption").click();
  const assumed = page.getByTestId("agent-remember");
  await expect(assumed).toContainText("Keep what Atomik assumed");
  await assumed.getByTestId("agent-remember-workspace").click();
  await floors(page, '[data-testid="agent-remember"]', phone);
  await assumed.getByTestId("agent-remember-save").click();
  await expect(panel.getByTestId("agent-memory-note")).toHaveText("Atomik will remember that.");

  const kept = await entries(page, s);
  expect(kept.map((e) => [e.kind, e.source, e.scope, e.text])).toEqual(expect.arrayContaining([
    ["audience", "person", "project", "our audience is night riders"],
    ["note", "person", "project", "A three-shot teaser that opens on the harbour at dawn and ends on the board."],
    ["audience", "atomik", "workspace", "The audience is night riders in coastal towns."],
  ]));
  expect((await archive(s.workspaceId)).map((a) => [a.reason, a.body.text])).toEqual([["forgotten", "Teal #0FA3A3 and warm sand."]]);
  await clearOfTabBar(page, '[data-tool-body="agent"]');
  /* Nothing quoted, planned or rendered. */
  expect(s.paid).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(s.errors).toEqual([]);
});
