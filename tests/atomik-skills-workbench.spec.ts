import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { joinLocallyAsMember, localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { legacyShell } from "./helpers/legacyShell";
import { mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { newProject } from "../lib/workbench/studio";

/**
 * Atomik skills, on a local ENGINE_MOCK=1 server with the real skills,
 * Atomik and generate routes and a real workspace database: a finished run is
 * saved as a skill from the Atomik composer; `/` runs it with new words; its
 * first step waits at the checkpoint with a quote, and Continue approves that
 * step alone at that price (the engine is the mock: no vendor is called, and
 * the charge is the local ledger's). On the Suites Skills page an edit makes
 * version 2 while version 1 stays readable; archive hides a skill and restore
 * brings it back; a teammate sees the workspace's skill and never another's
 * personal one; and a skill run from the page waits for Continue there too.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SKILLS = "/suites?suite=atomik&page=agent&sp=saved-skills";
const NANO = "gemini-3.1-flash-image";
const KLING = "fal-ai/kling-video/v3/standard";
const BRIEF = "A 15 second spot for our Wave Runner sneakers on a beach at sunset.";
/* Review screenshots only when SKILLS_SHOTS names a folder; CI takes none. */
const SHOTS = process.env.SKILLS_SHOTS;

type World = { workspaceId: string; tenantUrl: string; headers: Record<string, string>; me: { id: string; email: string }; errors: string[] };

/** A fresh workspace with local credits (the mock engine still meters), its database, and every page error counted. */
async function signedIn(page: Page, api: APIRequestContext = page.request, joined?: { workspace: { id: string } }): Promise<World> {
  const workspace = joined?.workspace ?? (await signInLocally(api)).workspace;
  const me = (await (await api.get("/api/me")).json()) as { id: string; email: string };
  const headers = { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    if (!joined) await platform.execute({
      sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      args: [randomUUID(), workspace.id, 2000, "Local mock Atomik skills", "admin", "test", Date.now()],
    });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [workspace.id] })).rows[0].db_url);
  } finally { platform.close(); }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /same key|unique "key"|Maximum update depth|Cannot update a component|hydrat/i.test(message.text())) errors.push(message.text().slice(0, 300));
  });
  return { workspaceId: workspace.id, tenantUrl, headers, me, errors };
}

/** A production of the workspace's own (a run files its takes there). */
async function production(api: APIRequestContext, name = "Wave Runner launch"): Promise<string> {
  const made = await api.post("/api/projects", { data: { name } });
  expect(made.ok(), await made.text()).toBe(true);
  return ((await made.json()) as { id: string }).id;
}

/**
 * A finished Atomik run, filed as a planning turn files one: the person's
 * request, the reply, a still and a clip that both ran. Written straight into
 * the local workspace database, so no planner is asked for it.
 */
