import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { newProject, type Asset, type Project } from "../lib/workbench/studio";

/**
 * One project draft, several editors at once (the Rig, the Studio stages, Edit &
 * Sound, Marketing, the Gen composer, a second tab). A save another save beat
 * is merged into the newer version (lib/workbench/merge.ts) and saved again:
 * both sides' edits are kept, no id appears twice, nothing is lost — whichever
 * save lands first, and when a reply is lost. Runs against the local
 * ENGINE_MOCK server; nothing here is billed.
 */

const DESKTOP = "workbench-1440x900";
type Node = Project["nodes"][number];
type Read = { project: Project; revision: number };

const png = async (fill: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${fill}"/></svg>`)).png().toBuffer();
const hydrated = (target: Locator) => expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 60_000 }).toBe(true);
const scene = (id: string, extra: Partial<Node> = {}) => ({ id, title: id, type: "scene", x: 0, y: 0, width: 238, linked: [], role: "Director", status: "draft", mode: "Video", durationS: 5, ratio: "16:9", resolution: "720p", ...extra }) as Node;
const ids = (list: { id: string }[]) => list.map((item) => item.id);
const repeated = (list: string[]) => list.filter((id, i) => list.indexOf(id) !== i);
const noteOf = (node: Node | undefined) => ((node as unknown as { operations?: { kind: string; values: { note?: string } }[] } | undefined)?.operations ?? []).find((op) => op.kind === "direction")?.values.note ?? null;
const strip = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function latch() { let open: () => void = () => {}; const opened = new Promise<void>((resolve) => { open = resolve; }); return { opened, open }; }

async function setup(page: Page, shape: (p: Project) => void) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${account.workspace.id}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Draft merge", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Merge ${randomUUID().slice(0, 6)}`);
  project.brief = "A fox crosses a frozen harbour at dusk.";
  shape(project);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const read = async (): Promise<Read> => page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json());
  const put = (p: Project, revision: number) => page.request.put("/api/workbench/projects", { headers, data: { project: p, revision } });
  /** Another window saves: `edit` is applied to the latest version and written at its revision. */
  const elsewhere = async (edit: (p: Project) => void) => {
    const now = await read();
    const next = structuredClone(now.project);
    edit(next);
    const answer = await put(next, now.revision);
    expect(answer.ok(), await answer.text()).toBe(true);
  };
  return { project, scope, headers, errors, read, put, elsewhere };
}

/** Every draft PUT of a page: the revision it was built on and how the server answered. */
function watchSaves(page: Page) {
  const saves: { base: number; status?: number; code?: string; body: Project | null }[] = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT" || new URL(request.url()).pathname !== "/api/workbench/projects") return;
    let body: { revision?: number; project?: Project } | null = null;
    try { body = request.postDataJSON(); } catch { body = null; }
    const entry = { base: Number(body?.revision), body: body?.project ?? null } as (typeof saves)[number];
    saves.push(entry);
    void request.response().then(async (response) => {
      if (!response) return;
      entry.status = response.status();
      entry.code = (await response.json().catch(() => null))?.code;
    }).catch(() => {});
  });
  return saves;
}

/** Anything that says a save was refused, reloaded or not saved, even for a moment. */
async function watchRefusals(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __refusals: string[] }).__refusals = seen;
    const look = () => {
      const text = document.body?.innerText ?? "";
      for (const phrase of ["changed elsewhere", "changed in another window", "reloaded the saved version", "Not saved", "Save unconfirmed", "A newer version exists"])
        if (text.includes(phrase) && !seen.includes(phrase)) seen.push(phrase);
    };
    const start = () => new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
  });
  return () => page.evaluate(() => (window as unknown as { __refusals?: string[] }).__refusals ?? []);
}

async function openRig(page: Page, project: Project) {
  await page.goto(`/suites?suite=studio&page=rig&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  const row = page.locator(".pxw-rig-row").first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await hydrated(row);
  await expect(page.getByTestId("rig-list")).toHaveAttribute("data-save-state", "saved", { timeout: 60_000 });
}
async function controls(page: Page) {
  const tabs = page.getByRole("group", { name: "Inspector tabs" });
  if (await tabs.getByRole("button", { name: /Controls/ }).count()) await tabs.getByRole("button", { name: /Controls/ }).click();
}
const directionNote = (page: Page) => page.getByRole("textbox", { name: "Direction note" });
const rigSaved = (page: Page) => expect(page.getByTestId("rig-list")).toHaveAttribute("data-save-state", "saved", { timeout: 60_000 });
const UNDO = process.platform === "darwin" ? "Meta+z" : "Control+z";
const castEntry = (p: Project) => { p.production = { cast: { entries: [{ id: "cast-1", kind: "character", name: "Mara", description: "", prompt: "", takes: [] }] } as NonNullable<Project["production"]>["cast"] }; };

/** Every toast the page shows, in order. */
async function watchToasts(page: Page) {
  const seen: string[] = [];
  await page.exposeFunction("__mergeToast", (text: string) => { seen.push(text); });
  await page.addInitScript(() => {
    const shown = new Set<string>();
    const look = () => { const text = document.querySelector('[data-testid="toast"]')?.textContent ?? ""; if (text && !shown.has(text)) { shown.add(text); (window as unknown as { __mergeToast: (t: string) => void }).__mergeToast(text); } };
    const start = () => new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
  });
  return seen;
}

/**
 * Arms the page's next PUT: it reaches the server and lands; another window
 * then reads what landed and saves `edit` on top of it; then the page's reply
 * is lost. `other` holds what that window saved.
 */
async function loseNextReply(page: Page, read: () => Promise<Read>, put: (p: Project, revision: number) => Promise<{ ok(): boolean; text(): Promise<string> }>, edit: (landed: Project) => Project) {
  const state = { armed: false, landed: null as Project | null, other: null as Project | null };
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
    if (route.request().method() !== "PUT" || !state.armed) return route.continue();
    state.armed = false;
    await route.fetch();
    const now = await read();
    state.landed = structuredClone(now.project);
    state.other = edit(structuredClone(now.project));
    const answer = await put(state.other, now.revision);
    expect(answer.ok(), await answer.text()).toBe(true);
    return route.abort("internetdisconnected");
  });
  return state;
}

/** Another project in the same workspace (the plan allows several), and reads of any project. */
async function more(page: Page, headers: Record<string, string>) {
  const account = await page.request.get("/api/me").then((r) => r.json()) as { workspace?: { id?: string } };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { if (account.workspace?.id) await platform.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [account.workspace.id] }); } finally { platform.close(); }
  const create = async (name: string, shape: (p: Project) => void) => {
    const p = newProject(name);
    shape(p);
    const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: p, revision: 0 } });
    expect(saved.ok(), await saved.text()).toBe(true);
    return p;
  };
  const readOf = async (id: string): Promise<Read> => page.request.get(`/api/workbench/projects?id=${id}`, { headers }).then((r) => r.json());
  const elsewhereOn = async (id: string, edit: (p: Project) => void) => {
    const now = await readOf(id);
    const next = structuredClone(now.project);
    edit(next);
    const answer = await page.request.put("/api/workbench/projects", { headers, data: { project: next, revision: now.revision } });
    expect(answer.ok(), await answer.text()).toBe(true);
  };
  const canvasOf = async (productionId: string) => (await page.request.get(`/api/workbench/team-canvas?productionId=${encodeURIComponent(productionId)}`, { headers }).then((r) => r.json())) as { canvas: { nodes: Record<string, Node> } | null };
  return { create, readOf, elsewhereOn, canvasOf };
}
async function pick(page: Page, name: string) {
  await page.getByTestId("project-switcher").click();
  await page.getByRole("listbox", { name: "Projects" }).getByRole("option", { name: new RegExp(name) }).click();
}

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== DESKTOP, "one desktop");
  test.setTimeout(240_000);
});

/* ── The Rig and a Studio stage, whichever save lands first ─────────────── */

for (const race of ["the Rig's save lands second", "the stage's save lands second"] as const) {
  test(`Rig, then Cast (${race}): the Rig's note and the Cast edit are both saved`, async ({ page }) => {
    const { project, errors, read } = await setup(page, (p) => {
      p.nodes = [scene("n1", { title: "Opening" })];
      p.production = { cast: { entries: [{ id: "cast-1", kind: "character", name: "Mara", description: "", prompt: "", takes: [] }] } as NonNullable<Project["production"]>["cast"] };
    });
    const refusals = await watchRefusals(page);
    const saves = watchSaves(page);
    const NOTE = `Rig note ${randomUUID().slice(0, 8)}`, DESCRIPTION = `A deckhand ${randomUUID().slice(0, 8)}`;
    const carries = (body: Project | null) => ({ rig: JSON.stringify(body?.nodes ?? []).includes(NOTE), cast: JSON.stringify(body?.production ?? {}).includes(DESCRIPTION) });
    const castEdited = latch(), castSaved = latch(), rigSavedFirst = latch();
    page.on("response", (response) => {
      if (response.request().method() !== "PUT" || new URL(response.url()).pathname !== "/api/workbench/projects" || response.status() !== 200) return;
      let body: Project | null = null;
      try { body = (response.request().postDataJSON() as { project: Project }).project; } catch { body = null; }
      const c = carries(body);
      if (c.cast) castSaved.open();
      if (c.rig && !c.cast) rigSavedFirst.open();
    });
    /* Hold the saves so the intended one is the one another save beats. */
    await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
      const request = route.request();
      if (request.method() !== "PUT") return route.continue();
      const c = carries((request.postDataJSON() as { project: Project }).project);
      if (race === "the Rig's save lands second" && c.rig && !c.cast) await Promise.race([castSaved.opened, sleep(15_000)]);
      if (race === "the stage's save lands second") {
        if (c.rig && !c.cast) await Promise.race([castEdited.opened, sleep(15_000)]);
        if (c.cast && !c.rig) await Promise.race([rigSavedFirst.opened, sleep(15_000)]);
      }
      await route.continue().catch(() => {});
    });

    await openRig(page, project);
    await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
    await controls(page);
    await hydrated(directionNote(page));
    await directionNote(page).fill(NOTE);
    /* Straight to Cast, the Rig's edit not yet saved. */
    await strip(page, /Cast/).click();
    const description = page.getByLabel("Mara description");
    await expect(description).toBeVisible({ timeout: 60_000 });
    await hydrated(description);
    await description.fill(DESCRIPTION);
    castEdited.open();

    await expect.poll(async () => {
      const p = (await read()).project;
      return { rig: noteOf(p.nodes.find((n) => n.id === "n1")), cast: p.production?.cast?.entries[0]?.description };
    }, { timeout: 45_000 }).toEqual({ rig: NOTE, cast: DESCRIPTION });
    await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 20_000 });
    /* The save another save beat was merged, not refused. */
    const loser = race === "the Rig's save lands second" ? (s: (typeof saves)[number]) => carries(s.body).rig && !carries(s.body).cast : (s: (typeof saves)[number]) => carries(s.body).cast && !carries(s.body).rig;
    expect(saves.some((s) => s.status === 409 && s.code === "revision_conflict" && loser(s)), "the intended save was beaten").toBe(true);

    /* Settled, and back in the Rig: its note is there and nothing older is put back. */
    await page.waitForTimeout(2500);
    await strip(page, /Rig$/).click();
    await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
    await controls(page);
    await expect(directionNote(page)).toHaveValue(NOTE);
    await rigSaved(page);
    const final = (await read()).project;
    expect({ rig: noteOf(final.nodes.find((n) => n.id === "n1")), cast: final.production?.cast?.entries[0]?.description }).toEqual({ rig: NOTE, cast: DESCRIPTION });
    expect(final.production?.cast?.entries.map((e) => e.id)).toEqual(["cast-1"]);
    expect(await refusals()).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const gate of ["the cut's save lands first", "the Rig's save lands first"] as const) {
  test(`Rig, then Edit & Sound (${gate}): the note and the take on the cut are both saved`, async ({ page }) => {
    const { project, errors, read } = await setup(page, (p) => {
      p.nodes = [scene("n1", { title: "Opening", operations: [{ id: "op-n1", kind: "direction", enabled: true, values: { note: "Hold still." } }] } as Partial<Node>)];
    });
    const refusals = await watchRefusals(page);
    const saves = watchSaves(page);
    /* A take to cut with: an upload filed through the Rig, saved before the timed part. */
    await openRig(page, project);
    await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
    await page.getByTestId("rig-prompt-attach-file").setInputFiles({ name: "blocking.png", mimeType: "image/png", buffer: await png("#224466") });
    await expect(page.getByTestId("rig-prompt-attach-note")).toContainText("blocking.png is an input of Opening", { timeout: 30_000 });
    await expect.poll(async () => (await read()).project.assets.some((a) => a.name === "blocking.png"), { timeout: 30_000 }).toBe(true);
    await rigSaved(page);
    const take = (await read()).project.assets.find((a) => a.name === "blocking.png")!;

    const NOTE = `Rig note ${randomUUID().slice(0, 8)}`;
    let held = false;
    const released = latch();
    await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
      const request = route.request();
      if (request.method() !== "PUT") return route.continue();
      const body = (request.postDataJSON() as { project: Project }).project;
      if (!held && JSON.stringify(body.nodes).includes(NOTE) && body.shots.length === 0) {
        held = true;
        await Promise.race([released.opened, sleep(15_000)]);
      }
      await route.continue().catch(() => {});
    });
    await controls(page);
    await directionNote(page).fill(NOTE);
    await strip(page, /Edit & Sound/).click();
    await expect(page.getByTestId("page-title")).toHaveText("Edit & Sound");
    const add = page.getByTestId("timeline-add").first();
    await expect(add).toBeVisible({ timeout: 60_000 });
    await hydrated(add);
    if (gate === "the Rig's save lands first") {
      released.open();
      await expect.poll(() => saves.some((s) => s.status === 200 && JSON.stringify(s.body?.nodes ?? []).includes(NOTE) && s.body?.shots.length === 0), { timeout: 20_000 }).toBe(true);
    }
    await add.click();
    await expect(page.getByTestId("timeline-shot")).toHaveCount(1);
    if (gate === "the cut's save lands first") {
      await expect.poll(() => saves.some((s) => s.status === 200 && s.body?.shots.length === 1), { timeout: 20_000 }).toBe(true);
      released.open();
    }

    await expect.poll(async () => {
      const p = (await read()).project;
      return { note: noteOf(p.nodes.find((n) => n.id === "n1")), shots: p.shots.map((s) => s.assetId) };
    }, { timeout: 45_000 }).toEqual({ note: NOTE, shots: [take.id] });
    expect(saves.some((s) => s.status === 409 && s.code === "revision_conflict"), "one save was beaten and merged").toBe(true);
    await page.waitForTimeout(2500);
    const settled = (await read()).project;
    expect({ note: noteOf(settled.nodes.find((n) => n.id === "n1")), shots: settled.shots.length, linked: settled.nodes.find((n) => n.id === "n1")!.linked.length }).toEqual({ note: NOTE, shots: 1, linked: 1 });
    expect(repeated(ids(settled.nodes))).toEqual([]);
    expect(repeated(ids(settled.assets))).toEqual([]);
    await strip(page, /Rig$/).click();
    await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
    await controls(page);
    await expect(directionNote(page)).toHaveValue(NOTE);
    await rigSaved(page);
    expect(await refusals()).toEqual([]);
    expect(errors).toEqual([]);
  });
}

