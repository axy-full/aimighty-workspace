import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { moreTakes } from "./helpers/genTakes";
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

type Node = Project["nodes"][number];
type Read = { project: Project; revision: number };

const hydrated = (target: Locator) => expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 60_000 }).toBe(true);
const scene = (id: string, extra: Partial<Node> = {}) => ({ id, title: id, type: "scene", x: 0, y: 0, width: 238, linked: [], role: "Director", status: "draft", mode: "Video", durationS: 5, ratio: "16:9", resolution: "720p", ...extra }) as Node;
const ids = (list: { id: string }[]) => list.map((item) => item.id);
const repeated = (list: string[]) => list.filter((id, i) => list.indexOf(id) !== i);async function setup(page: Page, shape: (p: Project) => void) {
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





/* ── The Rig and a Studio stage, whichever save lands first ─────────────── */



/* ── Two windows on one stage ───────────────────────────────────────────── */


/* ── Things made while another save lands: made once, kept, with their id ─ */





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



/* ── Undo after a merge ─────────────────────────────────────────────────── */


/* ── The Gen composer after a Brief edit ────────────────────────────────── */

test("Gen: a batch of two takes after a Brief edit elsewhere keeps the Brief edit and files both takes on one shot", async ({ page }) => {
  const { project, errors, read, elsewhere, scope } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" })]; });
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const saves = watchSaves(page);
  const paid: { batchId?: string; variation?: number; shotId?: string }[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && ["/api/generate", "/api/audio"].includes(new URL(request.url()).pathname)) paid.push(request.postDataJSON() as (typeof paid)[number]); });
  await page.goto(`/suites?make=video&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  await expect(page.getByTestId("gen-view")).toBeVisible();
  /* The page holds the project as it opened; the Brief is then written elsewhere. */
  await elsewhere((p) => { p.brief = "Written in Brief after Gen opened."; p.script = "EXT. HARBOUR - DUSK\n\nA fox crosses the ice.\n"; });
  const prompt = page.getByTestId("gen-prompt");
  await hydrated(prompt);
  await prompt.fill("A red fox crosses the frozen harbour at dusk.");
  await moreTakes(page, 1);
  await expect(page.getByTestId("gen-takes-count")).toHaveText("2");
  const go = page.getByTestId("gen-generate");
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await expect(go).toHaveText(/\d cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => paid.length, { timeout: 60_000 }).toBe(2);
  /* One batch: one shot, both takes on it with one batch id and their take numbers. */
  expect(paid.map((p) => p.variation)).toEqual([1, 2]);
  expect(new Set(paid.map((p) => p.batchId)).size).toBe(1);
  expect(new Set(paid.map((p) => p.shotId)).size).toBe(1);
  await expect.poll(async () => (await read()).project.nodes.filter((n) => n.id !== "n1" && n.type === "scene").length, { timeout: 30_000 }).toBe(1);
  const saved = (await read()).project;
  expect(saved.brief).toBe("Written in Brief after Gen opened.");
  expect(saved.script).toContain("A fox crosses the ice.");
  const made = saved.nodes.filter((n) => n.id !== "n1");
  expect(made.map((n) => n.title)).toEqual(["A red fox crosses the frozen harbour at dusk. · 2 takes"]);
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








/* ── What two windows make at once is made once ─────────────────────────── */



/* ── A merge is a save the server takes ─────────────────────────────────── */



/* ── The team canvas, and the Rig across projects ───────────────────────── */








/* ── The Gen composer pays for a take once ──────────────────────────────── */

/** The Idempotency-Keys this page asks the server about (POST /api/generate/check): a lost paid request is checked, never re-sent. */
function checkedKeys(page: Page) {
  const keys: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate/check") keys.push(String((request.postDataJSON() as { key?: unknown }).key ?? ""));
  });
  return keys;
}
/** Paid requests this browser still holds as unconfirmed. */
const claims = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("particl:pending-generation:")).length);

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
    const checks = checkedKeys(page);
    const prompt = "A red fox crosses the frozen harbour at dusk.";
    const press = async (open: boolean) => {
      if (open) {
        await page.goto(`/suites?make=video&project=${project.id}`);
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
      /* Make is a panel now: leaving it is closing it (Studio stays under it). */
      await page.getByTestId("make-close").click();
      await expect(page.getByTestId("gen-view")).toHaveCount(0, { timeout: 30_000 });
      await page.locator("[data-suite-tab=make]").click();
      await expect(page.getByTestId("gen-view")).toBeVisible({ timeout: 30_000 });
      await press(false);
    } else await press(leave === "reloads");
    /* The press asks the server about the lost request by its own key (POST /api/generate/check): it landed, so its
       job is followed and nothing is sent again. */
    await expect.poll(() => checks, { timeout: 60_000 }).toEqual([reached[0].key]);
    await expect.poll(() => claims(page), { timeout: 30_000 }).toBe(0);
    await page.waitForTimeout(2000);
    expect(reached.length, "requests sent").toBe(1);
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
  await page.goto(`/suites?make=video&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  await page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Audio" }).click();
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  const go = page.getByTestId("gen-generate");
  await box.fill("Thunder rolls over the frozen harbour while the ice cracks and gulls cry.");
  await expect(go).toHaveText(/Make · 40 cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => submits.length, { timeout: 60_000 }).toBe(1);
  await expect(page.locator(".gx-gen-note[role=status]").first()).toBeVisible({ timeout: 30_000 });
  await box.fill("Short click.");
  await expect(go).toHaveText(/Make · 2 cr/, { timeout: 60_000 });
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
  await page.goto(`/suites?make=video&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  await page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Audio" }).click();
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  await box.fill("Short click.");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/Make · 2 cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => submits.length, { timeout: 60_000 }).toBe(1);
  await page.waitForTimeout(1000);
  expect((await read()).project.nodes.filter((n) => n.role === "sound-lane:sound").map((n) => n.id)).toEqual(["lane-es"]);
  expect(errors).toEqual([]);
});

test("Gen, two takes: take 2's request cut off stops the batch; the next Generate checks it, finds it never arrived, fences it and says so — nothing sent again", async ({ page }) => {
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
  const checks = checkedKeys(page);
  await page.goto(`/suites?make=video&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  await box.fill("A red fox crosses the frozen harbour at dusk.");
  await moreTakes(page, 1);
  await expect(page.getByTestId("gen-takes-count")).toHaveText("2");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/\d cr/, { timeout: 60_000 });
  await go.click();
  await expect.poll(() => seen, { timeout: 60_000 }).toBe(2);
  /* The batch stops at the take whose reply never came back, and says so. */
  await expect(page.locator(".gx-gen-note[role=status]").first()).toContainText("Take 2: the reply never came back. It is checked before anything else is sent, and never sent twice.", { timeout: 30_000 });
  const lostKey = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("particl:pending-generation:"));
    return key ? (JSON.parse(localStorage.getItem(key)!) as { key: string }).key : null;
  });
  expect(lostKey).toBeTruthy();
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await go.click();
  /* Asked about by its own key (POST /api/generate/check): it never arrived, so it is fenced — it can never land — and
     the press says so rather than sending anything, old or new. */
  await expect(page.locator(".gx-gen-note[role=status]").first()).toHaveText("Take 2 of your last batch never arrived; nothing was charged for it. Nothing new was sent: press Generate again to send this.", { timeout: 30_000 });
  expect(checks).toEqual([lostKey]);
  await expect.poll(() => claims(page), { timeout: 30_000 }).toBe(0);
  await page.waitForTimeout(3000);
  expect(seen, "paid requests the browser sent").toBe(2);
  expect(new Set(reached).size, "paid requests that reached the server").toBe(1);
  expect((await read()).project.nodes.filter((n) => n.type === "scene").map((n) => n.title)).toEqual(["A red fox crosses the frozen harbour at dusk. · 2 takes"]);
  expect(errors).toEqual([]);
});