async function seedRun(w: World, projectId: string, by: string): Promise<string> {
  const chatId = `ach_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const at = Date.now() - 120_000;
  const tenant = createClient({ url: w.tenantUrl, timeout: 10_000 });
  try {
    const step = (n: number, kind: string, title: string, prompt: string, model: string, params: object) => ({
      sql: `INSERT INTO atomik_steps (id, chat_id, message_id, position, kind, title, prompt, model, params, refs, status, gen_id, est_cost_usd, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?, '[]', 'done', ?, 0.01, ?, ?)`,
      args: [`astp_${chatId.slice(4)}${n}`, chatId, `amsg_${chatId.slice(4)}b`, n, kind, title, prompt, model, JSON.stringify(params), `gen_seed_${chatId.slice(4)}${n}`, at + 2 + n, at + 2 + n],
    });
    await tenant.batch([
      { sql: `INSERT INTO atomik_chats (id, project_id, title, model, agent_mode, status, text_cost_usd, created_by, created_at, updated_at, deleted)
              VALUES (?,?,?,?,?,?,0,?,?,?,0)`, args: [chatId, projectId, "Wave Runner spot", "auto", "ask", "idle", by, at, at + 10] },
      { sql: "INSERT INTO atomik_messages (id, chat_id, role, text, activity, created_at) VALUES (?,?,?,?,?,?)", args: [`amsg_${chatId.slice(4)}a`, chatId, "user", BRIEF, "[]", at] },
      { sql: "INSERT INTO atomik_messages (id, chat_id, role, text, activity, cost_usd, model, created_at) VALUES (?,?,?,?,?,?,?,?)",
        args: [`amsg_${chatId.slice(4)}b`, chatId, "assistant", "A hero still, then a skate pass.", "[]", 0, "anthropic/claude-sonnet-4.6", at + 1] },
      step(0, "image", "Wave Runner hero still", "Studio still of teal Wave Runner sneakers on wet sand, beach at sunset, warm backlight.", NANO, { ratio: "16:9", resolution: "1K" }),
      step(1, "video", "Skate pass", "A skater rolls along a beach at sunset in teal Wave Runner sneakers, low wide tracking shot.", KLING, { ratio: "16:9", resolution: "1080p", seconds: 5 }),
    ], "write");
  } finally { tenant.close(); }
  return chatId;
}

type Saved = { id: string; slug: string; version: number };
async function saveViaApi(api: APIRequestContext, w: World, chatId: string, extra: Record<string, unknown> = {}): Promise<Saved> {
  const saved = await api.post("/api/atomik/skills", { headers: w.headers, data: {
    action: "save", chatId, name: "Wave Runner spot", description: "A hero still and a skate pass for any product.", scope: "workspace",
    parameters: [{ key: "product", label: "Product", phrase: "Wave Runner sneakers" }, { key: "setting", label: "Setting", phrase: "beach at sunset" }], ...extra,
  } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return ((await saved.json()) as { skill: Saved }).skill;
}

/** What the workspace made, what its steps are, and what its meter charged, read straight from the local databases. */
async function books(w: World) {
  const tenant = createClient({ url: w.tenantUrl, timeout: 10_000 });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const takes = (await tenant.execute("SELECT id, prompt, model FROM generations ORDER BY created_at")).rows.map((r) => ({ id: String(r.id), prompt: String(r.prompt), model: String(r.model) }));
    const steps = (await tenant.execute("SELECT chat_id, title, prompt, model, status, gen_id FROM atomik_steps ORDER BY created_at, position")).rows
      .map((r) => ({ chat: String(r.chat_id), title: String(r.title), prompt: String(r.prompt), model: String(r.model), status: String(r.status), genId: r.gen_id == null ? null : String(r.gen_id) }));
    const charges = (await platform.execute({ sql: "SELECT id, kind, billed_credits FROM meter_events WHERE workspace_id=? ORDER BY created_at", args: [w.workspaceId] }))
      .rows.map((r) => ({ id: String(r.id), kind: String(r.kind), credits: r.billed_credits == null ? null : Number(r.billed_credits) }));
    const versions = (await tenant.execute("SELECT skill_id, version, template FROM atomik_skill_versions ORDER BY skill_id, version").catch(() => ({ rows: [] })))
      .rows.map((r) => ({ skill: String(r.skill_id), version: Number(r.version), template: String(r.template) }));
    return { takes, steps, charges, versions };
  } finally { tenant.close(); platform.close(); }
}

const isPhone = (page: Page) => page.viewportSize()!.width < 760;
const surfaceOf = (page: Page) => (isPhone(page) ? page.getByRole("dialog", { name: "Atomik" }) : page.getByRole("complementary", { name: "Atomik" }));
const creditsIn = (text: string | null) => Number(/(\d[\d,]*) cr/.exec(text ?? "")?.[1].replace(/,/g, "") ?? NaN);

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
        /* A field's target is its label when it sits in one; a segmented option may be 40px inside its 44px track. */
        const label = el.tagName === "INPUT" ? el.closest("label") : null;
        const box = (label ?? el).getBoundingClientRect();
        const track = el.classList.contains("gx-seg-btn") ? el.closest(".gx-seg") : null;
        const floor = track && track.getBoundingClientRect().height >= 43.5 ? 40 : 44;
        if (box.height < floor - 0.5 || box.width < 44 - 0.5) out.push(`${name(el)} is ${Math.round(box.width)}×${Math.round(box.height)}`);
      }
    }
    const lum = (r: number, g: number, b: number) => [r, g, b].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
    const floor = lum(0x7c, 0x7c, 0x84);
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>("p, label, em, span, legend, strong"))) {
      if (!shown(el) || !el.textContent?.trim()) continue;
      const m = getComputedStyle(el).color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m) continue;
      const a = m[4] == null ? 1 : Number(m[4]);
      const over = (c: number, bg: number) => c * a + bg * (1 - a);
      if (lum(over(+m[1], 0), over(+m[2], 0), over(+m[3], 0)) + 1e-6 < floor) out.push(`${name(el)}: ${getComputedStyle(el).color} is dimmer than #7C7C84`);
    }
    /* A price is never cut short. */
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[data-testid$="price"]'))) {
      if (!shown(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === "ellipsis") out.push(`${name(el)}: the price is cut short`);
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

/** The Suites page with a project of the workspace's open (its draft mocked; its production real). */
async function openSkillsPage(page: Page, productionId: string, draftName = "Wave Runner launch") {
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject(draftName), id: "ws-skills", productionProjectId: productionId, shotMappings: {} } });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.goto(SKILLS);
  await expect(page.getByTestId("page-title")).toHaveText("Skills");
  /* Skills have their own controls and cost nothing to browse: no "Run stage" here. */
  await expect(page.getByTestId("primary-action")).toHaveCount(0);
}