/* ── Two windows on one stage ───────────────────────────────────────────── */

test("two windows on Cast: each window's edit is kept, and a window that saves after the other shows both", async ({ page, context }) => {
  const { project, read } = await setup(page, (p) => {
    p.production = { cast: { entries: [
      { id: "cast-1", kind: "character", name: "Mara", description: "", prompt: "", takes: [] },
      { id: "cast-2", kind: "character", name: "Tom", description: "The harbour master", prompt: "", takes: [] },
    ] } as NonNullable<Project["production"]>["cast"] };
  });
  const b = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`A: ${e.message}`));
  b.on("pageerror", (e) => errors.push(`B: ${e.message}`));
  const savesA = watchSaves(page), savesB = watchSaves(b);
  const url = `/suites?suite=studio&page=cast&sp=cast&project=${project.id}`;
  const maraDescription = (p: Page) => p.getByRole("textbox", { name: "Mara description", exact: true });
  const maraPrompt = (p: Page) => p.getByRole("textbox", { name: "Mara prompt", exact: true });
  const tomPrompt = (p: Page) => p.getByRole("textbox", { name: "Tom prompt", exact: true });
  for (const [tab, field] of [[page, maraDescription(page)], [b, tomPrompt(b)]] as const) {
    await tab.goto(url);
    await expect(tab.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
    await expect(tab.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 60_000 });
    await hydrated(field);
  }

  /* A saves; B, never reloaded, edits another entry; then A again, from its own older copy. */
  const D1 = "A fox-eyed deckhand.", D2 = "A fox-eyed deckhand, twenty, always cold.", PROMPT = "An old harbour master in an oilskin coat.";
  await maraDescription(page).fill(D1);
  await expect.poll(async () => (await read()).project.production?.cast?.entries[0]?.description, { timeout: 20_000 }).toBe(D1);
  await tomPrompt(b).fill(PROMPT);
  await expect.poll(async () => (await read()).project.production?.cast?.entries.map((e) => [e.description, e.prompt]), { timeout: 20_000 }).toEqual([[D1, ""], ["The harbour master", PROMPT]]);
  await expect(b.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 20_000 });
  /* B's save merged A's: B now shows A's description too. */
  await expect(maraDescription(b)).toHaveValue(D1);
  await maraDescription(page).fill(D2);
  await expect.poll(async () => (await read()).project.production?.cast?.entries.map((e) => [e.id, e.name, e.description, e.prompt]), { timeout: 20_000 })
    .toEqual([["cast-1", "Mara", D2, ""], ["cast-2", "Tom", "The harbour master", PROMPT]]);
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 20_000 });
  await expect(tomPrompt(page)).toHaveValue(PROMPT);
  expect(savesB.some((s) => s.status === 409 && s.code === "revision_conflict"), "B's stale save was beaten and merged").toBe(true);
  expect(savesA.some((s) => s.status === 409 && s.code === "revision_conflict"), "A's second save was beaten and merged").toBe(true);

  /* Both at once, on the same entry: each window's field survives. */
  const DESCRIPTION = "Salt in her hair.", MARA_PROMPT = "A young deckhand in a wool cap, breath fogging.";
  await Promise.all([maraDescription(page).fill(DESCRIPTION), maraPrompt(b).fill(MARA_PROMPT)]);
  await expect.poll(async () => { const e = (await read()).project.production?.cast?.entries[0]; return [e?.description, e?.prompt]; }, { timeout: 25_000 }).toEqual([DESCRIPTION, MARA_PROMPT]);
  await page.waitForTimeout(2000);
  const settled = (await read()).project.production!.cast!.entries;
  expect(settled.map((e) => [e.id, e.description, e.prompt])).toEqual([["cast-1", DESCRIPTION, MARA_PROMPT], ["cast-2", "The harbour master", PROMPT]]);
  for (const tab of [page, b]) await expect(tab.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 20_000 });
  expect(errors).toEqual([]);
});

/* ── Things made while another save lands: made once, kept, with their id ─ */

test("+ Add shot after another window saved: one new shot, with the id the Rig showed, its prompt, and the other window's edits — on the canvas too", async ({ page }) => {
  const { project, errors, read, elsewhere, headers } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" })]; });
  const refusals = await watchRefusals(page);
  const saves = watchSaves(page);
  await openRig(page, project);
  /* Another window (a Studio stage) edits the brief and adds a scene to the Rig's canvas. */
  await elsewhere((p) => { p.brief += " Changed elsewhere."; p.nodes.push(scene("elsewhere-1", { title: "From Brief", x: 400 })); });
  await page.getByRole("button", { name: "+ Add shot" }).click();
  const made = page.locator(".pxw-rig-row[aria-pressed='true']");
  await expect(made).toHaveCount(1);
  const id = (await made.getAttribute("data-shot-id"))!;
  expect(id).not.toBe("n1");
  await page.getByTestId("rig-prompt-input").fill("Typed into the new shot");
  await rigSaved(page);
  await expect.poll(async () => (await read()).project.nodes.map((n) => [n.id, n.text ?? ""]), { timeout: 30_000 }).toEqual([["n1", ""], [id, "Typed into the new shot"], ["elsewhere-1", ""]]);
  expect(saves.some((s) => s.status === 409 && s.code === "revision_conflict"), "the Rig's save was beaten and merged").toBe(true);
  const saved = (await read()).project;
  expect(saved.brief).toContain("Changed elsewhere.");
  /* The Rig shows what the merge brought in, and the shot it made is still the one selected. */
  await expect(page.locator(".pxw-rig-row[data-shot-id='elsewhere-1']")).toHaveCount(1);
  await expect(page.locator(".pxw-rig-row[aria-pressed='true']")).toHaveAttribute("data-shot-id", id);
  /* The team canvas agrees with the draft: the same shot by the same id, and the other window's scene. */
  await expect.poll(async () => {
    const canvas = await page.request.get(`/api/workbench/team-canvas?productionId=${encodeURIComponent(saved.productionProjectId!)}`, { headers }).then((r) => r.json()) as { canvas: { nodes: Record<string, Node> } | null };
    return { ids: Object.keys(canvas.canvas?.nodes ?? {}).sort(), text: canvas.canvas?.nodes[id]?.text };
  }, { timeout: 15_000 }).toEqual({ ids: ["elsewhere-1", "n1", id].sort(), text: "Typed into the new shot" });
  /* Reopened: the same three shots, no duplicate joins from the canvas. */
  await page.reload();
  await expect(page.locator(".pxw-rig-row[data-shot-id='n1']")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await rigSaved(page);
  expect(await page.locator(".pxw-rig-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-shot-id")))).toEqual(["n1", id, "elsewhere-1"]);
  expect(ids((await read()).project.nodes)).toEqual(["n1", id, "elsewhere-1"]);
  expect(await refusals()).toEqual([]);
  expect(errors).toEqual([]);
});

