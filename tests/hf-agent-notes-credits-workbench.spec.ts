import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { newProject, type Project } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * Idea 27 — agent stages keep the director's notes and speak in credits.
 *
 * Brief & Script and Beats keep their notes to the writer on the project
 * draft: a reload keeps them, a start the server refuses keeps them, they
 * leave the box only once the server holds the run that carries them (and
 * only while they are still what was sent), and a run that fails offers them
 * back. Every price is in the one unit the workspace pays in: credits, or the
 * dollars of a model on its own key — never both. A delete on the beat sheet
 * goes on the shell's undo stack, with a toast that carries its own Undo.
 *
 * The projects route is the real one (the notes are saved through its
 * schema); the agent's route is a fake that never runs anything.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
/* A touch screen gets the toast's 44px Undo; the phone layout (under 768px wide) owes the 12px and 44px floors everywhere. */
const touch = (name: string) => ["workbench-360x640", "workbench-390x844", "workbench-844x390"].includes(name);
const phone = (name: string) => ["workbench-360x640", "workbench-390x844"].includes(name);
/* Review screenshots are written only when NOTES_SHOTS names a folder; CI takes none. */
const SHOTS = process.env.NOTES_SHOTS;
async function snap(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const MODELS = [
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", vision: true, released: 2, efforts: [{ value: "auto", label: "Auto" }] },
  { id: "spacexai/grok-4.7", name: "Grok 4.7", vision: true, released: 3, efforts: [{ value: "auto", label: "Auto" }] },
  { id: "openai/gpt-5.5", name: "GPT-5.5", vision: true, released: 1, efforts: [{ value: "auto", label: "Auto" }] },
];
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n\nINT. HARBOUR MASTER'S HUT - CONTINUOUS\n\nMARA watches through the window.\n";
const FAILED = "This development phase could not complete: The agent ran out of room before it finished its answer, so nothing was kept from this phase. It was not billed, and it is never sent again on its own.";

type Job = Record<string, unknown> & { id: string; requestId: string; status: string };
type Body = Record<string, unknown>;

/** The agent's route, faked: models, jobs, quotes and starts; nothing ever runs. */
async function agentRoute(page: Page) {
  const state = {
    jobs: [] as Job[], bodies: [] as Body[],
    quote: { estimateCredits: 3 } as { estimateCredits: number; estimateUsd?: number },
    start: "hold" as "hold" | "refuse", delay: 0,
  };
  await page.route("**/api/workbench/development**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      const url = new URL(request.url());
      const jobId = url.searchParams.get("jobId"), requestId = url.searchParams.get("requestId");
      if (jobId) { const job = state.jobs.find((j) => j.id === jobId); return job ? route.fulfill({ json: { job } }) : route.fulfill({ status: 404, json: { error: "This development job was not found." } }); }
      return route.fulfill({ json: { configured: true, models: MODELS, jobs: requestId ? state.jobs.filter((j) => j.requestId === requestId) : state.jobs } });
    }
    const body = request.postDataJSON() as Body;
    state.bodies.push(body);
    if (body.resume) return route.fulfill({ json: { job: state.jobs.find((j) => j.id === body.jobId) } });
    if (body.quoteOnly) return route.fulfill({ json: { quoteOnly: true, model: body.model, effort: body.effort, kind: body.kind, sourceHash: "a".repeat(64), chunks: 1, calls: 3, sourceCharacters: 120, ...state.quote } });
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    if (state.start === "refuse") return route.fulfill({ status: 409, json: { error: "The estimate changed. Review a new quote before starting." } });
    const job = runJob(body);
    state.jobs.unshift(job);
    return route.fulfill({ status: 202, json: { job } });
  });
  return state;
}

