import { test, expect, type Page, type Route } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { createClient } from "@libsql/client";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { SIZES, desktop, floors, phone, shot, silentWav, watchErrors, watchPaid } from "./helpers/l5";

/*
 * Lane 5 · Identity on the Cast card for the lead (Gaps A). A tick, not a gate (owner, 23 Oct 2026): Train Identity ·
 * 54 cr is there with or without a tick. Real local ENGINE_MOCK=1 server and routes: a person ticks consent on the
 * card (who and when), unticks it (withdrawn, marked), and ticks it again with the optional details (whose face and
 * voice, uses, end date, a recording, the attest box) through the real consent route and a real upload; the card reads
 * it back; Train Identity · 54 cr then opens the build form armed with it. The
 * identity's training states need a training a test may not pay for, so the identities read (and, for those states,
 * which identity the record started) are answered by the browser. Nothing paid is sent. Neutral names only.
 */
type Stage = "none" | "training" | "ready" | "failed";

async function seed(page: Page) {
  const workspaceId = (await signInWithNewInterface(page.request, "Identity Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const shot = (id: string) => ({ id, description: "A shot", framing: "Wide", movement: "Held", lighting: "", sound: "" });
  const project = {
    ...newProject("Identity fixture"),
    brief: "A short film about a walk across the dunes.",
    production: {
      beats: { scriptSha256: "b".repeat(64), updatedAt: "2026-10-06T00:00:00Z", scenes: [{ id: "sc1", heading: "EXT. DUNES", summary: "", beats: [], characters: ["Lead"], locations: [], props: [], shots: [shot("b1"), shot("b2"), shot("b3")] }] },
      cast: { entries: [{ id: "cast-lead", name: "Lead", kind: "character", description: "ivory coat, short dark hair", prompt: "A person in an ivory coat", takes: [] }] },
    },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = await saved.json() as { productionProjectId: string };
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });

  /* `pressed`: the identity a priced press in the Inspector started (answered by the browser below; nothing reaches the
     server, so nothing trains or spends), listed as training from then on. */
  const state = { stage: "none" as Stage, pressed: null as null | { body: Record<string, unknown> }, pressedAs: null as null | Record<string, unknown> };
  const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  /* One still of the person in the library, for the build form to pick (its picture is never fetched for anything paid). */
  const still = { id: "upl_l5_face", filename: "lead.png", mime: "image/png", kind: "image", bytes: 100, width: 512, height: 512, durationS: null, sha256: "c".repeat(64), url: "/api/uploads/upl_l5_face", createdAt: 1 };
  await page.route("**/api/workbench/library?**", (route) => route.request().method() !== "GET" ? route.continue()
    : json(route, new URL(route.request().url()).searchParams.get("source") === "generations" ? { generations: [], nextPageCursor: null } : { uploads: [still], nextCursor: null }));
  const pressedIdentity = { id: "soul_l5_new", projectId: null, name: "Lead", description: "", subjectType: "character", references: [{ uploadId: still.id }], previewUrl: null, createdAt: 2, updatedAt: 2, renderModel: "soul_2", status: "training", creditsBilled: null, error: null };
  await page.route("**/api/soul/identities", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    state.pressed = { body: route.request().postDataJSON() as Record<string, unknown> };
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ identity: { ...pressedIdentity, status: "submitting" } }) });
  });
  await page.route("**/api/soul/identities?**", (route) => {
    if (route.request().method() !== "GET") return route.abort();
    if (state.pressed) return json(route, { identities: [{ ...pressedIdentity, ...(state.pressedAs ?? {}) }], configured: true, generationAvailable: true, terms: { minPhotos: 1, maxPhotos: 40, trainingCredits: 54, versions: [{ version: "v1", trainingCredits: 54 }] } });
    const identity = state.stage === "none" ? [] : [{
      id: "soul_l5", projectId: null, name: "Lead v1", description: "", subjectType: "character", references: [], previewUrl: null, createdAt: 1, updatedAt: 1, renderModel: "soul_2",
      status: state.stage === "training" ? "training" : state.stage === "ready" ? "ready" : "failed",
      creditsBilled: state.stage === "failed" ? 0 : state.stage === "ready" ? 54 : null, error: state.stage === "failed" ? "Two photos are too dark" : null,
    }];
    return json(route, { identities: identity, configured: true, generationAvailable: true, terms: { minPhotos: 1, maxPhotos: 40, trainingCredits: 54, versions: [{ version: "v1", trainingCredits: 54 }] } });
  });
  /* Once a stage needs a training, the record names the identity it started, as a real training would link it. */
  await page.route("**/api/identity-consents?**", async (route) => {
    if (state.stage === "none" || route.request().method() !== "GET") return route.fallback();
    const real = await route.fetch();
    const body = await real.json() as { consents: { identityId: string | null }[] };
    return json(route, { consents: body.consents.map((c, i) => (i === 0 ? { ...c, identityId: "soul_l5" } : c)) });
  });
  return { project, productionProjectId, state, scope, workspaceId, paid: watchPaid(page) };
}