test("an input attached after another window saved is one input on the shot, in the draft and on the team canvas", async ({ page }) => {
  const { project, errors, read, elsewhere, headers } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" })]; });
  const saves = watchSaves(page);
  await openRig(page, project);
  await elsewhere((p) => { p.brief += " Changed elsewhere."; });
  await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await page.getByTestId("rig-prompt-attach-file").setInputFiles({ name: "blocking.png", mimeType: "image/png", buffer: await png("#224466") });
  await expect(page.getByTestId("rig-prompt-attach-note")).toContainText("blocking.png is an input of Opening", { timeout: 30_000 });
  await rigSaved(page);
  await expect.poll(async () => (await read()).project.nodes.find((n) => n.id === "n1")?.linked.length ?? 0, { timeout: 30_000 }).toBe(1);
  expect(saves.some((s) => s.status === 409 && s.code === "revision_conflict")).toBe(true);
  await page.waitForTimeout(2000);
  const saved = (await read()).project;
  expect(saved.brief).toContain("Changed elsewhere.");
  const linked = saved.nodes.find((n) => n.id === "n1")!.linked;
  expect(saved.nodes.filter((n) => n.type === "media").map((n) => n.id)).toEqual(linked);
  const canvas = await page.request.get(`/api/workbench/team-canvas?productionId=${encodeURIComponent(saved.productionProjectId!)}`, { headers }).then((r) => r.json()) as { canvas: { nodes: Record<string, Node> } | null };
  expect(canvas.canvas?.nodes.n1?.linked).toEqual(linked);
  expect(Object.values(canvas.canvas?.nodes ?? {}).filter((n) => n.type === "media").map((n) => n.id)).toEqual(linked);
  await page.reload();
  await expect(page.locator(".pxw-rig-row[data-shot-id='n1']")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await rigSaved(page);
  const reopened = (await read()).project;
  expect(reopened.nodes.filter((n) => n.type === "media").map((n) => n.id)).toEqual(linked);
  expect(repeated(ids(reopened.nodes))).toEqual([]);
  expect(errors).toEqual([]);
});

test("+ Character after another window saved: the typed name is saved, once, beside the other window's edit", async ({ page }) => {
  const { project, errors, read, elsewhere } = await setup(page, (p) => {
    p.production = { cast: { entries: [{ id: "cast-1", kind: "character", name: "Mara", description: "", prompt: "", takes: [] }] } as NonNullable<Project["production"]>["cast"] };
  });
  const refusals = await watchRefusals(page);
  await page.goto(`/suites?suite=studio&page=cast&sp=cast&project=${project.id}`);
  await expect(page.getByTestId("cast-entry")).toHaveCount(1, { timeout: 60_000 });
  await hydrated(page.getByTestId("cast-add-character"));
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
  await elsewhere((p) => { p.brief = "Another window's brief"; });
  await page.getByTestId("cast-add-character").click();
  const name = page.getByTestId("cast-entry").nth(1).locator("input.pd-cast-name");
  await name.click();
  await name.pressSequentially("Nova", { delay: 60 });
  await expect.poll(async () => (await read()).project.production?.cast?.entries.map((e) => e.name), { timeout: 30_000 }).toEqual(["Mara", "Nova"]);
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 20_000 });
  await page.waitForTimeout(2000);
  const saved = (await read()).project;
  expect(saved.brief).toBe("Another window's brief");
  expect(repeated(ids(saved.production!.cast!.entries))).toEqual([]);
  expect(await page.getByTestId("cast-entry").locator("input.pd-cast-name").evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value))).toEqual(["Mara", "Nova"]);
  expect(await refusals()).toEqual([]);
  expect(errors).toEqual([]);
});

test("a plate filed by two tabs following the same render is filed once", async ({ page, context }) => {
  const jobId = `job-${randomUUID().slice(0, 8)}`;
  const { project, read } = await setup(page, (p) => {
    p.production = { environment: { world: "", model: "gemini-3.1-flash-image", entries: [{ id: "env-1", name: "Harbour", notes: "", prompt: "A frozen harbour at dusk", references: [], plates: [], pending: [{ jobId, at: new Date().toISOString() }] }] } } as NonNullable<Project["production"]>;
  });
  /* The finished render, as the jobs route will report it. */
  const account = await page.request.get("/api/me").then((r) => r.json());
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const genId = `render_${randomUUID().replaceAll("-", "")}`;
  try {
    const dbUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
    const tenant = createClient({ url: dbUrl });
    try {
      const pid = (await read()).project.productionProjectId!;
      await tenant.execute({ sql: "INSERT INTO generations(id,project_id,model,prompt,params,status,stored_url,kind,title,created_by,created_at,updated_at) VALUES(?,?,'gemini-3.1-flash-image','Harbour plate','{}','succeeded',?,'image','Harbour plate',?,200,200)", args: [genId, pid, `/api/media/${genId}`, account.id] });
    } finally { tenant.close(); }
  } finally { platform.close(); }

  const tabs: { page: Page; done: boolean; errors: string[] }[] = [];
  for (const tab of [page, await context.newPage()]) {
    const state = { page: tab, done: false, errors: [] as string[] };
    tab.on("pageerror", (e) => state.errors.push(e.message));
    await tab.route((url) => url.pathname === `/api/jobs/${jobId}`, (route) => route.fulfill({ json: { generation: { id: genId, status: state.done ? "succeeded" : "running" } } }));
    await tab.goto(`/suites?suite=studio&page=boards&sp=environment&project=${project.id}`);
    await expect(tab.getByTestId("environment-entry").first()).toBeVisible({ timeout: 60_000 });
    await hydrated(tab.getByTestId("environment-entry").first());
    await expect(tab.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
    tabs.push(state);
  }
  /* The render finishes: the first tab files it, then the second, from its older copy. */
  tabs[0].done = true;
  await expect.poll(async () => (await read()).project.production?.environment?.entries[0]?.plates.length ?? 0, { timeout: 30_000 }).toBe(1);
  const saves = watchSaves(tabs[1].page);
  tabs[1].done = true;
  /* Its save was beaten by the first tab's; merged, the plate is one plate. */
  await expect.poll(() => saves.some((s) => s.status === 409 && s.code === "revision_conflict"), { timeout: 30_000 }).toBe(true);
  await expect(tabs[1].page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  const entry = (await read()).project.production!.environment!.entries[0];
  expect(entry.plates.map((plate) => plate.assetId)).toEqual([genId]);
  expect((await read()).project.assets.filter((asset) => asset.id === genId)).toHaveLength(1);
  expect(entry.pending ?? []).toEqual([]);
  expect([...tabs[0].errors, ...tabs[1].errors]).toEqual([]);
});

/* ── Marketing after a Rig save ─────────────────────────────────────────── */

test("Marketing › Build storyboard after a Rig save keeps the Rig's input, and the storyboard", async ({ page }) => {
  const { project, errors, read, elsewhere } = await setup(page, (p) => {
    p.nodes = [scene("n1", { title: "Opening" })];
    p.production = { cast: { entries: [{ id: "cast-1", kind: "character", name: "Mara", description: "", prompt: "", takes: [] }] } as NonNullable<Project["production"]>["cast"] };
    p.moleculr = { ...EMPTY_MOLECULR, productName: "Still Water", hooks: ["Quiet mornings"], creative: { path: "template", category: "ugc", templateId: "ugc-faceless", direction: "", aspect: "9:16", seconds: 15 } };
  });
  const saves = watchSaves(page);
  await page.goto(`/workspace?project=${project.id}&suite=moleculr&page=marketing`);
  const tool = page.locator('[data-tool-body="marketing"]');
  await expect(tool).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".pxw-draft-status")).toHaveAttribute("data-save-state", "Saved", { timeout: 30_000 });
  /* The Rig, in another window, attaches an input to the opening shot and renames the cast. */
  const input: Asset = { id: `rig_${randomUUID().slice(0, 8)}`, name: "blocking.png", kind: "image", category: "Reference", url: "/campaign/hero.webp", mime: "image/png", description: "", prompt: "", status: "Draft", version: 1, locked: false, refs: [] } as Asset;
  await elsewhere((p) => {
    p.assets.push(input);
    p.nodes.push({ id: "rig-input", title: "blocking.png", type: "media", assetId: input.id, x: -300, y: 0, width: 220, linked: [] } as Node);
    p.nodes = p.nodes.map((n) => (n.id === "n1" ? { ...n, linked: ["rig-input"] } : n));
    p.production!.cast!.entries[0].name = "Mara Vey";
  });
  const toggle = tool.getByRole("button", { name: /Find the right expression/ });
  await toggle.scrollIntoViewIfNeeded();
  await hydrated(toggle);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  const build = tool.getByRole("button", { name: /Build editable storyboard/ });
  await expect(build).toBeEnabled({ timeout: 15_000 });
  await build.click();
  await expect.poll(async () => (await read()).project.moleculr?.variants.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator(".pxw-draft-status")).toHaveAttribute("data-save-state", "Saved", { timeout: 30_000 });
  expect(saves.some((s) => s.status === 409 && s.code === "revision_conflict"), "the storyboard's save was beaten and merged").toBe(true);
  await page.waitForTimeout(2000);
  const saved = (await read()).project;
  expect(saved.nodes.find((n) => n.id === "n1")?.linked).toEqual(["rig-input"]);
  expect(saved.nodes.some((n) => n.id === "rig-input")).toBe(true);
  expect(saved.assets.some((a) => a.id === input.id)).toBe(true);
  expect(saved.production?.cast?.entries[0]?.name).toBe("Mara Vey");
  for (const variant of saved.moleculr!.variants) expect(saved.nodes.some((n) => n.id === variant.nodeId), `variant ${variant.nodeId} has its node`).toBe(true);
  expect(repeated(ids(saved.nodes))).toEqual([]);
  expect(errors).toEqual([]);
});

/* ── A save whose reply was lost ────────────────────────────────────────── */