function runJob(body: Body, over: Partial<Job> = {}): Job {
  return {
    id: `wb_development_${randomUUID()}`, requestId: String(body.requestId ?? randomUUID()), projectId: String(body.projectId), productionProjectId: "prod",
    kind: String(body.kind ?? "write"), model: String(body.model ?? MODELS[0].id), effort: "auto", instructions: String(body.instructions ?? ""),
    source: body.fromBeats ? "beats" : body.fromJobId ? "draft" : "prompt", sourceHash: "a".repeat(64), status: "running",
    completedChunks: 0, totalChunks: 1, currentStage: "draft", completedSteps: 0, totalSteps: 3,
    estimateCredits: Number(body.maxCredits ?? 3), credits: null, ownKey: false, result: null, error: null, createdAt: Date.now(), updatedAt: Date.now(), ...over,
  };
}

async function setup(page: Page, project: Project, stage: "brief" | "beats") {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 500, "Agent notes test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const put = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(put.ok(), await put.text()).toBe(true);
  const agent = await agentRoute(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `/suites?suite=studio&page=brief${stage === "beats" ? "&sp=beats" : ""}&project=${project.id}`;
  await page.goto(url);
  await expect(page.getByTestId(`${stage}-stage`)).toBeVisible();
  /* A read-only check: a keep-alive socket the dev server closed between polls is retried, never counted as the app's failure. */
  const saved = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers, maxRetries: 2 }).then((r) => r.json())).project as Project;
  return { agent, errors, saved, url };
}

/**
 * Nothing in `scope` runs past it or the viewport (content clipped by its own
 * scroller is that scroller's business), no serif, labels no dimmer than
 * #7C7C84, and on a phone no text under 12px and no target under 44×44.
 */
async function floors(page: Page, name: string, where: string, scope: string) {
  const problems = await page.evaluate((scope) => {
    const out: string[] = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1) out.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
    for (const root of Array.from(document.querySelectorAll<HTMLElement>(scope))) {
      const limit = Math.min(root.getBoundingClientRect().right, width);
      if (root.scrollWidth > root.clientWidth + 1 && getComputedStyle(root).overflowX !== "visible") out.push(`${scope} scrolls sideways: ${root.scrollWidth} > ${root.clientWidth}`);
      for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
        if (!node.getClientRects().length) continue;
        /* Clipped by a scroller between it and the root: that scroller's own business. */
        let clipped = false;
        for (let a = node.parentElement; a && a !== root && !clipped; a = a.parentElement) clipped = getComputedStyle(a).overflowX !== "visible";
        const style = getComputedStyle(node);
        const label = `${node.dataset.testid || (typeof node.className === "string" ? node.className : "") || node.tagName}`;
        if (!clipped && node.getBoundingClientRect().right > limit + 1) out.push(`${label} ends at ${Math.round(node.getBoundingClientRect().right)} past ${Math.round(limit)}`);
        if (/(^|,)\s*"?(serif|georgia|times|times new roman)"?\s*(,|$)/i.test(style.fontFamily)) out.push(`serif on ${label}: ${style.fontFamily}`);
      }
    }
    return out;
  }, scope);
  expect(problems, `${where}: layout`).toEqual([]);
  expect(await dimLabels(page, scope), `${where}: labels under #7C7C84`).toEqual([]);
  if (!phone(name)) return;
  const tiny = await page.evaluate((scope) => Array.from(document.querySelectorAll<HTMLElement>(`${scope}, ${scope} *`))
    .filter((el) => el.getClientRects().length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim()) && Number.parseFloat(getComputedStyle(el).fontSize) < 12)
    .map((el) => `${getComputedStyle(el).fontSize}: “${(el.textContent ?? "").trim().slice(0, 40)}”`), scope);
  expect(tiny, `${where}: text under 12px`).toEqual([]);
  expect(await smallTargets(page, scope), `${where}: targets under 44×44`).toEqual([]);
}