/** Everything on the card is drawn inside it: the title, every line and every button (nothing squeezed or cut). */
async function notClipped(card: ReturnType<Page["getByTestId"]>, where: string) {
  const out = await card.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>("[data-testid=cast-title], button, [data-testid=identity-consent], [data-testid=identity-failed]")]
      .filter((c) => c.getBoundingClientRect().height < 4 || c.getBoundingClientRect().bottom > box.bottom + 0.5)
      .map((c) => c.dataset.testid || c.textContent);
  });
  expect(out, `${where}: clipped on the card`).toEqual([]);
}

/**
 * The details, folded away under the tick. The tick is never inferred: a detail leaves the box as it is, and Save with
 * the box unticked saves nothing and says so. Only the person's own click on "Consent given" ticks it.
 */
async function recordConsent(page: Page, root: ReturnType<Page["getByTestId"]>, wait = 30_000) {
  await expect(root.getByTestId("consent-tick-box")).not.toBeChecked();
  await expect(root.getByTestId("consent-save")).not.toHaveAttribute("aria-disabled", /.*/);
  await expect(root.getByTestId("consent-person")).toBeHidden();
  await root.getByTestId("consent-more-head").click();
  await root.getByTestId("consent-person").fill("A Person");
  await expect(root.getByTestId("consent-tick-box")).not.toBeChecked();
  await root.getByTestId("consent-save").click();
  await expect(root.getByTestId("consent-problem")).toHaveText("Nothing saved. Tick Consent given to keep these details.");
  for (const id of ["consent-face", "consent-voice", "consent-use-production", "consent-use-identity", "consent-use-ads"]) await root.getByTestId(id).click();
  await root.getByTestId("consent-until").fill(new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10));
  await root.getByTestId("consent-file-input").setInputFiles({ name: "consent-statement.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(root.getByTestId("consent-recording-state")).toContainText("recorded just now", { timeout: wait });
  await root.getByTestId("consent-attest-box").check();
  await expect(root.getByTestId("consent-tick-box")).not.toBeChecked();
  await root.getByTestId("consent-tick-box").check();
  await expect(root.getByTestId("consent-save")).not.toHaveAttribute("aria-disabled", /.*/);
  await page.waitForTimeout(300);
}

test("Identity on the Cast card: not ticked, ticked and unticked on the card, the details, training, ready and failed; nothing paid", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || !desktop(page), "the board canvas is desktop only; phones record consent on their own screen (below)");
  const { project, state, paid } = await seed(page);
  const errors = watchErrors(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  const card = page.getByTestId("cast-card").filter({ hasText: "ivory coat" });
  /* The rail glides the board to the Cast region (.35 s) once its cards are drawn. */
  const toCast = async () => {
    await expect(card).toHaveCount(1);
    await page.waitForTimeout(500);
    await page.locator('[data-region="cast"]').click();
    await page.waitForTimeout(900);
  };
  await toCast();

  /* Not ticked: the tick, unticked, and Train Identity · 54 cr ready all the same (owner, 23 Oct 2026: a tick, not a gate). */
  await expect(card.getByTestId("cast-status")).toHaveText("No identity yet");
  await expect(card.getByTestId("identity-consent")).toHaveText("Not ticked. Only a person ticks it.");
  await expect(card.getByTestId("consent-tick-box")).not.toBeChecked();
  const train = card.getByTestId("identity-train");
  await expect(train).toHaveText("Train Identity · 54 cr");
  await expect(train).toBeEnabled();
  await expect(train).toHaveAttribute("data-spend", /.+/);
  await expect(train).not.toHaveAttribute("title", /.*/);
  await notClipped(card, "no consent");
  await floors(page, "Identity, no consent");
  await shot(page, "identity-none", info);

  /* Ticking on the card records who and when at once; unticking withdraws it (marked, never erased). */
  const ticked = page.waitForResponse((r) => r.url().endsWith("/api/identity-consents") && r.request().method() === "POST");
  await card.getByTestId("consent-tick-box").check();
  expect((await ticked).status()).toBe(201);
  await expect(card.getByTestId("consent-tick-box")).toBeChecked();
  await expect(card.getByTestId("cast-status")).toHaveText("Consent ticked · ready to train");
  await expect(card.getByTestId("identity-consent")).toHaveText(/^Ticked \d{1,2} \w{3} \d{4} by Identity Tester$/);
  await notClipped(card, "ticked");
  const unticked = page.waitForResponse((r) => r.url().includes("/api/identity-consents/") && r.request().method() === "DELETE");
  await card.getByTestId("consent-tick-box").uncheck();
  expect((await unticked).status()).toBe(200);
  await expect(card.getByTestId("consent-tick-box")).not.toBeChecked();
  await expect(card.getByTestId("cast-status")).toHaveText("No identity yet");
  await expect(card.getByTestId("identity-consent")).toHaveText(/^Consent withdrawn \d{1,2} \w{3} \d{4}$/);
  await expect(train).toBeEnabled();

  /* The details a person may add, folded away under the tick. */
  await card.getByTestId("consent-details").click();
  const dialog = page.getByTestId("consent-dialog");
  await expect(dialog.getByRole("dialog")).toBeVisible();
  await expect(dialog).toContainText("Only a person can tick this. Atomik can’t.");
  await recordConsent(page, dialog);
  await floors(page, "Identity, consent step");
  await shot(page, "identity-consent", info);
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/identity-consents") && r.request().method() === "POST");
  await dialog.getByTestId("consent-save").click();
  expect((await posted).status()).toBe(201);
  await expect(dialog).toHaveCount(0);

  /* Details again: they open on the live tick, ticked and filled, and Save edits it in place (no second tick). */
  await card.getByTestId("consent-details").click();
  await expect(dialog.getByTestId("consent-tick-box")).toBeChecked();
  await dialog.getByTestId("consent-more-head").click();
  await expect(dialog.getByTestId("consent-person")).toHaveValue("A Person");
  await expect(dialog.getByTestId("consent-recording-state")).toHaveText("statement on file");
  /* The tick's own file is kept for good: played, never replaced. */
  await expect(dialog.getByTestId("consent-record")).toHaveCount(0);
  await dialog.getByTestId("consent-person").fill("A Person, by release");
  const patched = page.waitForResponse((r) => r.url().includes("/api/identity-consents/") && r.request().method() === "PATCH");
  await dialog.getByTestId("consent-save").click();
  expect((await patched).status()).toBe(200);
  await expect(dialog).toHaveCount(0);

  /* Ticked with its details: the record in words, and Train Identity · 54 cr opens the build form armed with it. */
  await expect(card.getByTestId("cast-status")).toHaveText("Consent ticked · ready to train");
  await expect(card.getByTestId("consent-tick-box")).toBeChecked();
  await expect(card.getByTestId("identity-consent")).toContainText(/^Face and voice · this production, identity training, ads · until \d{1,2} \w{3} \d{4} · ticked \d{1,2} \w{3} \d{4} by Identity Tester$/);
  await expect(train).toBeEnabled();
  await expect(train).toHaveAttribute("data-spend", /.+/);
  await notClipped(card, "recorded");
  await shot(page, "identity-recorded", info);
  await train.click();
  await expect(page.getByTestId("soul-consent-record")).toContainText("Face and voice");
  await expect(page.getByTestId("soul-consent")).toHaveCount(0);
  await expect(page.getByTestId("soul-build")).toHaveText(/^Train Identity/);
  await shot(page, "identity-train-form", info);
  await page.keyboard.press("Escape");

  /* Training (no invented percentage), ready, and failed with what the ledger says was billed. */
  for (const [stage, status, check] of [
    ["training", "Training", async () => { await expect(card.getByTestId("identity-progress")).toBeVisible(); await expect(card.getByTestId("identity-progress")).not.toHaveAttribute("aria-valuenow", /.*/); }],
    ["ready", "Identity ready · Lead v1", async () => { await expect(card.getByTestId("identity-train")).toHaveCount(0); }],
    ["failed", "Training failed", async () => {
      await expect(card.getByTestId("identity-billed")).toHaveText("Nothing billed");
      await expect(card.getByTestId("identity-failed")).toContainText("Two photos are too dark");
      await expect(card.getByTestId("identity-retry")).toHaveText("Retry · 54 cr");
    }],
  ] as const) {
    state.stage = stage;
    await page.reload();
    await expect(page.getByTestId("board")).toBeVisible();
    await toCast();
    await expect(card.getByTestId("cast-status")).toHaveText(status);
    await check();
    await notClipped(card, stage);
    await floors(page, `Identity, ${stage}`);
    await shot(page, `identity-${stage}`, info);
  }
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
  await expect(page.locator("body")).not.toContainText(/\bMira\b|Sethi|Soul\b/);
});