test("Rig: + Add shot whose reply was lost (and the check too) is saved once, with the next edit", async ({ page }) => {
  const { project, errors, read } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" })]; });
  let mode: "normal" | "drop-put" | "offline" = "normal";
  let offlineUntil = 0;
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
    const request = route.request();
    if (request.method() === "PUT" && mode === "drop-put") {
      mode = "offline";
      await route.fetch();
      offlineUntil = Date.now() + 3000;
      return route.abort("internetdisconnected");
    }
    /* The read and the check of that save are lost too, for a while. */
    if (mode === "offline" && Date.now() < offlineUntil && (request.method() === "POST" || new URL(request.url()).searchParams.get("id"))) return route.abort("internetdisconnected");
    return route.continue();
  });
  await openRig(page, project);
  mode = "drop-put";
  await page.getByRole("button", { name: "+ Add shot" }).click();
  /* The shot reached the server; this page never heard so. */
  await expect.poll(async () => (await read()).project.nodes.filter((n) => n.type === "scene").length, { timeout: 30_000 }).toBe(2);
  await page.waitForTimeout(3500);
  await controls(page);
  await directionNote(page).fill("After the lost reply");
  await rigSaved(page);
  await expect.poll(async () => JSON.stringify((await read()).project.nodes).includes("After the lost reply"), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(2000);
  const scenes = (await read()).project.nodes.filter((n) => n.type === "scene");
  expect(scenes).toHaveLength(2);
  expect(repeated(ids(scenes))).toEqual([]);
  expect(await page.locator(".pxw-rig-row").count()).toBe(2);
  expect(errors).toEqual([]);
});

test("Cast: + Character whose reply was lost after another save built on it is saved once", async ({ page }) => {
  const { project, errors, read, put } = await setup(page, (p) => {
    p.production = { cast: { entries: [{ id: "cast-1", kind: "character", name: "Mara", description: "", prompt: "", takes: [] }] } as NonNullable<Project["production"]>["cast"] };
  });
  let armed = false;
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
    const request = route.request();
    if (request.method() !== "PUT" || !armed) return route.continue();
    armed = false;
    await route.fetch();
    /* Another window saves on top of the one that just landed, then this reply is lost. */
    const now = await read();
    expect((await put({ ...now.project, brief: "Changed in another window" }, now.revision)).ok()).toBe(true);
    return route.abort("internetdisconnected");
  });
  await page.goto(`/suites?suite=studio&page=cast&sp=cast&project=${project.id}`);
  await expect(page.getByTestId("cast-entry")).toHaveCount(1, { timeout: 60_000 });
  await hydrated(page.getByTestId("cast-add-character"));
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
  armed = true;
  await page.getByTestId("cast-add-character").click();
  await expect(page.getByTestId("cast-entry")).toHaveCount(2);
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 45_000 });
  await page.waitForTimeout(2500);
  const saved = (await read()).project;
  expect(saved.production?.cast?.entries).toHaveLength(2);
  expect(repeated(ids(saved.production!.cast!.entries))).toEqual([]);
  expect(saved.brief).toBe("Changed in another window");
  await expect(page.getByTestId("cast-entry")).toHaveCount(2);
  expect(errors).toEqual([]);
});

/* ── Undo after a merge ─────────────────────────────────────────────────── */

test("⌘Z after deleting a shot another tab changed: the shot keeps that tab's note and input, once", async ({ page, context }) => {
  const { project, read } = await setup(page, (p) => {
    p.nodes = [
      scene("n1", { title: "Opening", text: "A fox on the ice.", operations: [{ id: "op1", kind: "direction", enabled: true, values: { note: "Original note" } }] } as Partial<Node>),
      scene("n2", { title: "Second", x: 400 }),
    ];
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`A: ${e.message}`));
  const saves = watchSaves(page);
  /* Tab A opens first and keeps the older n1. */
  await openRig(page, project);
  /* Tab B changes n1's note and gives it an input. */
  const b = await context.newPage();
  b.on("pageerror", (e) => errors.push(`B: ${e.message}`));
  await openRig(b, project);
  await b.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await controls(b);
  await directionNote(b).fill("Teammate note");
  await b.getByTestId("rig-prompt-attach-file").setInputFiles({ name: "teammate.png", mimeType: "image/png", buffer: await png("#224466") });
  await expect(b.getByTestId("rig-prompt-attach-note")).toContainText("teammate.png is an input of Opening", { timeout: 30_000 });
  await expect.poll(async () => { const n1 = (await read()).project.nodes.find((n) => n.id === "n1"); return [noteOf(n1), n1?.linked.length]; }, { timeout: 30_000 }).toEqual(["Teammate note", 1]);
  await rigSaved(b);
  const input = (await read()).project.nodes.find((n) => n.id === "n1")!.linked[0];
  await b.close();

  /* Tab A deletes n1 from its older copy: B changed it, so the merge keeps B's n1. */
  await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await page.getByTestId("rig-delete-shot").click();
  await rigSaved(page);
  await expect.poll(() => saves.some((s) => s.status === 409 && s.code === "revision_conflict"), { timeout: 30_000 }).toBe(true);
  await expect(page.locator(".pxw-rig-row[data-shot-id='n1']")).toHaveCount(1, { timeout: 30_000 });

  /* ⌘Z: nothing doubles, and B's note and input stay. */
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await page.waitForTimeout(1500);
  await rigSaved(page);
  await page.waitForTimeout(2000);
  const saved = (await read()).project;
  const n1 = saved.nodes.find((n) => n.id === "n1");
  expect(noteOf(n1)).toBe("Teammate note");
  expect(n1?.linked).toEqual([input]);
  expect(saved.nodes.some((n) => n.id === input)).toBe(true);
  expect(repeated(ids(saved.nodes))).toEqual([]);
  expect(await page.locator(".pxw-rig-row[data-shot-id='n1']").count()).toBe(1);
  await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await controls(page);
  await expect(directionNote(page)).toHaveValue("Teammate note");
  expect(errors).toEqual([]);
});

/* ── The Gen composer after a Brief edit ────────────────────────────────── */

