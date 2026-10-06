import { test, expect, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { joinLocallyAsMember, localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { smallTargets } from "./phoneFloors";

/**
 * Viral = Genjutsu on Particl's API key, in the
 * browser against a local ENGINE_MOCK server, in a MANAGED workspace (on the
 * platform's keys, paying in credits) — the owner's and a member's. Nothing
 * here is route-mocked: the files are really uploaded into the project, the
 * button's estimate is the real POST /api/generate/quote, the press is the
 * real POST /api/generate at that figure, and the take is collected by the
 * real job read (the provider is the mock engine: fixed estimates, a fixture
 * clip, nothing billed). Not one request reaches the connected account's
 * routes. Motion transfer and Object swap are Make's quick tools
 * (`make=motion|swap`); the old Viral page links land on them. History from
 * the Library and its states: hf-viral-real-runs.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const CLIP = { url: "/fixtures/clip-6s.mp4", name: "walk.mp4", type: "video/mp4" };
const STILLS = [
  { url: "/campaign/character.webp", name: "wren.webp", type: "image/webp" },
  { url: "/campaign/environment.webp", name: "dunes.webp", type: "image/webp" },
];

async function platform<T>(fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return await fn(db); } finally { db.close(); }
}

type Seeded = { workspaceId: string; projectId: string; consumer: string[]; quotes: Record<string, unknown>[]; sends: { body: Record<string, unknown>; key: string | null }[]; errors: string[] };
/** A person in a fresh managed workspace (the owner, or a member through the real invitation) with credits and one saved project, opened on load. */
async function seed(page: Page, playwright: PlaywrightWorkerArgs["playwright"], as: "owner" | "member"): Promise<Seeded> {
  let workspaceId: string;
  if (as === "owner") workspaceId = (await signInLocally(page.request)).workspace.id;
  else {
    const ownerApi = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
    workspaceId = (await joinLocallyAsMember(ownerApi, page.request)).workspace.id;
    await ownerApi.dispose();
  }
  const mode = await platform(async (db) => {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 5000, "Viral key fixture", "manual", "test", Date.now()] });
    return Number((await db.execute({ sql: "SELECT uses_platform_keys FROM workspaces WHERE id=?", args: [workspaceId] })).rows[0].uses_platform_keys);
  });
  expect(mode, "a managed workspace: the platform's keys, paid in credits").toBe(1);
  const me = await (await page.request.get("/api/me")).json() as { id: string; owner: boolean };
  expect(me.owner).toBe(as === "owner");
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = newProject(`Viral ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const seeded: Seeded = { workspaceId, projectId: project.id, consumer: [], quotes: [], sends: [], errors: [] };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/higgsfield/consumer/")) seeded.consumer.push(`${request.method()} ${path}`);
    if (request.method() !== "POST") return;
    if (path === "/api/generate/quote") seeded.quotes.push(request.postDataJSON() as Record<string, unknown>);
    if (path === "/api/generate") seeded.sends.push({ body: request.postDataJSON() as Record<string, unknown>, key: request.headers()["idempotency-key"] ?? null });
  });
  page.on("pageerror", (error) => seeded.errors.push(error.message));
  return seeded;
}

/**
 * What Viral asked of the connected account: nothing. The shell's own collector
 * (lib/shell/connected-collector.ts) still lists an owner's earlier connected
 * jobs on any page, to drain them; that read is the shell's, not Viral's, and
 * it never quotes or sends.
 */
const viralAsked = (consumer: string[]) => consumer.filter((call) => call !== "GET /api/higgsfield/consumer/generation");

/** Files from the device dropped on the well: uploaded into the project by the page itself, then placed. */
async function dropFiles(page: Page, files: { url: string; name: string; type: string }[]) {
  await page.getByTestId("viral-well").evaluate(async (well, files) => {
    const data = new DataTransfer();
    for (const f of files) data.items.add(new File([await (await fetch(f.url)).blob()], f.name, { type: f.type }));
    well.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, files);
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}
/** A priced button reads "<verb> · up to N cr": an estimate, whole, never shortened. */
const priced = (verb: string) => new RegExp(`^${verb} · up to \\d[\\d,]* cr$`);
const figure = async (page: Page) => Number(((await page.getByTestId("viral-generate").innerText()).match(/up to ([\d,]+) cr/)?.[1] ?? "").replace(/,/g, ""));

test("Motion Transfer on the API key: a 4–8 s source and ordered stills, the live estimate on the button, one send at that figure, and the take lands", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(240_000);
  const s = await seed(page, playwright, "owner");
  await page.goto("/suites?suite=subatomik&page=motion&sp=motion");
  /* The old page's link is Make's quick tool now, over Studio. */
  await expect(page).toHaveURL(/[?&]make=motion(&|$)/);
  expect(new URL(page.url()).searchParams.get("suite")).not.toBe("subatomik");
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "motion");
  await expect(page.getByTestId("make-title")).toHaveText("Motion transfer");
  await expect(page.getByTestId("viral-reason")).toHaveText("Add one source video (4–8 s).");
  /* The account's owner-run card is gone for good: this page is the composer. */
  await expect(page.getByTestId("owner-run-viral")).toHaveCount(0);

  await dropFiles(page, [CLIP]);
  await expect(page.getByTestId("viral-source")).toContainText("walk.mp4 · 6 s", { timeout: 60_000 });
  await expect(page.getByTestId("viral-source-card")).toContainText("SOURCE · 6 s");
  await expect(page.getByTestId("viral-reason")).toHaveText("Add at least one reference image.");
  await expect(page.getByTestId("viral-source-download")).toHaveAttribute("href", /^\/api\/uploads\/[A-Za-z0-9_-]+\?download=1$/);
  await dropFiles(page, STILLS);
  await expect(page.getByTestId("viral-reference")).toHaveCount(2, { timeout: 60_000 });
  await page.getByRole("button", { name: "Move dunes.webp earlier" }).click();
  await expect(page.getByTestId("viral-reference").first()).toContainText("dunes.webp");
  await expect(page.getByText("2 of 8 reference images · order is the order sent")).toBeVisible();

  /* The button wears the live estimate for exactly this input: the route's own quote, in the director's order. */
  await expect(page.getByTestId("viral-generate")).toHaveText(priced("Transfer motion"), { timeout: 60_000 });
  await expect(page.getByTestId("viral-foot")).toHaveText("An estimate from the live price · filed to this project’s takes");
  /* The tool's line carries the same estimate as the button. */
  await expect(page.getByTestId("make-engine-price")).toHaveText(/^up to \d[\d,]* cr$/);
  const quote = s.quotes.at(-1)!;
  expect(quote).toMatchObject({ model: "higgsfield-genjutsu-motion-transfer", task: "genjutsu", resolution: "720p", prompt: "", workbenchProjectId: s.projectId, refine: false });
  expect(quote).not.toHaveProperty("shotId");
  expect((quote.references as { role: string }[]).map((r) => r.role)).toEqual(["reference_image", "reference_image"]);
  expect(quote.sourceUploadId).toEqual(expect.any(String));
  const [dunes, wren] = quote.references as { uploadId: string }[];
  expect(dunes.uploadId).not.toBe(wren.uploadId);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="viral-view"]'), "44px targets").toEqual([]);
  await noSideScroll(page);

  /* One press: priced again, held to the figure on the button, sent once with its approval. */
  const shown = await figure(page);
  await page.getByTestId("viral-generate").click();
  await expect(page.getByTestId("viral-done")).toContainText("Rendered.", { timeout: 90_000 });
  expect(s.sends).toHaveLength(1);
  expect(s.sends[0].body).toMatchObject({ ...quote, maxCredits: shown, quoteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(s.sends[0].key).toMatch(/^[0-9a-f-]{36}$/);
  /* The take is in this project's Recent, in words, a way into Takes. */
  const recent = page.getByTestId("viral-recent").getByTestId("viral-take");
  await expect(recent.first()).toHaveAttribute("data-status", /^(review|picked|approved)$/, { timeout: 30_000 });
  await expect(recent.first().getByTestId("viral-take-status")).toHaveText("Done");
  await expect(recent.first().getByTestId("viral-take-open")).toBeEnabled();
  await noSideScroll(page);
  expect(viralAsked(s.consumer), "Viral asks the connected account for nothing").toEqual([]);
  expect(s.errors).toEqual([]);
});

test("the source's own tools: a frame saved to the project joins the references, and the well holds eight", async ({ page, playwright }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  test.setTimeout(180_000);
  const s = await seed(page, playwright, "owner");
  await page.goto("/suites?suite=subatomik&page=swap&sp=swap");
  await expect(page.getByTestId("make-title")).toHaveText("Object swap");
  await expect(page.getByTestId("viral-prompt")).toHaveAttribute("placeholder", "Replace the bottle with the Glow serum; keep the hands as filmed.");
  await dropFiles(page, [CLIP]);
  await expect(page.getByTestId("viral-source")).toContainText("walk.mp4", { timeout: 60_000 });
  await page.getByTestId("viral-frame-start").click();
  await expect(page.getByTestId("viral-note")).toContainText("Start frame saved to this project and added as a reference", { timeout: 60_000 });
  await expect(page.getByTestId("viral-reference")).toHaveCount(1);
  await expect(page.getByTestId("viral-reference").first()).toContainText(".png");
  /* Eight in the well; a ninth is refused in words, and a frame then is saved but not placed. */
  const eight = Array.from({ length: 7 }, (_, i) => ({ ...STILLS[i % 2], name: `still-${i}.webp` }));
  await dropFiles(page, eight);
  await expect(page.getByTestId("viral-reference")).toHaveCount(8, { timeout: 90_000 });
  await dropFiles(page, [{ ...STILLS[0], name: "ninth.webp" }]);
  await expect(page.getByTestId("viral-note")).toContainText("Up to 8 reference images.", { timeout: 60_000 });
  await expect(page.getByTestId("viral-reference")).toHaveCount(8);
  await page.getByTestId("viral-frame-end").click();
  await expect(page.getByTestId("viral-note")).toContainText("End frame saved to this project", { timeout: 60_000 });
  await expect(page.getByTestId("viral-note")).toContainText("The references are full.");
  /* Object Swap prices its own model: whatever the route answers, it was asked for exactly this. */
  await expect.poll(() => s.quotes.at(-1)?.model, { timeout: 60_000 }).toBe("higgsfield-genjutsu-object-swap");
  expect((s.quotes.at(-1)!.references as unknown[]).length).toBe(8);
  /* This clip is under Object Swap's pixel floor: admission refuses it before any estimate, and the button says why. */
  await expect(page.getByTestId("viral-reason")).toContainText("Object Swap needs a source video of at least 409,600 pixels per frame", { timeout: 60_000 });
  await expect(page.getByTestId("viral-generate")).toBeDisabled();
  await expect(page.getByTestId("viral-generate")).toHaveText("Swap object");
  expect(s.sends).toEqual([]);
  await noSideScroll(page);
  expect(viralAsked(s.consumer)).toEqual([]);
  expect(s.errors).toEqual([]);
});

test("a member of a managed workspace runs Viral on the workspace's credits: the strip, no owner card, no key badge, and the take lands", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(240_000);
  const s = await seed(page, playwright, "member");
  await page.goto("/suites?suite=subatomik&page=motion&sp=motion");
  await expect(page.getByTestId("viral-view")).toBeVisible();
  for (const gone of ["owner-run-viral", "owner-badge-viral", "owner-badge-business"]) await expect(page.getByTestId(gone)).toHaveCount(0);
  await dropFiles(page, [CLIP, STILLS[0]]);
  await expect(page.getByTestId("viral-reference")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("viral-generate")).toHaveText(priced("Transfer motion"), { timeout: 60_000 });
  const shown = await figure(page);
  await page.getByTestId("viral-generate").click();
  await expect(page.getByTestId("viral-done")).toContainText("Rendered.", { timeout: 90_000 });
  expect(s.sends.map((send) => send.body.maxCredits)).toEqual([shown]);
  /* History lists it from the Library, with its next steps: a member reaches it from the tool like anyone else. */
  await page.getByTestId("viral-open-history").click();
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  await expect(page.getByTestId("history-view")).toBeVisible();
  const result = page.getByTestId("history-result");
  await expect(result).toHaveCount(1, { timeout: 30_000 });
  await expect(result).toContainText("Motion Transfer · 720p");
  for (const action of ["Open in Make", "Compare", "Send to Edit"]) await expect(result.getByRole("button", { name: action })).toBeEnabled();
  await expect(result.getByTestId("history-take-download")).toHaveAttribute("href", /\?download=1$/);
  await result.getByRole("button", { name: "Compare" }).click();
  const compare = page.getByRole("dialog", { name: "Compare" });
  await expect(compare.locator("video")).toHaveCount(2);
  await compare.getByRole("button", { name: "Close" }).click();
  /* Recreate brings the same inputs back, priced again before anything runs. */
  await result.getByRole("button", { name: "Open in Make" }).click();
  await expect(page.getByTestId("make-panel")).toHaveAttribute("data-tab", "motion");
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "motion");
  await expect(page.getByTestId("viral-source")).toContainText("walk.mp4");
  await expect(page.getByTestId("viral-reference")).toHaveCount(1);
  await expect(page.getByTestId("viral-generate")).toHaveText(priced("Transfer motion"), { timeout: 60_000 });
  expect(s.sends).toHaveLength(1);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="viral-view"]')).toEqual([]);
  await noSideScroll(page);
  expect(s.consumer, "nothing reaches the connected account for a member").toEqual([]);
  expect(s.errors).toEqual([]);
});