test("the composer saves a run as a skill; / runs it with new words; its first step waits at the checkpoint and Continue approves it at its quote", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(300_000);
  const phone = PHONES.includes(info.project.name);
  const w = await signedIn(page);
  /* A Studio project and its production, as the Atomik page opens it; the run is in that production. */
  const draft = newProject("Wave Runner launch");
  const put = await page.request.put("/api/workbench/projects", { headers: w.headers, data: { project: draft, revision: 0 } });
  expect(put.ok(), await put.text()).toBe(true);
  const productionId = String((await put.json()).productionProjectId);
  const chatId = await seedRun(w, productionId, w.me.id);
  /* This tab's production, and the rail open, as a returning person left them. */
  await page.addInitScript(([id, key]) => {
    localStorage.setItem("aw_project", id);
    localStorage.setItem(key, JSON.stringify({ state: "expanded", last: "expanded" }));
  }, [productionId, `particl:atomik:${w.me.email}`]);
  const generated: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate") generated.push(request.postDataJSON() as Record<string, unknown>); });

  await page.goto(await legacyShell(page, `/atomik?project=${encodeURIComponent(draft.id)}&page=generate`));
  const surface = surfaceOf(page);
  await expect(surface).toBeVisible();
  /* The finished run is the conversation on screen; Save as skill sits beside the composer's pickers. */
  const save = surface.getByTestId("atomik-save-skill");
  await expect(save).toBeVisible({ timeout: 30_000 });
  await save.click();
  const dialog = page.getByRole("dialog", { name: "Save as skill" });
  await expect(dialog).toBeVisible();
  const form = dialog.getByTestId("skill-save-form");
  await expect(form.getByTestId("skill-save-name")).toHaveValue("Wave Runner spot");
  await expect(form.getByTestId("skill-save-slug")).toHaveValue("/wave-runner-spot");
  await expect(form.getByTestId("skill-save-step")).toHaveCount(2);
  /* The phrases the request and the prompts share are suggested as parameters; the person names them. */
  const params = form.getByTestId("skill-save-param");
  await expect(params).toHaveCount(2);
  await expect(params.nth(0).getByTestId("skill-save-param-phrase")).toHaveValue("Wave Runner sneakers");
  await expect(params.nth(1).getByTestId("skill-save-param-phrase")).toHaveValue("beach at sunset");
  await params.nth(0).getByTestId("skill-save-param-label").fill("Product");
  await params.nth(1).getByTestId("skill-save-param-label").fill("Setting");
  await form.getByTestId("skill-save-description").fill("A hero still and a skate pass for any product.");
  await form.getByTestId("skill-save-scope-workspace").click();
  /* What the skill keeps, shown before it is saved: each phrase is its parameter now. */
  await expect(form.getByTestId("skill-placeholder").first()).toHaveText("Product");
  await floors(page, '[data-testid="skill-dialog"]', phone);
  await shot(page, "skills-save");
  await form.getByTestId("skill-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(surface.getByTestId("atomik-skill-said")).toHaveText("Saved as /wave-runner-spot. Type / to run it again.");
  const saved = await books(w);
  expect(saved.versions).toHaveLength(1);
  /* Nothing the run made is kept. */
  for (const output of [`gen_seed_${chatId.slice(4)}0`, "done", "0.01"]) expect(saved.versions[0].template).not.toContain(output);

  /* `/` lists it as it is typed; picking it opens its run form with its defaults, never a planning turn. */
  const ask = surface.getByRole("textbox", { name: "Ask Atomik" });
  await ask.fill("/wave");
  const hints = surface.getByRole("listbox", { name: "Skills" });
  await expect(hints.getByRole("option")).toHaveText([/\/wave-runner-spot/]);
  /* The highlighted match is the one Enter opens, and the field points at it. */
  await expect(hints.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(ask).toHaveAttribute("aria-activedescendant", (await hints.getByRole("option").first().getAttribute("id"))!);
  await expect(surface.getByRole("button", { name: "Run /wave-runner-spot" })).toBeEnabled();
  /* A thumb's target on a phone; nothing runs off the side. */
  const option = await hints.getByRole("option").first().boundingBox();
  expect(option!.height).toBeGreaterThanOrEqual(phone ? 43.5 : 30);
  expect(option!.x + option!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await hints.getByRole("option").first().click();
  let run = page.getByRole("dialog", { name: "Run /wave-runner-spot" });
  await expect(run).toBeVisible();
  await expect(run.getByTestId("skill-param-product")).toHaveValue("Wave Runner sneakers");
  await run.getByTestId("skill-dialog-close").click();
  await expect(run).toHaveCount(0);
  /* Half a command and Enter opens the highlighted skill, not a planning turn. */
  await ask.fill("/wave-run");
  await expect(hints.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await ask.press("Enter");
  await expect(run).toBeVisible();
  await expect(run.getByTestId("skill-param-setting")).toHaveValue("beach at sunset");
  await run.getByTestId("skill-dialog-close").click();
  await expect(run).toHaveCount(0);
  /* The command with new words, sent: the same form, filled with them. */
  await ask.fill("/wave-runner-spot product: Red High-Tops · setting: a rooftop at dusk");
  await expect(surface.getByTestId("atomik-skill-command")).toContainText("/wave-runner-spot plans its steps for nothing");
  await ask.press("Enter");
  run = page.getByRole("dialog", { name: "Run /wave-runner-spot" });
  await expect(run.getByTestId("skill-param-product")).toHaveValue("Red High-Tops");
  await expect(run.getByTestId("skill-param-setting")).toHaveValue("a rooftop at dusk");
  const steps = run.getByTestId("skill-run-step");
  await expect(steps).toHaveCount(2);
  await expect(run.getByTestId("skill-run-price").first()).toHaveText(/^about \d+ cr$/);
  await expect(run.getByTestId("skill-run-total")).toContainText("about");
  await floors(page, '[data-testid="skill-dialog"]', phone);
  await shot(page, "skills-run");
  await run.getByTestId("skill-plan").click();
  await expect(run).toHaveCount(0);
  await expect(surface.getByTestId("atomik-skill-said")).toHaveText("Planned. Each step waits for its price and your Continue.");

  /* The plan is the conversation now: its first step is the checkpoint, priced live, waiting for Continue. */
  const checkpoint = isPhone(page) ? page.getByRole("dialog", { name: "Atomik" }) : surface;
  const go = checkpoint.getByRole("button", { name: /^Continue/ }).filter({ visible: true }).first();
  await expect(go).toBeEnabled({ timeout: 60_000 });
  const quoted = creditsIn(await go.textContent());
  expect(quoted).toBeGreaterThan(0);
  expect(generated).toEqual([]);
  const planned = (await books(w)).steps.filter((s) => s.chat === chatId && s.status === "proposed");
  expect(planned.map((s) => [s.title, s.model])).toEqual([["Wave Runner hero still", NANO], ["Skate pass", KLING]]);
  expect(planned[0].prompt).toBe("Studio still of teal Red High-Tops on wet sand, a rooftop at dusk, warm backlight.");

  /* Continue approves that one step at that price; the next one waits for its own Continue. */
  const rendered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/generate", { timeout: 60_000 });
  await go.click();
  expect((await rendered).status()).toBe(200);
  expect(generated).toHaveLength(1);
  expect(generated[0]).toMatchObject({ model: NANO, maxCredits: quoted, refine: false, projectId: productionId });
  expect(String(generated[0].prompt)).toContain("Red High-Tops");
  await expect.poll(async () => (await books(w)).steps.filter((s) => s.chat === chatId && s.title === "Wave Runner hero still" && s.status === "done" && s.genId && !s.genId.startsWith("gen_seed")).length, { timeout: 30_000 }).toBe(1);
  const after = await books(w);
  expect(after.takes.map((t) => t.model)).toEqual([NANO]);
  expect(after.steps.find((s) => s.chat === chatId && s.title === "Skate pass" && s.status === "proposed")).toBeTruthy();
  /* Charged no more than the button said. */
  const charge = after.charges.find((c) => c.id === after.takes[0].id);
  expect(charge?.credits ?? 0).toBeLessThanOrEqual(quoted);
  expect(generated).toHaveLength(1);
  expect(w.errors).toEqual([]);
});

test("Skills page: an edit makes version 2 and version 1 stays readable; archive hides a skill and restore brings it back; a failed read says Try again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(240_000);
  const phone = PHONES.includes(info.project.name);
  const w = await signedIn(page);
  const productionId = await production(page.request);
  const skill = await saveViaApi(page.request, w, await seedRun(w, productionId, w.me.id));
  /* The list can't be read until Try again: every read fails till then. (The view is drawn again once the project
     is known, and reads again; a single failed read would be read over before it could be seen.) */
  let unreadable = true;
  await page.route("**/api/atomik/skills**", (route) => {
    const url = new URL(route.request().url());
    if (unreadable && route.request().method() === "GET" && url.pathname === "/api/atomik/skills" && !url.searchParams.has("runs"))
      return route.fulfill({ status: 500, json: { error: "Skills could not be loaded." } });
    return route.fallback();
  });
  await openSkillsPage(page, productionId);
  const view = page.getByTestId("skills-view");
  /* Drawn for this project: its runs are offered for saving. */
  await expect(view.getByTestId("skills-runs")).toContainText("Atomik runs in this project");
  await expect(view.getByTestId("skills-error")).toContainText("Skills could not be loaded.");
  await expect(view.getByTestId("skills-error-retry")).toHaveText("Try again");
  unreadable = false;
  await view.getByTestId("skills-error-retry").click();
  const row = view.getByTestId("skill-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("/wave-runner-spot");
  await expect(row.getByTestId("skill-scope")).toHaveText("Workspace");
  await expect(row.getByTestId("skill-meta")).toContainText("2 steps");
  await expect(row.getByTestId("skill-meta")).toContainText("Made by you");
  /* Search narrows by name or command. */
  await view.getByTestId("skills-search").fill("/nothing-like-it");
  await expect(view.getByTestId("skills-empty")).toContainText("No skill matches");
  await view.getByTestId("skills-search").fill("wave");
  await expect(row).toHaveCount(1);
  await floors(page, '[data-testid="skills-view"]', phone);
  await clearOfTabBar(page, '[data-testid="skills-view"]');
  await shot(page, "skills-list");

  await row.getByTestId("skill-open").click();
  const detail = page.getByTestId("skill-detail");
  await expect(detail.getByTestId("skill-version")).toHaveText("Version 1");
  await expect(detail.getByTestId("skill-template").getByTestId("skill-step")).toHaveCount(2);
  await expect(detail.getByTestId("skill-template").getByTestId("skill-parameter-default")).toHaveText(["Wave Runner sneakers", "beach at sunset"]);
  await floors(page, '[data-testid="skill-detail"]', phone);

  /* Edit: the next version. */
  await detail.getByTestId("skill-edit").click();
  const edit = detail.getByTestId("skill-edit-form");
  await edit.getByTestId("skill-edit-name").fill("Wave Runner launch spot");
  await edit.getByTestId("skill-edit-step-prompt").first().fill("Studio still of teal {{product}} on a seamless, {{setting}}, soft top light.");
  await edit.getByTestId("skill-edit-note").fill("Seamless backdrop");
  await floors(page, '[data-testid="skill-detail"]', phone);
  await shot(page, "skills-edit");
  await edit.getByTestId("skill-edit-save").click();
  await expect(page.getByTestId("toast")).toContainText("Saved as version 2. Version 1 is kept.");
  await expect(detail.getByTestId("skill-version")).toHaveText("Version 2");
  await expect(detail.getByTestId("skill-name")).toHaveText("Wave Runner launch spot");
  await expect(detail.getByTestId("skill-template")).toContainText("on a seamless");
  const versions = detail.getByTestId("skill-version-row");
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText("Seamless backdrop");

  /* Version 1 is still there to read, exactly as it was saved. */
  await versions.nth(1).getByTestId("skill-version-view").click();
  const old = detail.getByTestId("skill-old-version");
  await expect(old.getByTestId("skill-version-meta")).toContainText("Version 1");
  await expect(detail.getByTestId("skill-version-template")).toContainText("on wet sand");
  await expect(detail.getByTestId("skill-version-template")).not.toContainText("on a seamless");
  await floors(page, '[data-testid="skill-detail"]', phone);
  await shot(page, "skills-version-1");
  await detail.getByTestId("skill-version-back").click();

  /* Archive asks first; the skill leaves the list and `/`; restore brings it back as it was. */
  await detail.getByTestId("skill-archive").click();
  await expect(detail.getByText(/Archive \/wave-runner-spot\?/)).toBeVisible();
  await floors(page, '[data-testid="skill-detail"]', phone);
  await detail.getByTestId("skill-archive-confirm").click();
  await expect(page.getByTestId("toast")).toContainText("is archived");
  await expect(detail.getByTestId("skill-archived")).toBeVisible();
  await detail.getByTestId("skill-back").click();
  await view.getByTestId("skills-search").fill("");
  await expect(view.getByTestId("skill-row")).toHaveCount(0);
  const listed = await page.request.get("/api/atomik/skills", { headers: w.headers });
  expect(((await listed.json()) as { skills: unknown[] }).skills).toEqual([]);
  await view.getByTestId("skills-show-archived").click();
  await expect(view.getByTestId("skill-row")).toHaveCount(1);
  await view.getByTestId("skill-row").getByTestId("skill-open").click();
  await detail.getByTestId("skill-restore").click();
  await expect(page.getByTestId("toast")).toContainText("is back");
  await expect(detail.getByTestId("skill-archived")).toHaveCount(0);
  await expect(detail.getByTestId("skill-version")).toHaveText("Version 2");
  await expect(detail.getByTestId("skill-version-row")).toHaveCount(2);
  const kept = (await books(w)).versions.filter((v) => v.skill === skill.id);
  expect(kept.map((v) => v.version)).toEqual([1, 2]);
  expect(kept[0].template).toContain("on wet sand");
  await floors(page, '[data-testid="skill-detail"]', phone);
  await clearOfTabBar(page, '[data-testid="skill-detail"]');
  expect(w.errors).toEqual([]);
});

test("a teammate sees the workspace's skill and runs it, but never another person's personal skill", async ({ page, browser }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(240_000);
  const phone = PHONES.includes(info.project.name);
  const owner = await browser.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551" });
  try {
    const joined = await joinLocallyAsMember(owner.request, page.request);
    const ownerPage = await owner.newPage();
    const o = await signedIn(ownerPage, owner.request, joined);
    const m = await signedIn(page, page.request, joined);
    const productionId = await production(owner.request);
    const chatId = await seedRun(o, productionId, o.me.id);
    await saveViaApi(owner.request, o, chatId);
    const mine = await saveViaApi(owner.request, o, chatId, { name: "My private look", slug: "private-look", scope: "personal", description: "Only its maker sees this." });
    await ownerPage.close();

    await openSkillsPage(page, productionId);
    const view = page.getByTestId("skills-view");
    const rows = view.getByTestId("skill-row");
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute("data-slug", "wave-runner-spot");
    await expect(rows.getByTestId("skill-meta")).not.toContainText("Made by you");
    await expect(view).not.toContainText("private-look");
    /* Not listed, not readable, not runnable: the personal skill reads as gone. */
    for (const reply of [
      await page.request.get(`/api/atomik/skills/${mine.id}`, { headers: m.headers }),
      await page.request.post(`/api/atomik/skills/${mine.id}/run`, { headers: m.headers, data: { dryRun: true } }),
      await page.request.patch(`/api/atomik/skills/${mine.id}`, { headers: m.headers, data: { action: "archive" } }),
    ]) {
      expect(reply.status()).toBe(404);
      expect(await reply.json()).toEqual({ error: "That skill is gone." });
    }
    /* `/` in the composer lists the workspace's skill for the teammate, and only it. */
    const listed = await page.request.get("/api/atomik/skills", { headers: m.headers });
    expect(((await listed.json()) as { skills: { slug: string }[] }).skills.map((s) => s.slug)).toEqual(["wave-runner-spot"]);
    /* The teammate may open it; only its maker changes who sees it. */
    await rows.getByTestId("skill-open").click();
    const detail = page.getByTestId("skill-detail");
    await expect(detail.getByTestId("skill-provenance")).not.toContainText("Made by you");
    await detail.getByTestId("skill-edit").click();
    await expect(detail.getByTestId("skill-edit-form")).toContainText("Only the person who made it changes who sees it.");
    await expect(detail.getByTestId("skill-edit-scope-personal")).toHaveCount(0);
    await floors(page, '[data-testid="skill-detail"]', phone);
    await clearOfTabBar(page, '[data-testid="skill-detail"]');
    expect(m.errors).toEqual([]);
  } finally {
    await owner.close();
  }
});

test("the Skills page runs a skill with new words: planning is free, and its first step waits for Continue at its quote", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(300_000);
  const phone = PHONES.includes(info.project.name);
  const w = await signedIn(page);
  const productionId = await production(page.request);
  await saveViaApi(page.request, w, await seedRun(w, productionId, w.me.id));
  const generated: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate") generated.push(request.postDataJSON() as Record<string, unknown>); });
  await openSkillsPage(page, productionId);
  await page.getByTestId("skill-row").getByTestId("skill-open").click();
  const detail = page.getByTestId("skill-detail");
  await detail.getByTestId("skill-run").click();
  const card = detail.getByTestId("skill-run-card");
  const form = card.getByTestId("skill-run-form");
  await form.getByTestId("skill-param-product").fill("Canvas slip-ons");
  /* An empty parameter is asked for, never guessed. */
  await form.getByTestId("skill-param-setting").fill("");
  await expect(form.getByTestId("skill-param-empty")).toHaveText("Fill in Setting.");
  await expect(form.getByTestId("skill-plan")).toBeDisabled();
  /* A value stands where its phrase stood, word for word: "beach at sunset" follows "a" in the skate pass. */
  await form.getByTestId("skill-param-setting").fill("harbour wall at noon");
  await expect(form.getByTestId("skill-run-step")).toHaveCount(2);
  await expect(form.getByTestId("skill-run-price").first()).toHaveText(/^about \d+ cr$/);
  await floors(page, '[data-testid="skill-detail"]', phone);
  await clearOfTabBar(page, '[data-testid="skill-detail"]');
  await shot(page, "skills-page-run");
  await form.getByTestId("skill-plan").click();

  /* Filed in Atomik as proposals: each waits here, at the checkpoint, for a live quote and Continue. */
  const approval = card.getByTestId("skill-run-approval");
  await expect(approval.getByTestId("skill-plan-step")).toHaveCount(2, { timeout: 30_000 });
  await expect(approval.getByTestId("skill-plan-step").first()).toHaveAttribute("data-status", "proposed");
  const go = approval.getByTestId("skill-continue");
  await expect(go).toHaveText(/^Continue · about \d+ cr$/, { timeout: 60_000 });
  const quoted = creditsIn(await go.textContent());
  expect(generated).toEqual([]);
  const planned = (await books(w)).steps.filter((s) => s.status === "proposed");
  expect(planned.map((s) => s.prompt)).toEqual([
    "Studio still of teal Canvas slip-ons on wet sand, harbour wall at noon, warm backlight.",
    "A skater rolls along a harbour wall at noon in teal Canvas slip-ons, low wide tracking shot.",
  ]);
  await floors(page, '[data-testid="skill-detail"]', phone);
  await shot(page, "skills-page-checkpoint");

  const rendered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/generate", { timeout: 60_000 });
  await go.click();
  expect((await rendered).status()).toBe(200);
  expect(generated).toHaveLength(1);
  expect(generated[0]).toMatchObject({ model: NANO, maxCredits: quoted, refine: false, projectId: productionId });
  await expect(approval.getByTestId("skill-plan-step").first()).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  /* The next step waits for its own Continue: nothing else ran. */
  await expect(approval.getByTestId("skill-plan-step").nth(1)).toHaveAttribute("data-status", "proposed");
  await expect(approval.getByTestId("skill-continue")).toBeVisible({ timeout: 60_000 });
  expect(generated).toHaveLength(1);
  const after = await books(w);
  expect(after.takes).toHaveLength(1);
  expect((after.charges.find((c) => c.id === after.takes[0].id)?.credits ?? 0)).toBeLessThanOrEqual(quoted);
  await floors(page, '[data-testid="skill-detail"]', phone);
  await clearOfTabBar(page, '[data-testid="skill-detail"]');
  expect(w.errors).toEqual([]);
});