test("Gen: two takes after a Brief edit elsewhere keep the Brief edit and both takes' shots", async ({ page }) => {
  const { project, errors, read, elsewhere, scope } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" })]; });
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const saves = watchSaves(page);
  const paid: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && ["/api/generate", "/api/audio"].includes(new URL(request.url()).pathname)) paid.push(request.url()); });
  await page.goto(`/suites?view=gen&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  await expect(page.getByTestId("gen-view")).toBeVisible();
  /* The page holds the project as it opened; the Brief is then written elsewhere. */
  await elsewhere((p) => { p.brief = "Written in Brief after Gen opened."; p.script = "EXT. HARBOUR - DUSK\n\nA fox crosses the ice.\n"; });
  const prompt = page.getByTestId("gen-prompt");
  await hydrated(prompt);
  await prompt.fill("A red fox crosses the frozen harbour at dusk.");
  await page.getByTestId("gen-takes").getByRole("button", { name: "More" }).click();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("2");
  const go = page.getByTestId("gen-generate");
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await expect(go).toHaveText(/\d cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => paid.length, { timeout: 60_000 }).toBe(2);
  await expect.poll(async () => (await read()).project.nodes.filter((n) => n.id !== "n1" && n.type === "scene").length, { timeout: 30_000 }).toBe(2);
  const saved = (await read()).project;
  expect(saved.brief).toBe("Written in Brief after Gen opened.");
  expect(saved.script).toContain("A fox crosses the ice.");
  const made = saved.nodes.filter((n) => n.id !== "n1");
  expect(made.map((n) => n.title)).toEqual(["A red fox crosses the frozen harbour at dusk. · take 1", "A red fox crosses the frozen harbour at dusk. · take 2"]);
  expect(ids(saved.nodes)[0]).toBe("n1");
  expect(repeated(ids(saved.nodes))).toEqual([]);
  for (const node of made) expect(saved.shotMappings?.[node.id], `${node.title} is mapped`).toBeTruthy();
  /* Never the page's copy with a newer revision: every save was built on what the server held. */
  expect(saves.filter((s) => s.status !== 200)).toEqual([]);
  expect(errors).toEqual([]);
});

/* ── Folded from the break hunts of 26 September ───────────────────────────
   A save whose reply was lost is checked on the server (never merged again
   over what another window built on it); what two windows make at once is
   made once; a merge is a save the server takes; the team canvas follows
   the draft field by field, across a project switch; and the Gen composer
   pays for a take once. */

test("Cast: a description whose reply was lost, then rewritten in another window, keeps that window's later text", async ({ page }) => {
  const { project, errors, read, put } = await setup(page, castEntry);
  const saves = watchSaves(page);
  const MINE = "A fox-eyed deckhand.", LATER = "Rewritten in another window after reading the deckhand line.";
  const lost = await loseNextReply(page, read, put, (landed) => {
    expect(landed.production!.cast!.entries[0].description).toBe(MINE);
    landed.production!.cast!.entries[0].description = LATER;
    return landed;
  });
  await page.goto(`/suites?suite=studio&page=cast&sp=cast&project=${project.id}`);
  const description = page.getByRole("textbox", { name: "Mara description", exact: true });
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 60_000 });
  await hydrated(description);
  lost.armed = true;
  await description.fill(MINE);
  await expect.poll(() => lost.other !== null, { timeout: 30_000 }).toBe(true);
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 45_000 });
  await page.waitForTimeout(2500);
  expect((await read()).project.production!.cast!.entries[0].description, JSON.stringify(saves.map((s) => [s.base, s.status]))).toBe(LATER);
  /* Checked, not sent again: the page shows what the server holds. */
  expect(saves.filter((s) => s.status === 200)).toEqual([]);
  await expect(description).toHaveValue(LATER);
  expect(errors).toEqual([]);
});

test("Cast: a description saved as the connection dropped, then rewritten on another device, keeps that device's text once this one reconnects", async ({ page }) => {
  const { project, errors, read, put } = await setup(page, castEntry);
  const MINE = "A fox-eyed deckhand.", LATER = "Rewritten on the other device while this laptop was offline.";
  let mode: "normal" | "drop-put" | "offline" = "normal", offlineUntil = 0;
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
    if (route.request().method() === "PUT" && mode === "drop-put") {
      mode = "offline";
      await route.fetch();
      offlineUntil = Date.now() + 3000;
      return route.abort("internetdisconnected");
    }
    if (mode === "offline" && Date.now() < offlineUntil) return route.abort("internetdisconnected");
    return route.continue();
  });
  await page.goto(`/suites?suite=studio&page=cast&sp=cast&project=${project.id}`);
  const description = page.getByRole("textbox", { name: "Mara description", exact: true });
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 60_000 });
  await hydrated(description);
  mode = "drop-put";
  await description.fill(MINE);
  await expect.poll(async () => (await read()).project.production!.cast!.entries[0].description, { timeout: 30_000 }).toBe(MINE);
  await expect(page.locator(".pd-save")).toHaveText(/unconfirmed|Not saved/, { timeout: 15_000 });
  const now = await read();
  const next = structuredClone(now.project);
  next.production!.cast!.entries[0].description = LATER;
  expect((await put(next, now.revision)).ok()).toBe(true);
  /* This page reconnects and tries again on its own: the check finds its save landed, and the later text stands. */
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 60_000 });
  await page.waitForTimeout(2000);
  expect((await read()).project.production!.cast!.entries[0].description).toBe(LATER);
  expect(errors).toEqual([]);
});

test("Cast: + Character whose reply was lost, then deleted in another window, stays deleted", async ({ page }) => {
  const { project, errors, read, put } = await setup(page, castEntry);
  const lost = await loseNextReply(page, read, put, (landed) => {
    expect(landed.production!.cast!.entries).toHaveLength(2);
    landed.production!.cast!.entries = landed.production!.cast!.entries.filter((e) => e.id === "cast-1");
    return landed;
  });
  await page.goto(`/suites?suite=studio&page=cast&sp=cast&project=${project.id}`);
  await expect(page.getByTestId("cast-entry")).toHaveCount(1, { timeout: 60_000 });
  await hydrated(page.getByTestId("cast-add-character"));
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
  lost.armed = true;
  await page.getByTestId("cast-add-character").click();
  await expect.poll(() => lost.other !== null, { timeout: 30_000 }).toBe(true);
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 45_000 });
  await page.waitForTimeout(2500);
  expect(ids((await read()).project.production!.cast!.entries)).toEqual(["cast-1"]);
  await expect(page.getByTestId("cast-entry")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("Rig: + Add shot whose reply was lost, then deleted in another window, stays deleted", async ({ page }) => {
  const { project, errors, read, put } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" })]; });
  const lost = await loseNextReply(page, read, put, (landed) => {
    const extra = landed.nodes.filter((n) => n.type === "scene" && n.id !== "n1");
    expect(extra).toHaveLength(1);
    landed.nodes = landed.nodes.filter((n) => n.id !== extra[0].id);
    return landed;
  });
  await openRig(page, project);
  lost.armed = true;
  await page.getByRole("button", { name: "+ Add shot" }).click();
  await expect.poll(() => lost.other !== null, { timeout: 30_000 }).toBe(true);
  await rigSaved(page);
  await page.waitForTimeout(2500);
  expect((await read()).project.nodes.filter((n) => n.type === "scene").map((n) => n.id)).toEqual(["n1"]);
  await expect(page.locator(".pxw-rig-row")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("Rig: a rename whose reply was lost never goes back over a newer rename built on it", async ({ page }) => {
  const { project, errors, read, put } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" }), scene("n2", { title: "Second", x: 400 })]; });
  let seen = "";
  const lost = await loseNextReply(page, read, put, (landed) => {
    seen = landed.nodes.find((n) => n.id === "n1")!.title;
    landed.nodes = landed.nodes.map((n) => (n.id === "n1" ? { ...n, title: "Bravo" } : n));
    return landed;
  });
  await openRig(page, project);
  await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await controls(page);
  const name = page.getByLabel("Name", { exact: true });
  await hydrated(name);
  lost.armed = true;
  await name.fill("Alpha");
  await expect.poll(() => lost.other !== null, { timeout: 30_000 }).toBe(true);
  await rigSaved(page);
  await page.waitForTimeout(2500);
  expect(seen, "the other window saw the Rig's landed rename").toBe("Alpha");
  expect((await read()).project.nodes.find((n) => n.id === "n1")?.title).toBe("Bravo");
  await expect(name).toHaveValue("Bravo");
  expect(errors).toEqual([]);
});

test("Cast: clearing a description while its save is unconfirmed saves the cleared description", async ({ page }) => {
  const { project, errors, read } = await setup(page, castEntry);
  const TYPED = `Typed then cleared ${randomUUID().slice(0, 6)}`;
  let offline = false, landed = false;
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
    const request = route.request();
    if (offline) return route.abort("failed");
    if (request.method() === "PUT" && !landed && (request.postDataJSON() as { project: Project }).project.production?.cast?.entries[0]?.description === TYPED) {
      landed = true;
      await route.fetch();
      offline = true;
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.goto(`/suites?suite=studio&page=cast&sp=cast&project=${project.id}`);
  const field = page.getByRole("textbox", { name: "Mara description", exact: true });
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 60_000 });
  await hydrated(field);
  await field.fill(TYPED);
  await expect(page.locator(".pd-save")).toHaveText(/Save unconfirmed/, { timeout: 30_000 });
  expect((await read()).project.production!.cast!.entries[0].description, "the save did land").toBe(TYPED);
  /* Still offline, the person deletes what they typed; then the connection is back. */
  await field.fill("");
  await page.waitForTimeout(1500);
  offline = false;
  await expect.poll(async () => (await read()).project.production!.cast!.entries[0].description, { timeout: 30_000 }).toBe("");
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("Rig: a shot brought back with ⌘Z while its delete's save was unconfirmed stays in the draft", async ({ page }) => {
  const { project, errors, read } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" }), scene("n2", { title: "Second", y: 300 })]; });
  const toasts = await watchToasts(page);
  await openRig(page, project);
  let offline = false, landed = false;
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
    const request = route.request();
    if (offline) return route.abort("failed");
    if (request.method() === "PUT" && !landed && !(request.postDataJSON() as { project: Project }).project.nodes.some((n) => n.id === "n2")) {
      landed = true;
      await route.fetch();
      offline = true;
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.locator(".pxw-rig-row[data-shot-id='n2']").click();
  await controls(page);
  await page.getByTestId("rig-delete-shot").click();
  await expect(page.locator(".pxw-rig-row[data-shot-id='n2']")).toHaveCount(0);
  await expect.poll(() => landed, { timeout: 20_000 }).toBe(true);
  expect(ids((await read()).project.nodes), "the delete did land").toEqual(["n1"]);
  await page.waitForTimeout(1000);
  await page.locator("body").click({ position: { x: 5, y: 890 } }).catch(() => {});
  await page.keyboard.press(UNDO);
  await expect(page.locator(".pxw-rig-row[data-shot-id='n2']")).toHaveCount(1, { timeout: 10_000 });
  await page.waitForTimeout(1500);
  offline = false;
  await rigSaved(page);
  await page.waitForTimeout(2000);
  expect(toasts.some((t) => t.includes("Second is back in the Rig"))).toBe(true);
  expect(ids((await read()).project.nodes)).toEqual(["n1", "n2"]);
  expect(await page.locator(".pxw-rig-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-shot-id")))).toEqual(["n1", "n2"]);
  expect(errors).toEqual([]);
});

/* ── What two windows make at once is made once ─────────────────────────── */

test("two Rig windows each writing a shot's first direction note: the shot has one note, and a fresh Rig shows it", async ({ page, context }) => {
  const { project, errors, read } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" })]; });
  const b = await context.newPage();
  b.on("pageerror", (e) => errors.push(`B: ${e.message}`));
  await openRig(page, project);
  await openRig(b, project);
  await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await controls(page);
  await directionNote(page).fill("Hold on the fox, low and wide.");
  await rigSaved(page);
  await expect.poll(async () => noteOf((await read()).project.nodes.find((n) => n.id === "n1")), { timeout: 30_000 }).toBe("Hold on the fox, low and wide.");
  /* B opened before A's note and never re-read: it types its own first note. */
  await b.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await controls(b);
  await directionNote(b).fill("Push in slowly as the ice cracks.");
  await rigSaved(b);
  await b.waitForTimeout(2500);
  const n1 = (await read()).project.nodes.find((n) => n.id === "n1");
  const notes = (n1?.operations ?? []).filter((op) => op.kind === "direction").map((op) => String(op.values.note));
  expect(notes).toEqual(["Push in slowly as the ice cracks."]);
  const c = await context.newPage();
  c.on("pageerror", (e) => errors.push(`C: ${e.message}`));
  await openRig(c, project);
  await c.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await controls(c);
  await expect(directionNote(c)).toHaveValue(notes[0]);
  expect(errors).toEqual([]);
});

test("two Environment tabs following one agent run: the world it built is in the draft once", async ({ page, context }) => {
  const { project, errors, read } = await setup(page, (p) => { p.production = { environment: { world: "", model: "gemini-3.1-flash-image", entries: [] } } as NonNullable<Project["production"]>; });
  const jobId = `wb_development_${randomUUID()}`;
  const job = (status: "running" | "succeeded") => ({
    id: jobId, requestId: randomUUID(), projectId: project.id, productionProjectId: null, kind: "environment", model: "claude-sonnet-4-6", effort: "medium", instructions: "",
    sourceHash: "0".repeat(64), status, completedChunks: 1, totalChunks: 1, currentStage: status === "succeeded" ? "complete" : "draft", completedSteps: 1, totalSteps: 2,
    estimateCredits: 4, credits: status === "succeeded" ? 4 : null, error: null, createdAt: Date.now() - 60_000, updatedAt: Date.now(),
    result: status === "succeeded" ? { environment: { world: "Winter, always dusk; sodium lamps and ice.", entries: [
      { name: "Harbour", notes: "The frozen harbour.", prompt: "A frozen harbour at dusk, sodium lamps, no people" },
      { name: "Lighthouse", notes: "At the harbour mouth.", prompt: "A lighthouse on ice at dusk, no people" },
      { name: "Fish market", notes: "Shuttered for winter.", prompt: "A shuttered fish market in snow, no people" },
    ] } } : null,
  });
  const tabs: { page: Page; done: boolean }[] = [];
  for (const tab of [page, await context.newPage()]) {
    const state = { page: tab, done: false };
    if (tab !== page) tab.on("pageerror", (e) => errors.push(e.message));
    /* The agent's runs, as the development route reports them: running, then done. Nothing is billed. */
    await tab.route((url) => url.pathname === "/api/workbench/development", async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      const body = await (await route.fetch()).json().catch(() => ({}));
      return route.fulfill({ json: { ...body, configured: true, jobs: [job(state.done ? "succeeded" : "running")] } });
    });
    await tab.goto(`/suites?suite=studio&page=boards&sp=environment&project=${project.id}`);
    await expect(tab.getByTestId("environment-agent")).toBeVisible({ timeout: 60_000 });
    await hydrated(tab.getByTestId("environment-agent"));
    await expect(tab.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
    tabs.push(state);
  }
  tabs[0].done = true;
  await expect.poll(async () => (await read()).project.production?.environment?.entries.length ?? 0, { timeout: 30_000 }).toBe(3);
  /* Then the second tab, which never re-read the draft, takes the same run. */
  tabs[1].done = true;
  await page.waitForTimeout(8000);
  await expect(tabs[1].page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
  const env = (await read()).project.production!.environment!;
  expect(env.entries.map((e) => e.name)).toEqual(["Harbour", "Lighthouse", "Fish market"]);
  expect(env.agentJobId).toBe(jobId);
  expect(errors).toEqual([]);
});

/* ── A merge is a save the server takes ─────────────────────────────────── */

test("Environment: a reference uploaded while another window added one to the same place (five of six) is saved, and so is what is typed next", async ({ page }) => {
  const picture = (id: string): Asset => ({ id, name: `${id}.png`, kind: "image", category: "Reference", url: "/campaign/hero.webp", mime: "image/webp", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
  const { project, errors, read, elsewhere } = await setup(page, (p) => {
    p.assets = ["r1", "r2", "r3", "r4", "r5"].map(picture);
    p.production = { environment: { world: "", model: "gemini-3.1-flash-image", entries: [{ id: "env-1", name: "Harbour", notes: "", prompt: "A frozen harbour at dusk", references: ["r1", "r2", "r3", "r4", "r5"], plates: [] }] } } as NonNullable<Project["production"]>;
  });
  const saves = watchSaves(page);
  await page.goto(`/suites?suite=studio&page=boards&sp=environment&project=${project.id}`);
  const place = page.getByTestId("environment-entry").first();
  await expect(place).toBeVisible({ timeout: 60_000 });
  await hydrated(place);
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
  await expect(place.getByTestId("environment-references")).toContainText("References 5/6");
  /* Another window adds the sixth reference. */
  await elsewhere((p) => { p.assets.push(picture("teammate-ref")); p.production!.environment!.entries[0].references.push("teammate-ref"); });
  /* This window, still showing five, uploads one: valid on its own, and merged into a draft the server takes. */
  await place.getByTestId("environment-upload-reference").setInputFiles({ name: "ice.png", mimeType: "image/png", buffer: await png("#99bbdd") });
  await expect.poll(() => saves.some((s) => s.status === 409 && s.code === "revision_conflict"), { timeout: 30_000 }).toBe(true);
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 30_000 });
  const NOTES = `Ice to the horizon ${randomUUID().slice(0, 6)}`;
  await place.getByRole("textbox", { name: "Harbour notes" }).fill(NOTES);
  await expect.poll(async () => (await read()).project.production!.environment!.entries[0].notes, { timeout: 30_000 }).toBe(NOTES);
  const saved = (await read()).project;
  expect(saved.production!.environment!.entries[0].references).toContain("teammate-ref");
  expect(saved.production!.environment!.entries[0].references).toHaveLength(6);
  expect(saved.assets.filter((a) => a.name === "ice.png"), "the upload is in the library").toHaveLength(1);
  expect(saves.filter((s) => s.status === 400)).toEqual([]);
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/);
  expect(errors).toEqual([]);
});

test("a wire made in the Rig graph after another window deleted its source never becomes a link to nothing; the grade takes another input", async ({ page }) => {
  const { project, errors, read, elsewhere } = await setup(page, (p) => {
    p.nodes = [
      scene("n1", { title: "Opening" }),
      scene("n2", { title: "Second", x: 400 }),
      { id: "g1", type: "grade", title: "Warm grade", x: 800, y: 0, width: 236, linked: [], operations: [{ id: "g-op", kind: "grade", enabled: true, values: { brightness: 103, contrast: 105, saturation: 90 } }] } as unknown as Node,
    ];
  });
  const saves = watchSaves(page);
  await openRig(page, project);
  await page.waitForTimeout(1500);
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  const graph = page.getByTestId("rig-graph");
  await expect(graph.locator(".pxw-graph-node")).toHaveCount(3, { timeout: 30_000 });
  await elsewhere((p) => { p.nodes = p.nodes.filter((n) => n.id !== "n1"); });
  /* This Rig, still showing Opening, wires it into the grade: merged, the wire goes with the deleted shot. */
  await graph.getByRole("button", { name: "Connect from Opening" }).click();
  await graph.getByRole("button", { name: "Connect into Warm grade" }).click();
  await expect.poll(() => saves.some((s) => s.status === 409 && s.code === "revision_conflict"), { timeout: 30_000 }).toBe(true);
  await expect(graph.locator(".pxw-graph-node")).toHaveCount(2, { timeout: 30_000 });
  const known = (p: Project) => new Set(ids(p.nodes));
  const dangling = (p: Project) => p.nodes.flatMap((n) => n.linked.filter((id) => !known(p).has(id)).map((id) => `${n.id} -> ${id}`));
  await page.waitForTimeout(1500);
  expect(dangling((await read()).project)).toEqual([]);
  await graph.getByRole("button", { name: "Connect from Second" }).click();
  await graph.getByRole("button", { name: "Connect into Warm grade" }).click();
  await expect(graph.locator('path[data-edge="n2->g1"]')).toHaveCount(1);
  await expect.poll(async () => (await read()).project.nodes.find((n) => n.id === "g1")?.linked, { timeout: 30_000 }).toEqual(["n2"]);
  expect(errors).toEqual([]);
});

/* ── The team canvas, and the Rig across projects ───────────────────────── */

test("switching project while the Rig's save is out: the merged-in edit to a shot reaches the team canvas and survives reopening", async ({ page }) => {
  const { project: a, errors, headers } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening", text: "Original prompt" }), scene("n2", { title: "Second", x: 400 })]; });
  const acct = await more(page, headers);
  const b = await acct.create(`Bravo ${randomUUID().slice(0, 6)}`, (p) => { p.nodes = [scene("b1", { title: "Bravo shot" })]; });
  const saves = watchSaves(page);
  await openRig(page, a);
  const pidA = (await acct.readOf(a.id)).project.productionProjectId!;
  await expect.poll(async () => (await acct.canvasOf(pidA)).canvas?.nodes.n1?.text ?? null, { timeout: 30_000 }).toBe("Original prompt");
  const arrived = latch(), release = latch();
  let armed = true;
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
    const request = route.request();
    if (request.method() === "PUT" && armed && (request.postDataJSON() as { project: Project }).project.id === a.id) { armed = false; arrived.open(); await release.opened; }
    await route.continue().catch(() => {});
  });
  await page.locator(".pxw-rig-row[data-shot-id='n2']").click();
  await controls(page);
  await directionNote(page).fill("Rig note on Second");
  await arrived.opened;
  await acct.elsewhereOn(a.id, (p) => { p.nodes = p.nodes.map((n) => (n.id === "n1" ? { ...n, text: "Changed elsewhere" } : n)); });
  await page.getByTestId("project-switcher").click();
  await page.getByRole("listbox", { name: "Projects" }).getByRole("option", { name: new RegExp(b.name) }).click();
  await page.waitForTimeout(300);
  release.open();
  await expect(page.locator(".pxw-rig-row[data-shot-id='b1']")).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => { const p = (await acct.readOf(a.id)).project; return [p.nodes.find((n) => n.id === "n1")?.text, noteOf(p.nodes.find((n) => n.id === "n2"))]; }, { timeout: 30_000 })
    .toEqual(["Changed elsewhere", "Rig note on Second"]);
  expect(saves.some((s) => s.status === 409 && s.code === "revision_conflict")).toBe(true);
  await expect.poll(async () => (await acct.canvasOf(pidA)).canvas?.nodes.n1?.text ?? null, { timeout: 30_000 }).toBe("Changed elsewhere");
  await pick(page, a.name);
  await expect(page.locator(".pxw-rig-row[data-shot-id='n1']")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await rigSaved(page);
  expect((await acct.readOf(a.id)).project.nodes.find((n) => n.id === "n1")?.text).toBe("Changed elsewhere");
  expect(errors).toEqual([]);
});

test("a shot edited by another window while the Rig had nothing to save survives the Rig reopening", async ({ page }) => {
  const { project, errors, read, elsewhere, headers } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening", text: "Original prompt" }), scene("n2", { title: "Second", x: 400 })]; });
  const acct = await more(page, headers);
  await openRig(page, project);
  const pid = (await read()).project.productionProjectId!;
  await expect.poll(async () => (await acct.canvasOf(pid)).canvas?.nodes.n1?.text ?? null, { timeout: 30_000 }).toBe("Original prompt");
  /* A Studio stage or another tab: a save of the draft, never through the canvas. */
  await elsewhere((p) => { p.nodes = p.nodes.map((n) => (n.id === "n1" ? { ...n, text: "Changed elsewhere" } : n)); });
  await page.reload();
  await expect(page.locator(".pxw-rig-row[data-shot-id='n1']")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await rigSaved(page);
  expect((await read()).project.nodes.find((n) => n.id === "n1")?.text).toBe("Changed elsewhere");
  expect((await acct.canvasOf(pid)).canvas?.nodes.n1?.text).toBe("Changed elsewhere");
  expect(errors).toEqual([]);
});

test("a merge that brings in another window's title never puts this Rig's stale prompt over a teammate's on the team canvas", async ({ page }) => {
  const { project, errors, read, put, headers } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening", text: "Original prompt" }), scene("n2", { title: "Second", x: 400 })]; });
  const acct = await more(page, headers);
  const saves = watchSaves(page);
  await openRig(page, project);
  const pid = (await read()).project.productionProjectId!;
  await expect.poll(async () => (await acct.canvasOf(pid)).canvas?.nodes.n1?.text ?? null, { timeout: 30_000 }).toBe("Original prompt");
  /* A teammate rewrites Opening's prompt on the shared canvas. */
  const onCanvas = (await acct.canvasOf(pid)).canvas!.nodes.n1;
  expect((await page.request.patch("/api/workbench/team-canvas", { headers, data: { productionId: pid, upsertNodes: [{ ...onCanvas, text: "Teammate prompt" }], removeNodes: [], upsertAssets: [], order: null } })).ok()).toBe(true);
  /* This person's other window retitles Opening in their draft. */
  const now = await read();
  expect((await put({ ...now.project, nodes: now.project.nodes.map((n) => (n.id === "n1" ? { ...n, title: "Opening (retitled)" } : n)) }, now.revision)).ok()).toBe(true);
  /* This Rig edits Second only; its save is beaten and merged. */
  await page.locator(".pxw-rig-row[data-shot-id='n2']").click();
  await controls(page);
  await directionNote(page).fill("Only Second changes here");
  await expect.poll(() => saves.some((s) => s.status === 409 && s.code === "revision_conflict"), { timeout: 30_000 }).toBe(true);
  await rigSaved(page);
  await page.waitForTimeout(2500);
  expect((await acct.canvasOf(pid)).canvas?.nodes.n1).toMatchObject({ title: "Opening (retitled)", text: "Teammate prompt" });
  expect(errors).toEqual([]);
});

test("⌘Z while the next project is still opening says which project to open, and the shot's undo stays", async ({ page }) => {
  const { project: a, errors, headers } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" }), scene("n2", { title: "Second", x: 400 })]; });
  const acct = await more(page, headers);
  const b = await acct.create(`Bravo ${randomUUID().slice(0, 6)}`, (p) => { p.nodes = [scene("b1", { title: "Bravo shot" })]; });
  const toasts = await watchToasts(page);
  await openRig(page, a);
  await page.waitForTimeout(1000);
  await page.locator(".pxw-rig-row[data-shot-id='n2']").click();
  await controls(page);
  await page.getByTestId("rig-delete-shot").click();
  await expect.poll(async () => ids((await acct.readOf(a.id)).project.nodes), { timeout: 30_000 }).toEqual(["n1"]);
  await rigSaved(page);
  const arrived = latch(), release = latch();
  await page.route((url) => url.pathname === "/api/workbench/projects" && url.searchParams.get("id") === b.id, async (route: Route) => {
    if (route.request().method() === "GET") { arrived.open(); await release.opened; }
    await route.continue().catch(() => {});
  });
  await pick(page, b.name);
  await arrived.opened;
  await page.locator("body").click({ position: { x: 5, y: 890 } }).catch(() => {});
  await page.keyboard.press(UNDO);
  await page.waitForTimeout(150);
  release.open();
  await expect(page.locator(".pxw-rig-row[data-shot-id='b1']")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  expect(toasts.some((t) => t.includes(`Open ${a.name}`)), JSON.stringify(toasts)).toBe(true);
  expect(toasts.some((t) => t.includes("Second is back in the Rig"))).toBe(false);
  expect(ids((await acct.readOf(a.id)).project.nodes)).toEqual(["n1"]);
  /* Back on A, the same ⌘Z brings Second back, for real. */
  await pick(page, a.name);
  await expect(page.locator(".pxw-rig-row[data-shot-id='n1']")).toBeVisible({ timeout: 60_000 });
  await page.locator("body").click({ position: { x: 5, y: 890 } }).catch(() => {});
  await page.keyboard.press(UNDO);
  await expect(page.locator(".pxw-rig-row[data-shot-id='n2']")).toHaveCount(1, { timeout: 10_000 });
  await rigSaved(page);
  await expect.poll(async () => ids((await acct.readOf(a.id)).project.nodes), { timeout: 30_000 }).toEqual(["n1", "n2"]);
  expect(errors).toEqual([]);
});

test("an unconfirmed save of project A is still sent after switching to B, once the network is back", async ({ page }) => {
  const { project: a, errors, headers } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" }), scene("n2", { title: "Second", x: 400 })]; });
  const acct = await more(page, headers);
  const b = await acct.create(`Bravo ${randomUUID().slice(0, 6)}`, (p) => { p.nodes = [scene("b1", { title: "Bravo shot" })]; });
  await openRig(page, a);
  await page.waitForTimeout(1000);
  let down = true;
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route: Route) => {
    const request = route.request();
    if (down && request.method() === "PUT" && (request.postDataJSON() as { project: Project }).project.id === a.id)
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Service unavailable" }) });
    await route.continue().catch(() => {});
  });
  await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await controls(page);
  await directionNote(page).fill("Unconfirmed note");
  await expect(page.getByTestId("rig-list")).toHaveAttribute("data-save-state", "error", { timeout: 30_000 });
  await pick(page, b.name);
  await expect(page.locator(".pxw-rig-row[data-shot-id='b1']")).toBeVisible({ timeout: 60_000 });
  /* B's Rig carries none of A's trouble. */
  await expect(page.getByTestId("rig-list")).toHaveAttribute("data-save-state", "saved");
  down = false;
  await expect.poll(async () => noteOf((await acct.readOf(a.id)).project.nodes.find((n) => n.id === "n1")), { timeout: 30_000 }).toBe("Unconfirmed note");
  expect(errors).toEqual([]);
});

test("⌘Z of a delete another window has since edited back in keeps that window's edit", async ({ page }) => {
  const opening = scene("n1", { title: "Opening", operations: [{ id: "op1", kind: "direction", enabled: true, values: { note: "Original note" } }] } as Partial<Node>);
  const { project, errors, read, put, headers } = await setup(page, (p) => { p.nodes = [opening, scene("n2", { title: "Second", x: 400 })]; });
  const acct = await more(page, headers);
  const toasts = await watchToasts(page);
  await openRig(page, project);
  await page.waitForTimeout(1500);
  await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await controls(page);
  await page.getByTestId("rig-delete-shot").click();
  await expect.poll(async () => ids((await read()).project.nodes), { timeout: 30_000 }).toEqual(["n2"]);
  await rigSaved(page);
  /* Another window still held Opening, changed its note, and its merge kept the change. */
  const now = await read();
  expect((await put({ ...now.project, nodes: [{ ...opening, operations: [{ id: "op1", kind: "direction", enabled: true, values: { note: "Teammate note" } }] } as unknown as Node, ...now.project.nodes] }, now.revision)).ok()).toBe(true);
  await page.locator(".pxw-rig-row[data-shot-id='n2']").click();
  await page.locator("body").click({ position: { x: 5, y: 890 } }).catch(() => {});
  await page.keyboard.press(UNDO);
  await expect.poll(() => toasts.some((t) => t.includes("Opening is back in the Rig")), { timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1500);
  await rigSaved(page);
  await page.waitForTimeout(1500);
  const saved = (await read()).project;
  expect(repeated(ids(saved.nodes))).toEqual([]);
  expect(noteOf(saved.nodes.find((n) => n.id === "n1"))).toBe("Teammate note");
  /* The team canvas agrees: the undo's older copy never went over the other window's. */
  expect(noteOf((await acct.canvasOf(saved.productionProjectId!)).canvas?.nodes.n1)).toBe("Teammate note");
  expect(errors).toEqual([]);
});

test("a rename merged in from another window shows in the Inspector's Name field, and the next keystroke keeps it", async ({ page }) => {
  const { project, errors, read, elsewhere } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" }), scene("n2", { title: "Second", x: 400 })]; });
  const saves = watchSaves(page);
  await openRig(page, project);
  await page.waitForTimeout(1000);
  await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await controls(page);
  const name = page.getByLabel("Name", { exact: true });
  await expect(name).toHaveValue("Opening");
  await elsewhere((p) => { p.nodes = p.nodes.map((n) => (n.id === "n1" ? { ...n, title: "Harbour at dusk" } : n)); });
  await directionNote(page).fill("Hold on the fox.");
  await expect.poll(() => saves.some((s) => s.status === 409 && s.code === "revision_conflict"), { timeout: 30_000 }).toBe(true);
  await rigSaved(page);
  await expect(page.getByTestId("inspector-title")).toHaveText("Harbour at dusk", { timeout: 15_000 });
  await expect(name).toHaveValue("Harbour at dusk");
  await name.click();
  await name.press("End");
  await name.pressSequentially(" 2", { delay: 40 });
  await rigSaved(page);
  await expect.poll(async () => (await read()).project.nodes.find((n) => n.id === "n1")?.title, { timeout: 30_000 }).toBe("Harbour at dusk 2");
  expect(errors).toEqual([]);
});

/* ── The Gen composer pays for a take once ──────────────────────────────── */

for (const leave of ["stays on Gen", "leaves Gen for Studio and comes back", "reloads"] as const)
  test(`Gen: a take whose paid reply was lost is paid for once when the person ${leave} and presses Generate again`, async ({ page }) => {
    const { project, errors, read, scope } = await setup(page, () => {});
    await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
    const reached: { key: string; job: string | null }[] = [];
    let lost = false;
    await page.route((url) => url.pathname === "/api/generate", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const key = route.request().headers()["idempotency-key"] ?? "";
      const response = await route.fetch();
      reached.push({ key, job: (await response.json().catch(() => null))?.id ?? null });
      if (!lost) { lost = true; return route.abort("connectionreset"); }
      return route.fulfill({ response });
    });
    const prompt = "A red fox crosses the frozen harbour at dusk.";
    const press = async (open: boolean) => {
      if (open) {
        await page.goto(`/suites?view=gen&project=${project.id}`);
        await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
      }
      const box = page.getByTestId("gen-prompt");
      await hydrated(box);
      if ((await box.inputValue()) !== prompt) await box.fill(prompt);
      const go = page.getByTestId("gen-generate");
      await expect(go).toBeEnabled({ timeout: 60_000 });
      await expect(go).toHaveText(/\d cr/, { timeout: 60_000 });
      await go.click();
    };
    await press(true);
    await expect.poll(() => reached.length, { timeout: 60_000 }).toBe(1);
    await expect(page.locator(".gx-gen-note[role=status]").first()).toBeVisible({ timeout: 30_000 });
    if (leave === "leaves Gen for Studio and comes back") {
      await page.locator("[data-suite-tab=studio]").click();
      await expect(page.getByTestId("gen-view")).toHaveCount(0, { timeout: 30_000 });
      await page.locator("[data-suite-tab=gen]").click();
      await expect(page.getByTestId("gen-view")).toBeVisible({ timeout: 30_000 });
      await press(false);
    } else await press(leave === "reloads");
    await expect.poll(() => reached.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(2000);
    expect(new Set(reached.map((r) => r.key)).size, "paid requests").toBe(1);
    expect(new Set(reached.map((r) => r.job)).size, "jobs").toBe(1);
    expect((await read()).project.nodes.filter((n) => n.type === "scene"), "shots").toHaveLength(1);
    expect(errors).toEqual([]);
  });

/** A configured audio account: quotes scale with the text; submits recorded, the first one's reply lost. Nothing reaches an engine. */
async function mockAudio(page: Page) {
  const submits: { key: string; body: Record<string, unknown> }[] = [];
  await page.route((url) => url.pathname === "/api/audio", async (route: Route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ json: { configured: true, speechModels: [{ id: "mock-speech", label: "Mock speech", creditsPerChar: 0.1, note: "Local test" }], defaultSpeechModel: "mock-speech", voices: [{ id: "mock-voice", name: "Avery", category: "premade", description: "", previewUrl: null, labels: {} }], voicesError: null } });
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.quoteOnly) return route.fulfill({ json: { estimatedCredits: String(body.text ?? "").length > 30 ? 40 : 2 } });
    submits.push({ key: request.headers()["idempotency-key"] ?? "", body });
    if (submits.length === 1) return route.abort("connectionreset");
    return route.fulfill({ json: { id: `mock-audio-${submits.length}` } });
  });
  await page.route((url) => url.pathname.startsWith("/api/jobs/mock-audio-"), (route) => route.fulfill({ json: { generation: { id: "mock", status: "queued" } } }));
  return submits;
}

test("Gen sound: a new prompt at a new price is what is sent, never the lane's earlier unconfirmed request", async ({ page }) => {
  const { project, errors, scope } = await setup(page, () => {});
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const submits = await mockAudio(page);
  await page.goto(`/suites?view=gen&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  await page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Audio" }).click();
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  const go = page.getByTestId("gen-generate");
  await box.fill("Thunder rolls over the frozen harbour while the ice cracks and gulls cry.");
  await expect(go).toHaveText(/Generate · 40 cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => submits.length, { timeout: 60_000 }).toBe(1);
  await expect(page.locator(".gx-gen-note[role=status]").first()).toBeVisible({ timeout: 30_000 });
  await box.fill("Short click.");
  await expect(go).toHaveText(/Generate · 2 cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => submits.length, { timeout: 60_000 }).toBe(2);
  expect(submits[1].body.text).toBe("Short click.");
  expect(submits[1].body.maxCredits).toBe(2);
  expect(submits[1].key).not.toBe(submits[0].key);
  expect(errors).toEqual([]);
});

