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
    if (request.method() === "GET" && new URL(request.url()).searchParams.get("id") && mode === "offline" && Date.now() < offlineUntil) return route.abort("internetdisconnected");
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