test("The phone's consent tick: a person ticks it and may add the details, full screen, 44 px targets; nothing paid", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || !phone(page), "phones and the landscape phone; the board's dialog is above");
  const { project, paid } = await seed(page);
  const errors = watchErrors(page);
  const screen = page.getByTestId("phone-consent");
  /* On a cold dev server the first upload compiles routes and the dev client reloads the page once, mid-step (a dev
     artefact, not the product): the steps are then taken again from the top, on the warm server. */
  await expect(async () => {
    await page.goto(`/suites?project=${project.id}&screen=consent&cast=${encodeURIComponent("cast:cast:cast-lead")}`);
    await expect(screen).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(screen).toContainText("Consent · Lead");
    await recordConsent(page, screen, 15_000);
  }).toPass({ timeout: 100_000 });
  await floors(page, "Phone consent", "[data-testid=phone-consent]");
  await shot(page, "consent-phone", info);
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/identity-consents") && r.request().method() === "POST");
  await screen.getByTestId("consent-save").click();
  expect((await posted).status()).toBe(201);
  await expect(page.getByText(/^Consent ticked · until \d{1,2} \w{3} \d{4}$/)).toBeVisible();
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("A training pressed with no tick binds to the cast card: the card shows it training, with no second Train press; nothing reaches the server", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || !desktop(page), "the board canvas and its Train press are desktop only; phones have no Train press to repeat");
  const { project, state, paid } = await seed(page);
  const errors = watchErrors(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  const card = page.getByTestId("cast-card").filter({ hasText: "ivory coat" });
  await expect(card).toHaveCount(1);
  await page.waitForTimeout(500);
  await page.locator('[data-region="cast"]').click();
  await page.waitForTimeout(900);

  await expect(card.getByTestId("cast-status")).toHaveText("No identity yet");
  await expect(card.getByTestId("consent-tick-box")).not.toBeChecked();
  await card.getByTestId("identity-train").click();
  const insp = page.getByTestId("board-inspector");
  const form = insp.getByTestId("insp-build");
  await expect(form.getByTestId("soul-build")).toHaveText(/^Train Identity · 54 cr$/);
  await form.getByTestId("soul-still-upl_l5_face").click();
  /* The press, unticked: the browser answers it (202), so nothing trains or spends. */
  const saved = page.waitForResponse((r) => r.url().includes("/api/workbench/projects") && r.request().method() === "PUT");
  await form.getByTestId("soul-build").click();
  await expect.poll(() => state.pressed).not.toBeNull();
  expect(state.pressed!.body).not.toHaveProperty("consent");
  expect(state.pressed!.body).not.toHaveProperty("consentId");
  expect((await saved).ok()).toBe(true);

  /* The card follows the training it started: no "No identity yet", and no Train press to make again. */
  await expect(card.getByTestId("cast-status")).toHaveText("Training");
  await expect(card.getByTestId("identity-progress")).toBeVisible();
  await expect(card.getByTestId("identity-train")).toHaveCount(0);
  await expect(insp.getByTestId("insp-build")).toHaveCount(0);
  await shot(page, "identity-pressed-unticked", info);
  /* Bound through the Rig save: it holds after a reload. */
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("cast-status")).toHaveText("Training");
  await expect(card.getByTestId("identity-train")).toHaveCount(0);
  /* The one paid request was the press itself, answered in the browser. */
  expect(paid).toEqual(["/api/soul/identities"]);
  expect(errors).toEqual([]);
});