test("Gen sound: when Edit & Sound makes the sound lane while Gen's save is out, the project keeps one sound lane", async ({ page }) => {
  const { project, errors, read, headers, scope } = await setup(page, () => {});
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const submits = await mockAudio(page);
  let first = true;
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route) => {
    if (route.request().method() !== "PUT" || !first) return route.continue();
    first = false;
    const now = await read();
    const lane = { id: "lane-es", type: "audio", mode: "Audio", role: "sound-lane:sound", title: "Sound effects", x: 40, y: 120, width: 286, linked: [], collapsed: true };
    const answer = await page.request.put("/api/workbench/projects", { headers, data: { project: { ...now.project, nodes: [...now.project.nodes, lane] }, revision: now.revision } });
    expect(answer.ok(), await answer.text()).toBe(true);
    return route.continue();
  });
  await page.goto(`/suites?view=gen&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  await page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Audio" }).click();
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  await box.fill("Short click.");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/Generate · 2 cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => submits.length, { timeout: 60_000 }).toBe(1);
  await page.waitForTimeout(1000);
  expect((await read()).project.nodes.filter((n) => n.role === "sound-lane:sound").map((n) => n.id)).toEqual(["lane-es"]);
  expect(errors).toEqual([]);
});

test("Gen, two takes: recovering take 2 after its request was cut off charges two takes in all, not three", async ({ page }) => {
  const { project, errors, read, scope } = await setup(page, () => {});
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const reached: string[] = [];
  let seen = 0;
  await page.route((url) => url.pathname === "/api/generate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    /* Take 2's request is cut off before it reaches the server. */
    if (++seen === 2) return route.abort("connectionreset");
    reached.push(route.request().headers()["idempotency-key"] ?? "");
    return route.continue();
  });
  await page.goto(`/suites?view=gen&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  await box.fill("A red fox crosses the frozen harbour at dusk.");
  await page.getByTestId("gen-takes").getByRole("button", { name: "More" }).click();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("2");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/\d cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => seen, { timeout: 60_000 }).toBe(2);
  await expect(page.locator(".gx-gen-note[role=status]").first()).toBeVisible({ timeout: 30_000 });
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await go.click();
  await expect.poll(() => new Set(reached).size, { timeout: 60_000 }).toBe(2);
  await page.waitForTimeout(4000);
  expect(new Set(reached).size, "paid requests for a two-take ask").toBe(2);
  expect((await read()).project.nodes.filter((n) => n.type === "scene").map((n) => n.title)).toEqual(["A red fox crosses the frozen harbour at dusk. · take 1", "A red fox crosses the frozen harbour at dusk. · take 2"]);
  expect(errors).toEqual([]);
});