/** The toast sits inside the viewport, above the phone's tab bar, and carries its Undo; the ⌘Z half only where there is a keyboard. */
async function undoToast(page: Page, name: string, text: string) {
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText(text);
  const undo = toast.getByTestId("toast-undo");
  await expect(undo).toBeVisible();
  /* Measured once it has popped in (it scales from 97%). */
  await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = (await toast.boundingBox())!, view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height + 0.5);
  const bar = page.getByTestId("tabbar");
  if (await bar.isVisible().catch(() => false)) expect(box.y + box.height).toBeLessThanOrEqual((await bar.boundingBox())!.y + 0.5);
  if (touch(name)) {
    const b = (await undo.boundingBox())!;
    expect(Math.round(b.height * 100) / 100).toBeGreaterThanOrEqual(44);
    expect(Math.round(b.width * 100) / 100).toBeGreaterThanOrEqual(44);
    await expect(toast.getByText("⌘Z to undo")).toBeHidden();
  } else await expect(toast.getByText("⌘Z to undo")).toBeVisible();
  return undo;
}

test("Brief & Script: the notes survive a reload and a refused start, leave only with a held redraft, and come back when it fails — all in credits", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(120_000);
  const project: Project = { ...newProject(`Harbour ${randomUUID().slice(0, 6)}`), brief: "A fox crosses a frozen harbour at dusk. Ninety seconds, quiet." };
  const draft = runJob({ projectId: project.id, kind: "write" }, {
    status: "succeeded", completedSteps: 3, currentStage: "complete", credits: 2,
    result: { summary: "", recommendation: "", ideas: [], scenes: [], critique: [], assumptions: [], script: { title: "Harbour Light", logline: "A fox and a lamp.", text: SCRIPT, notes: ["Kept it wordless."] } },
  });
  const { agent, errors, saved } = await setup(page, project, "brief");
  agent.jobs.push(draft);
  await page.reload();
  const review = page.getByTestId("brief-review");
  await expect(review).toContainText("Review · Draft 1");
  /* A finished draft states what it cost in credits. */
  await expect(review).toContainText("2 credits");
  const notes = page.getByTestId("brief-notes");
  await expect(notes).toHaveValue("");

  /* Notes are saved on the project: a reload keeps them. */
  await notes.fill("Let the fox come back to the lamp at night.");
  await expect(page.getByTestId("brief-save")).toHaveText("Saved");
  await expect.poll(async () => (await saved()).production?.notes?.draft).toBe("Let the fox come back to the lamp at night.");
  await page.reload();
  await expect(notes).toHaveValue("Let the fox come back to the lamp at night.");

  /* The price is in credits, on the button and the line — no dollars anywhere on the stage. */
  await page.getByTestId("brief-redraft-estimate").click();
  await expect(page.getByTestId("brief-redraft")).toHaveText("Redraft · up to 3 credits");
  await expect(page.getByTestId("brief-redraft-quote")).toContainText("3 agent steps — draft, critique, refine · Claude Sonnet 4.6 · up to 3 credits");
  await expect(page.getByTestId("brief-stage")).not.toContainText("$");
  await floors(page, info.project.name, "quoted", ".pd-stage");

  /* A start the server refuses keeps the notes, and says why. */
  agent.start = "refuse";
  await page.getByTestId("brief-redraft").click();
  await expect(page.getByTestId("agent-error")).toHaveText("The estimate changed. Review a new quote before starting.");
  await expect(notes).toHaveValue("Let the fox come back to the lamp at night.");
  expect(agent.bodies.filter((b) => !b.quoteOnly)).toHaveLength(1);

  /* Held while the director was still writing: what they wrote since stays. */
  agent.start = "hold"; agent.delay = 1500;
  await page.getByTestId("brief-redraft-estimate").click();
  await page.getByTestId("brief-redraft").click();
  await notes.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.keyboard.type(" And the lamp.");
  await expect(page.getByTestId("brief-progress")).toContainText("reserved up to 3 credits");
  await expect(notes).toHaveValue("Let the fox come back to the lamp at night. And the lamp.");
  const first = agent.jobs[0];
  expect(first.instructions).toBe("Let the fox come back to the lamp at night.");

  /* That run fails: said beside the notes, not billed; its notes are still in the box, so nothing is offered twice. */
  Object.assign(first, { status: "failed", error: FAILED, credits: 0, completedSteps: 1, updatedAt: Date.now() });
  const failed = page.getByTestId("brief-redraft-failed");
  await expect(failed).toContainText("It was not billed", { timeout: 10_000 });
  await expect(page.getByTestId("brief-notes-restore")).toHaveCount(0);
  await floors(page, info.project.name, "failed", ".pd-stage");
  await snap(page, `brief-failed-${info.project.name}`);

  /* Held with exactly what is in the box: the box empties, and the run keeps the notes. */
  agent.delay = 0;
  await notes.fill("Keep it wordless.");
  await page.getByTestId("brief-redraft-estimate").click();
  await page.getByTestId("brief-redraft").click();
  await expect(notes).toHaveValue("");
  expect(agent.jobs[0].instructions).toBe("Keep it wordless.");
  await expect.poll(async () => (await saved()).production?.notes?.draft ?? "").toBe("");

  /* It fails too: into the empty box, its notes come back as they were — saved again. */
  Object.assign(agent.jobs[0], { status: "failed", error: FAILED, credits: 0, updatedAt: Date.now() });
  await expect(page.getByTestId("brief-notes-restore")).toHaveText("Use those notes again", { timeout: 10_000 });
  await page.getByTestId("brief-notes-restore").click();
  await expect(notes).toHaveValue("Keep it wordless.");
  await expect(page.getByTestId("brief-notes-restore")).toHaveCount(0);
  await expect.poll(async () => (await saved()).production?.notes?.draft).toBe("Keep it wordless.");
  /* With other words in the box, they come after them — never over them. */
  await notes.fill("Shorter.");
  await expect(page.getByTestId("brief-notes-restore")).toHaveText("Add those notes again");
  await page.getByTestId("brief-notes-restore").click();
  await expect(notes).toHaveValue("Shorter.\n\nKeep it wordless.");
  await floors(page, info.project.name, "restored", ".pd-stage");
  expect(errors).toEqual([]);
});