test("A training whose reply lands while another production is open: back in its own production the card offers Recover (the same request, never sent twice), never Train, then follows it; the other production is untouched", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || !desktop(page), "the board canvas and its Train press are desktop only; phones have no Train press to repeat");
  const { project, state, scope, workspaceId, paid } = await seed(page);
  /* A second production with the same cast entry id (ids such as cast-lead repeat across productions). The Invite plan
     holds one project, so this workspace is on Studio, as tests/helpers/v12Header.ts does (local mock servers only). */
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await platform.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [workspaceId] }); } finally { platform.close(); }
  const other = { ...project, ...newProject("Second fixture"), brief: project.brief, production: project.production };
  const savedOther = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project: other, revision: 0 } });
  expect(savedOther.ok(), await savedOther.text()).toBe(true);
  /* The first reply is held until the other production is open; the browser answers every press (nothing reaches the
     server), and each carries its idempotency key. */
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const keys: string[] = [];
  let answered = 0;
  await page.route("**/api/soul/identities", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await held;
    state.pressed = { body };
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ identity: { id: "soul_l5_new", projectId: null, name: "Lead", description: "", subjectType: "character", references: [], previewUrl: null, createdAt: 2, updatedAt: 2, renderModel: "soul_2", status: "submitting", creditsBilled: null, error: null } }) });
    answered++;
  });
  const errors = watchErrors(page);
  const card = page.getByTestId("cast-card").filter({ hasText: "ivory coat" });
  const toCast = async () => {
    await expect(page.getByTestId("board")).toBeVisible();
    await expect(card).toHaveCount(1);
    await page.waitForTimeout(500);
    await page.locator('[data-region="cast"]').click();
    await page.waitForTimeout(900);
  };
  await page.goto(`/suites?project=${project.id}&view=board`);
  await toCast();
  await expect(card.getByTestId("cast-status")).toHaveText("No identity yet");
  await card.getByTestId("identity-train").click();
  const insp = page.getByTestId("board-inspector");
  await insp.getByTestId("insp-build").getByTestId("soul-still-upl_l5_face").click();
  await insp.getByTestId("insp-build").getByTestId("soul-build").click();
  await expect.poll(() => keys.length).toBe(1);

  /* The other production opens while the press is out; then its reply lands. */
  await page.locator('[data-suite-tab="home"]').click();
  await page.locator(`[data-testid="home-project"][data-project="${other.id}"]`).click();
  await expect(page.locator('[data-suite-tab="project"] .gx-seg-label')).toHaveText("Second fixture");
  release();
  await expect.poll(() => answered).toBe(1);

  /* Back in its own production (after a reload, too): the card offers Recover, never a second Train press. */
  await page.goto(`/suites?project=${project.id}&view=board`);
  await toCast();
  await expect(card.getByTestId("cast-status")).toHaveText("Training sent · reply not read yet");
  await expect(card.getByTestId("identity-train")).toHaveCount(0);
  await shot(page, "identity-sent-elsewhere", info);
  /* Recover asks about that same request (the same key: never a second run, never charged twice), and the card follows. */
  await card.getByTestId("identity-recover").click();
  await insp.getByTestId("soul-recover-run").click();
  await expect.poll(() => answered).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect(card.getByTestId("cast-status")).toHaveText("Training");
  await expect(card.getByTestId("identity-train")).toHaveCount(0);
  await expect(card.getByTestId("identity-recover")).toHaveCount(0);
  await expect(insp.getByTestId("insp-build")).toHaveCount(0);
  /* The other production's card (the same cast entry id) was never bound to it, and still offers its own Train. */
  await page.goto(`/suites?project=${other.id}&view=board`);
  await toCast();
  await expect(card.getByTestId("cast-status")).toHaveText("No identity yet");
  await expect(card.getByTestId("identity-train")).toHaveCount(1);
  expect(paid).toEqual(["/api/soul/identities", "/api/soul/identities"]);
  expect(errors).toEqual([]);
});