/** A connected account, fully intercepted: nothing is billed anywhere. `submit` decides each submit's fate. */
async function mockConnected(page: Page, options: { submit?: (id: string, n: number) => "lost" | "ok"; holdQuote?: (n: number) => Promise<void> | void; completed?: boolean } = {}) {
  const wallet = "22222222-2222-4222-8222-222222222222";
  const submits: string[] = [], polled = new Set<string>(), provider = new Map<string, string>();
  let quotes = 0;
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON();
    const job = (id: string, status: string) => {
      const providerJobId = provider.get(id) ?? null, gid = `gen_hfc_${id.replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;
      return {
        id, draftId: body.draftId, status, input: body.input ?? { type: "video", model: "connected-motion", prompt: "A red fox crosses the frozen harbour at dusk.", parameters: {}, medias: [] },
        model: { id: "connected-motion", name: "Motion 1", outputType: "video" }, workspaceId: wallet, workspaceName: "Studio wallet",
        quoteCredits: 9, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, providerJobId, createdAt: Date.now(),
        ...(status === "completed" ? { originalAvailable: true, originalAvailability: "available", result: { original: { generationId: gid, providerJobId, creditUnit: "higgsfield_credits", credits: 9, sha256: "a".repeat(64), bytes: 1024, asset: { generationId: gid, mime: "video/mp4", url: `/api/media/${gid}`, kind: "video" } } } } : { result: null }),
      };
    };
    if (body.action === "catalogue")
      return route.fulfill({ json: { catalogue: { models: [{ id: "connected-motion", name: "Motion 1", description: "", outputType: "video", parameters: [], medias: [], aspectRatios: ["16:9"], tags: [], supportsUnlim: false }], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    if (body.action === "quote") { quotes++; await options.holdQuote?.(submits.length); return route.fulfill({ json: { job: job(`11111111-1111-4111-8111-${String(quotes).padStart(12, "0")}`, "quoted") } }); }
    if (body.action === "submit") {
      submits.push(body.id);
      provider.set(body.id, randomUUID());
      if ((options.submit?.(body.id, submits.length) ?? "ok") === "lost") return route.abort("connectionreset");
      return route.fulfill({ json: { job: job(body.id, "accepted") } });
    }
    if (body.action === "status") { polled.add(body.id); return route.fulfill({ json: { job: job(body.id, options.completed ? "completed" : "accepted") } }); }
    return route.fulfill({ status: 409, json: { error: "Not in this spec." } });
  });
  return { submits, polled };
}
async function chooseConnected(page: Page) {
  await page.getByTestId("gen-model").click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("tab", { name: "Higgsfield catalogue" }).click();
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("option", { name: /Motion 1/ }).click();
}

test("Gen, connected: a take whose submit reply was lost is read back on the next Generate, never quoted and submitted again", async ({ page }) => {
  const { project, errors, scope } = await setup(page, () => {});
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const account = await mockConnected(page, { submit: (_id, n) => (n === 1 ? "lost" : "ok") });
  await page.goto(`/suites?view=gen&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  await chooseConnected(page);
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  await box.fill("A red fox crosses the frozen harbour at dusk.");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/9 connected cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => account.submits.length, { timeout: 60_000 }).toBe(1);
  await expect(page.locator(".gx-gen-note[role=status]").first()).toBeVisible({ timeout: 30_000 });
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await go.click();
  await expect(page.locator(".gx-gen-note[role=status]").first()).toContainText("reached the connected account", { timeout: 30_000 });
  await page.waitForTimeout(2000);
  expect(new Set(account.submits).size, "connected jobs submitted for one take").toBe(1);
  expect(account.polled.has(account.submits[0])).toBe(true);
  expect(errors).toEqual([]);
});