test("Beats: a delete goes on the undo stack with a toast Undo, ⌘Z brings it back from Brief; notes survive a reload; stale own-key quotes never expose vendor amounts", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(120_000);
  const sha = createHash("sha256").update(SCRIPT).digest("hex");
  const scene = (n: number, heading: string) => ({
    id: `scene-${n}`, heading, summary: `What scene ${n} is for.`, characters: ["MARA"], locations: [heading], props: [],
    beats: [1, 2].map((b) => ({ id: `beat-${n}-${b}`, text: `Scene ${n}, beat ${b}.` })),
    shots: [1, 2].map((t) => ({ id: `shot-${n}-${t}`, description: `Scene ${n}, shot ${t}.`, framing: "Wide", movement: "Locked", lighting: "Dusk", sound: "Wind" })),
  });
  const project: Project = {
    ...newProject(`Beats ${randomUUID().slice(0, 6)}`), brief: "A fox and a harbour master.", script: SCRIPT,
    production: {
      scriptApproval: { at: new Date().toISOString(), source: "hand", sha256: sha },
      beats: { scriptSha256: sha, updatedAt: new Date().toISOString(), scenes: [scene(1, "EXT. FROZEN HARBOUR - DUSK"), scene(2, "INT. HARBOUR MASTER'S HUT - CONTINUOUS")] },
    },
  };
  const { agent, errors, saved } = await setup(page, project, "beats");
  const counts = page.getByTestId("beats-counts");
  await expect(counts).toHaveText("2 scenes · 4 beats · 4 shots");

  /* The notes to the writer are saved on the project: a reload keeps them. */
  await page.getByTestId("beats-notes").fill("Keep it wordless.");
  await expect.poll(async () => (await saved()).production?.notes?.beats).toBe("Keep it wordless.");
  await page.reload();
  await expect(page.getByTestId("beats-notes")).toHaveValue("Keep it wordless.");

  /* A stale own-key quote is unavailable; only a fresh retail credit quote is displayed. */
  agent.quote = { estimateCredits: 0, estimateUsd: 0.0123 };
  await page.getByTestId("beats-breakdown-estimate").click();
  await expect(page.getByTestId("beats-breakdown-start")).toHaveText("Break it into beats · up to Quote unavailable");
  await expect(page.getByTestId("beats-breakdown-quote")).not.toContainText("0 credits");
  await page.getByTestId("beats-breakdown").getByRole("button", { name: "Change" }).click();
  agent.quote = { estimateCredits: 4 };
  await page.getByTestId("beats-breakdown-estimate").click();
  await expect(page.getByTestId("beats-breakdown-start")).toHaveText("Break it into beats · up to 4 credits");
  await expect(page.getByTestId("beats-stage")).not.toContainText("$");
  await page.getByTestId("beats-breakdown").getByRole("button", { name: "Change" }).click();

  /* Delete a beat: the toast says so and carries Undo, which puts it back where it was — saved. */
  await page.getByTestId("beat-scene").nth(0).click();
  await page.getByLabel("Delete beat 2").click();
  await expect(counts).toHaveText("2 scenes · 3 beats · 4 shots");
  const undo = await undoToast(page, info.project.name, "Beat 2 of scene 1 deleted");
  await floors(page, info.project.name, "toast", "[data-testid='toast']");
  await snap(page, `beats-toast-${info.project.name}`);
  await undo.click();
  await expect(page.getByTestId("toast")).toHaveText("Beat 2 of scene 1 is back");
  await expect(counts).toHaveText("2 scenes · 4 beats · 4 shots");
  await expect(page.getByLabel("Scene 1 beat 2")).toHaveValue("Scene 1, beat 2.");
  await expect.poll(async () => (await saved()).production?.beats?.scenes[0].beats.map((b) => b.id)).toEqual(["beat-1-1", "beat-1-2"]);

  /* Delete a shot and walk straight to Brief, its save still pending: Brief opens on the saved delete, and its own edit saves too. */
  await page.getByLabel("Delete shot 1.1").click();
  await expect(counts).toHaveText("2 scenes · 4 beats · 3 shots");
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Brief/ }).click();
  await expect(page.getByTestId("brief-stage")).toBeVisible();
  await page.getByTestId("brief-audience").fill("Families, late evening.");
  await expect(page.getByTestId("brief-save")).toHaveText("Saved");
  await expect.poll(async () => { const now = await saved(); return [now.audience, now.production?.beats?.scenes[0].shots.length]; }).toEqual(["Families, late evening.", 1]);
  /* ⌘Z there: Beats opens and the shot is back, in its place. */
  await page.getByTestId("brief-stage").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("beats-stage")).toBeVisible();
  await expect(counts).toHaveText("2 scenes · 4 beats · 4 shots");
  await expect(page.getByTestId("toast")).toHaveText("Shot 1.1 is back");
  await expect.poll(async () => (await saved()).production?.beats?.scenes[0].shots.map((s) => s.id)).toEqual(["shot-1-1", "shot-1-2"]);

  /* A whole scene, and ⌘Z on the stage: back at number two. */
  await page.getByTestId("beat-scene").nth(1).click();
  await page.getByLabel("Delete scene 2").click();
  await expect(counts).toHaveText("1 scenes · 2 beats · 2 shots");
  await undoToast(page, info.project.name, "Scene 2 deleted");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(counts).toHaveText("2 scenes · 4 beats · 4 shots");
  await expect(page.getByTestId("beat-scene").nth(1)).toContainText("INT. HARBOUR MASTER'S HUT - CONTINUOUS");
  await expect.poll(async () => (await saved()).production?.beats?.scenes.map((s) => s.id)).toEqual(["scene-1", "scene-2"]);
  await floors(page, info.project.name, "beats", ".pd-stage");
  expect(errors).toEqual([]);
});