/* Gen's connected-account takes (a lost submit reply read back; a batch followed after leaving Gen) went with Gen's
   catalogue source on 28 September 2026: Gen offers Studio engines only, so there is no account take to follow. */

test("Gen: a batch's shot saved while other saves land before and on top of it — its lost save reply is checked, never made twice", async ({ page }) => {
  const { project, errors, read, elsewhere, scope } = await setup(page, (p) => { p.nodes = [scene("n1", { title: "Opening" })]; });
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const puts: { status?: number; lost?: boolean }[] = [];
  await page.route((url) => url.pathname === "/api/workbench/projects", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const entry: (typeof puts)[number] = {};
    puts.push(entry);
    /* Just before the batch's shot is saved, the Brief is saved elsewhere, so that save is refused. */
    if (puts.length === 1) await elsewhere((p) => { p.brief = "Brief written between the takes."; });
    if (puts.length === 2) {
      /* The shot's retry lands, another editor saves on top, and the reply never arrives. */
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
  await page.goto(`/suites?make=video&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  await box.fill("A red fox crosses the frozen harbour at dusk.");
  await moreTakes(page, 1);
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
  expect(saved.nodes.filter((n) => n.id !== "n1").map((n) => n.title)).toEqual(["A red fox crosses the frozen harbour at dusk. · 2 takes"]);
  expect(repeated(ids(saved.nodes))).toEqual([]);
  expect(new Set(paid).size).toBe(2);
  expect(errors).toEqual([]);
});

/* ── Break hunt, 26 September, round 2 ─────────────────────────────────── */


test("Marketing: preparing the same hook variants in two windows prepares each once", async ({ page, context }) => {
  const hero: Asset = { id: `product_${randomUUID().slice(0, 8)}`, name: "bottle.png", kind: "image", category: "Product", url: "/campaign/hero.webp", mime: "image/png", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] } as Asset;
  const { project, errors, read } = await setup(page, (p) => {
    p.assets = [hero];
    p.moleculr = { ...EMPTY_MOLECULR, productName: "Still Water", productAssetIds: [hero.id], hooks: ["Quiet mornings", "Cold, clean, yours"] };
  });
  const b = await context.newPage();
  b.on("pageerror", (e) => errors.push(`B: ${e.message}`));
  const reopen = async (tab: Page) => {
    const tool = tab.locator('[data-tool-body="marketing"]');
    await tab.bringToFront();
    const toggle = tool.getByRole("button", { name: /One idea\. Considered variations\./ });
    await toggle.scrollIntoViewIfNeeded();
    await hydrated(toggle);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const prepare = tool.getByRole("button", { name: /Prepare hook × cast variants/ });
    await expect(prepare).toBeEnabled({ timeout: 15_000 });
    return prepare;
  };
  for (const tab of [page, b]) {
    await tab.goto(`/workspace?project=${project.id}&suite=moleculr&page=marketing`);
    await expect(tab.locator('[data-tool-body="marketing"]')).toBeVisible({ timeout: 120_000 });
    await expect(tab.locator(".pxw-draft-status")).toHaveAttribute("data-save-state", "Saved", { timeout: 30_000 });
    await reopen(tab);
  }
  await (await reopen(page)).click();
  await expect.poll(async () => (await read()).project.moleculr?.variants.length ?? 0, { timeout: 30_000 }).toBe(2);
  await expect(page.locator(".pxw-draft-status")).toHaveAttribute("data-save-state", "Saved", { timeout: 30_000 });
  /* Window B, opened before A prepared them, presses the same button. */
  await (await reopen(b)).click();
  await expect(b.locator(".pxw-draft-status")).toHaveAttribute("data-save-state", "Saved", { timeout: 30_000 });
  await b.waitForTimeout(3000);
  const saved = (await read()).project;
  const combos = saved.moleculr!.variants.map((v) => JSON.stringify([v.kind, v.hook, v.castAssetId ?? null, v.productId ?? null]));
  expect({ variants: saved.moleculr!.variants.length, distinct: new Set(combos).size, variantNodes: saved.nodes.filter((n) => saved.moleculr!.variants.some((v) => v.nodeId === n.id)).length }).toEqual({ variants: 2, distinct: 2, variantNodes: 2 });
  expect(repeated(ids(saved.nodes))).toEqual([]);
  expect(errors).toEqual([]);
});



















/* ── The Gen composer, round 2 ── */

const FOX = "A red fox crosses the frozen harbour at dusk.";
async function openGen(page: Page, project: Project) {
  await page.goto(`/suites?make=video&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name, { timeout: 60_000 });
  const box = page.getByTestId("gen-prompt");
  await hydrated(box);
  return { box, go: page.getByTestId("gen-generate") };
}

for (const reached of [false, true])
  test(`Gen: after a take's paid reply is lost (${reached ? "the request reached the server" : "it never did"}), a new prompt is what the next Generate sends`, async ({ page }) => {
    const { project, errors, read, scope } = await setup(page, () => {});
    await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
    const SECOND = "A lighthouse beam sweeps over black water at night.";
    const sent: { prompt: string; reached: boolean }[] = [];
    let first = true;
    await page.route((url) => url.pathname === "/api/generate", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const entry = { prompt: String((route.request().postDataJSON() as { prompt?: string }).prompt ?? ""), reached: true };
      sent.push(entry);
      if (first) {
        first = false;
        if (!reached) { entry.reached = false; return route.abort("connectionreset"); }
        await route.fetch();
        return route.abort("connectionreset");
      }
      return route.fulfill({ response: await route.fetch() });
    });
    const { box, go } = await openGen(page, project);
    await box.fill(FOX);
    await expect(go).toHaveText(/\d cr/, { timeout: 60_000 });
    await go.click();
    await expect.poll(() => sent.length, { timeout: 60_000 }).toBe(1);
    await expect(page.locator(".gx-gen-note[role=status]").first()).toBeVisible({ timeout: 30_000 });
    await box.fill(SECOND);
    await expect(go).toBeEnabled({ timeout: 60_000 });
    await expect(go).toHaveText(/\d cr/, { timeout: 60_000 });
    await go.click();
    await expect.poll(() => sent.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(3000);
    const arrived = sent.filter((s) => s.reached).map((s) => s.prompt);
    expect(arrived).toContain(SECOND);
    if (!reached) expect(arrived).not.toContain(FOX);
    expect((await read()).project.nodes.filter((n) => n.type === "scene").map((n) => n.title)).toContain(SECOND);
    expect(errors).toEqual([]);
  });

for (const where of ["another tab on the same project", "this tab, as an image"] as const)
  test(`Gen: a video take whose paid reply was lost is paid for once, even when ${where} generates a take before the person presses Generate again`, async ({ page, context }) => {
    const { project, errors, scope } = await setup(page, () => {});
    await context.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
    const reached: { key: string; prompt: string; job: string | null }[] = [];
    let lost = false;
    await page.route((url) => url.pathname === "/api/generate", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      reached.push({ key: route.request().headers()["idempotency-key"] ?? "", prompt: String((route.request().postDataJSON() as { prompt?: string }).prompt ?? ""), job: (await response.json().catch(() => null))?.id ?? null });
      if (!lost) { lost = true; return route.abort("connectionreset"); }
      return route.fulfill({ response });
    });
    const checks = checkedKeys(page);
    const a = await openGen(page, project);
    await page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Video" }).click();
    await a.box.fill(FOX);
    await expect(a.go).toHaveText(/\d cr/, { timeout: 60_000 });
    await a.go.click();
    await expect.poll(() => reached.length, { timeout: 60_000 }).toBe(1);
    await expect(page.locator(".gx-gen-note[role=status]").first()).toBeVisible({ timeout: 30_000 });
    const other = where === "another tab on the same project" ? await context.newPage() : page;
    const otherPaid: string[] = [];
    other.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/generate") otherPaid.push(request.headers()["idempotency-key"] ?? ""); });
    const b = other === page ? a : await openGen(other, project);
    await other.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Image" }).click();
    await b.box.fill("A lighthouse at night, still frame.");
    await expect(b.go).toHaveText(/\d cr/, { timeout: 60_000 });
    await b.go.click();
    await expect.poll(() => (other === page ? reached.length : otherPaid.length), { timeout: 60_000 }).toBe(other === page ? 2 : 1);
    await other.waitForTimeout(1500);
    await page.bringToFront();
    await page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Video" }).click();
    if ((await a.box.inputValue()) !== FOX) await a.box.fill(FOX);
    await expect(a.go).toHaveText(/\d cr/, { timeout: 60_000 });
    const before = reached.length;
    await a.go.click();
    /* Asked about by its own key: it landed, so that job is followed and nothing is sent again. */
    await expect.poll(() => checks.includes(reached[0].key), { timeout: 60_000 }).toBe(true);
    await page.waitForTimeout(2500);
    expect(reached.length, "requests sent after the press").toBe(before);
    const fox = reached.filter((r) => r.prompt === FOX);
    expect({ requests: new Set(fox.map((r) => r.key)).size, jobs: new Set(fox.map((r) => r.job)).size }).toEqual({ requests: 1, jobs: 1 });
    expect(errors).toEqual([]);
  });

/* ── Merges the server takes, in the editors that make them ── */



/* ── Folded from the break hunt of 26 September, round 2, corrector's pass ── */