test("Gen, connected: takes submitted after the person left Gen are still followed and filed when Gen is back", async ({ page }) => {
  const { project, errors, scope } = await setup(page, () => {});
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const hold = latch(), holding = latch();
  let held = false;
  const account = await mockConnected(page, {
    completed: true,
    /* The second take's price is held until the person has left Gen. */
    holdQuote: async (submitted) => { if (submitted === 1 && !held) { held = true; holding.open(); await hold.opened; } },
  });
  const filed = new Set<string>();
  page.on("request", (request) => {
    if (request.method() !== "PUT" || new URL(request.url()).pathname !== "/api/workbench/projects") return;
    try { for (const asset of (request.postDataJSON()?.project?.assets ?? []) as { generationId?: string }[]) if (asset.generationId) filed.add(asset.generationId); } catch { /* a gzipped body */ }
  });
  await page.goto(`/suites?view=gen&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  await chooseConnected(page);
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  await box.fill("A red fox crosses the frozen harbour at dusk.");
  await page.getByTestId("gen-takes").getByRole("button", { name: "More" }).click();
  await page.getByTestId("gen-takes").getByRole("button", { name: "More" }).click();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("3");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/3 takes · 27 connected cr/, { timeout: 60_000 });
  await go.click();
  await holding.opened;
  await page.locator("[data-suite-tab=studio]").click();
  await expect(page.getByTestId("gen-view")).toHaveCount(0, { timeout: 30_000 });
  hold.open();
  await expect.poll(() => account.submits.length, { timeout: 30_000 }).toBe(3);
  await page.locator("[data-suite-tab=gen]").click();
  await expect(page.getByTestId("gen-view")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => account.submits.every((id) => account.polled.has(id)), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => filed.size, { timeout: 30_000 }).toBe(3);
  expect(errors).toEqual([]);
});

test("Gen: two takes while other saves land between and on top of them — a take's lost save reply is checked, never made twice", async ({ page }) => {
  const { project, errors, read, elsewhere, scope } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" })]; });
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const puts: { status?: number; lost?: boolean }[] = [];
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const entry: (typeof puts)[number] = {};
    puts.push(entry);
    /* Between take 1 and take 2: the Brief is saved elsewhere, so take 2's save is refused. */
    if (puts.length === 2) await elsewhere((p) => { p.brief = "Brief written between the takes."; });
    if (puts.length === 3) {
      /* Take 2's retry lands, another editor saves on top, and the reply never arrives. */
      entry.status = (await route.fetch()).status();
      await elsewhere((p) => { p.script = "EXT. HARBOUR - NIGHT\n\nThe ice sings.\n"; });
      entry.lost = true;
      return route.abort("connectionreset");
    }
    const response = await route.fetch();
    entry.status = response.status();
    return route.fulfill({ response });
  });
  const paid: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate") paid.push(request.headers()["idempotency-key"] ?? ""); });
  await page.goto(`/suites?view=gen&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  await box.fill("A red fox crosses the frozen harbour at dusk.");
  await page.getByTestId("gen-takes").getByRole("button", { name: "More" }).click();
  await expect(page.getByTestId("gen-takes-count")).toHaveText("2");
  const go = page.getByTestId("gen-generate");
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await expect(go).toHaveText(/\d cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => paid.length, { timeout: 60_000 }).toBe(2);
  await page.waitForTimeout(1500);
  const saved = (await read()).project;
  expect(saved.brief).toBe("Brief written between the takes.");
  expect(saved.script).toContain("The ice sings.");
  expect(saved.nodes.filter((n) => n.id !== "n1").map((n) => n.title)).toEqual(["A red fox crosses the frozen harbour at dusk. · take 1", "A red fox crosses the frozen harbour at dusk. · take 2"]);
  expect(repeated(ids(saved.nodes))).toEqual([]);
  expect(new Set(paid).size).toBe(2);
  expect(errors).toEqual([]);
});