test("A training whose cast member was renamed while it was out is held, with a way out: Attach or Not this card (each undoable), the tick still there, no Train until its outcome; then the outcome with its charge", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || !desktop(page), "the board canvas and its Train press are desktop only; phones have no Train press to repeat");
  const { project, scope, state, paid } = await seed(page);
  /* The training is listed (still training); its reply landed after the cast member was renamed, so its bind is parked
     under the name it was pressed for, as the app parks it (components/graphite/board/cards/cast/parked-binds.ts). */
  state.pressed = { body: {} };
  const key = `particl-parked-identity-binds:${scope}`;
  const bind = { projectId: project.id, entryId: "cast-lead", nodeId: null, name: "Old name", identityId: "soul_l5_new", at: Date.now() };
  await page.addInitScript(({ key, value }) => { try { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(key, value); sessionStorage.setItem("seeded", "1"); } } catch { /* storage off */ } }, { key, value: JSON.stringify([bind]) });
  const errors = watchErrors(page);
  const card = page.getByTestId("cast-card").filter({ hasText: "ivory coat" });
  const toCast = async () => {
    await expect(page.getByTestId("board")).toBeVisible();
    await expect(card).toHaveCount(1);
    await page.waitForTimeout(500);
    await page.locator('[data-region="cast"]').click();
    await page.waitForTimeout(900);
  };
  await page.goto(`/suites?project=${project.id}&view=board`);
  /* Opening the production tries the bind: the name no longer matches, so it is held, and the toast says what to do. */
  await expect(page.getByText("Training started for Old name, whose card was renamed. On that card: Attach, or Not this card.")).toBeVisible();
  await toCast();
  await expect(card.getByTestId("cast-status")).toHaveText("Training started for Old name");
  await expect(card.getByTestId("identity-train")).toHaveCount(0);
  /* The consent tick is still there (optional, never a gate). */
  await expect(card.getByTestId("consent-tick-box")).toBeVisible();
  await expect(card.getByTestId("identity-held-attach")).toHaveText("Attach to Lead");
  await shot(page, "identity-renamed-held", info);
  /* The Inspector offers no priced form while it is held. */
  await card.getByTestId("cast-title").click();
  const insp = page.getByTestId("board-inspector");
  await expect(insp.getByTestId("insp-cast")).toBeVisible();
  await expect(insp.getByTestId("insp-build")).toHaveCount(0);
  await page.keyboard.press("Escape");

  /* Not this card: the card is free to train; Undo holds it again. */
  await card.getByTestId("identity-held-dismiss").click();
  await expect(card.getByTestId("cast-status")).toHaveText("No identity yet");
  await expect(card.getByTestId("identity-train")).toHaveCount(1);
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(card.getByTestId("cast-status")).toHaveText("Training started for Old name");
  await expect(card.getByTestId("identity-train")).toHaveCount(0);

  /* Attach to Lead: the person says it is the same person; the card follows the training. Undo holds it again. */
  await card.getByTestId("identity-held-attach").click();
  await expect(card.getByTestId("cast-status")).toHaveText("Training");
  await expect(card.getByTestId("identity-train")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(card.getByTestId("cast-status")).toHaveText("Training started for Old name");

  /* Once its outcome is known, the card is no longer held: a failure says what it cost (rule 14), and Train is back. */
  state.pressedAs = { status: "failed", creditsBilled: 54, error: "Two photos are too dark" };
  await page.reload();
  await toCast();
  await expect(card.getByTestId("identity-held-outcome")).toHaveText("Training for Old name failed · Billed 54 cr");
  await expect(card.getByTestId("cast-status")).toHaveText("No identity yet");
  await expect(card.getByTestId("identity-train")).toHaveCount(1);
  await expect(card.getByTestId("identity-held-attach")).toHaveCount(0);
  await expect(card.getByTestId("identity-held-dismiss")).toHaveCount(1);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("A bind held under a cast member's earlier name lands when the card has that name again: reopened, the card follows the training", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || !desktop(page), "the board canvas is desktop only");
  const { project, scope, state, paid } = await seed(page);
  state.pressed = { body: {} };
  /* Parked under "Lead", the card's name again (renamed back): opening the production binds it. */
  const bind = { projectId: project.id, entryId: "cast-lead", nodeId: null, name: "Lead", identityId: "soul_l5_new", at: Date.now() };
  await page.addInitScript(({ key, value }) => { try { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(key, value); sessionStorage.setItem("seeded", "1"); } } catch { /* storage off */ } }, { key: `particl-parked-identity-binds:${scope}`, value: JSON.stringify([bind]) });
  const errors = watchErrors(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  const card = page.getByTestId("cast-card").filter({ hasText: "ivory coat" });
  await expect(card).toHaveCount(1);
  await page.waitForTimeout(500);
  await page.locator('[data-region="cast"]').click();
  await page.waitForTimeout(900);
  await expect(card.getByTestId("cast-status")).toHaveText("Training");
  await expect(card.getByTestId("identity-train")).toHaveCount(0);
  /* Bound through the Rig save: it holds after a reload, with nothing parked any more. */
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
  await page.waitForTimeout(500);
  await page.locator('[data-region="cast"]').click();
  await page.waitForTimeout(900);
  await expect(card.getByTestId("cast-status")).toHaveText("Training");
  expect(await page.evaluate((key) => localStorage.getItem(key), `particl-parked-identity-binds:${scope}`)).toBeNull();
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});
