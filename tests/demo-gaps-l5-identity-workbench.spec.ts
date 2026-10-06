import { test, expect, type Page, type Route } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject } from "../lib/workbench/studio";
import { SIZES, desktop, floors, phone, shot, silentWav, watchErrors, watchPaid } from "./helpers/l5";

/*
 * Lane 5 · Identity on the Cast card for the lead (Gaps A). Real local ENGINE_MOCK=1 server and routes: a person
 * records consent (whose face and voice, uses, end date, a recording, the attest box) through the real consent route
 * and a real upload; the card reads it back; Train Identity · 54 cr then opens the build form armed with it. The
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

  const state = { stage: "none" as Stage };
  const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/workbench/library?**", (route) => route.request().method() !== "GET" ? route.continue()
    : json(route, new URL(route.request().url()).searchParams.get("source") === "generations" ? { generations: [], nextPageCursor: null } : { uploads: [], nextCursor: null }));
  await page.route("**/api/soul/identities?**", (route) => {
    if (route.request().method() !== "GET") return route.abort();
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
  return { project, productionProjectId, state, paid: watchPaid(page) };
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

async function recordConsent(page: Page, root: ReturnType<Page["getByTestId"]>) {
  await root.getByTestId("consent-person").fill("A Person");
  await root.getByTestId("consent-use-ads").click();
  await expect(root.getByTestId("consent-save")).toHaveAttribute("aria-disabled", "true");
  await root.getByTestId("consent-file-input").setInputFiles({ name: "consent-statement.wav", mimeType: "audio/wav", buffer: silentWav() });
  await expect(root.getByTestId("consent-recording-state")).toContainText("recorded just now", { timeout: 30_000 });
  await root.getByTestId("consent-attest-box").check();
  await expect(root.getByTestId("consent-save")).not.toHaveAttribute("aria-disabled", /.*/);
  await page.waitForTimeout(300);
}

test("Identity on the Cast card: consent not recorded, the consent step, consent on file, training, ready and failed; nothing paid", async ({ page }, info) => {
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

  /* Consent not recorded: Record consent, and Train Identity · 54 cr disabled until a record exists. */
  await expect(card.getByTestId("cast-status")).toHaveText("Consent not recorded");
  await expect(card.getByTestId("identity-consent")).toHaveText("Not recorded yet. Only a person records it.");
  await expect(card.getByTestId("identity-record-consent")).toHaveText("Record consent");
  const train = card.getByTestId("identity-train");
  await expect(train).toHaveText("Train Identity · 54 cr");
  await expect(train).toBeDisabled();
  await expect(train).toHaveAttribute("title", "Needs a consent record first");
  await notClipped(card, "no consent");
  await floors(page, "Identity, no consent");
  await shot(page, "identity-none", info);

  /* The consent step a person completes. */
  await card.getByTestId("identity-record-consent").click();
  const dialog = page.getByTestId("consent-dialog");
  await expect(dialog.getByRole("dialog")).toBeVisible();
  await expect(dialog).toContainText("Only a person can record this. Atomik can’t.");
  await recordConsent(page, dialog);
  await floors(page, "Identity, consent step");
  await shot(page, "identity-consent", info);
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/identity-consents") && r.request().method() === "POST");
  await dialog.getByTestId("consent-save").click();
  expect((await posted).status()).toBe(201);
  await expect(dialog).toHaveCount(0);

  /* Consent on file: the record in words, and Train Identity · 54 cr opens the build form armed with it. */
  await expect(card.getByTestId("cast-status")).toHaveText("Consent recorded · ready to train");
  await expect(card.getByTestId("identity-consent")).toContainText(/^Face and voice · this production, ads · until \d{1,2} \w{3} \d{4} · recorded \d{1,2} \w{3} \d{4} by Identity Tester$/);
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

test("The phone's consent step: a person records it, full screen, 44 px targets; nothing paid", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name) || !phone(page), "phones and the landscape phone; the board's dialog is above");
  const { project, paid } = await seed(page);
  /* Warm-up: on a cold dev server the upload routes compile on first use and the dev client reloads the page mid-upload.
     Asking each once first (refused: no file) keeps that reload out of the person's steps. */
  for (const step of ["session", "chunk", "finish"]) await page.request.post(`/api/uploads/${step}`, { data: {} });
  const errors = watchErrors(page);
  await page.goto(`/suites?project=${project.id}&screen=consent&cast=${encodeURIComponent("cast:cast:cast-lead")}`);
  const screen = page.getByTestId("phone-consent");
  await expect(screen).toBeVisible();
  /* The shell settles the address once (it adds the default page); wait for it, so the form isn't drawn twice mid-fill. */
  await page.waitForLoadState("networkidle");
  await expect(screen).toBeVisible();
  await expect(screen).toContainText("Record consent · Lead");
  await recordConsent(page, screen);
  await floors(page, "Phone consent", "[data-testid=phone-consent]");
  await shot(page, "consent-phone", info);
  const posted = page.waitForResponse((r) => r.url().endsWith("/api/identity-consents") && r.request().method() === "POST");
  await screen.getByTestId("consent-save").click();
  expect((await posted).status()).toBe(201);
  await expect(page.getByText(/^Consent recorded · by you · until \d{1,2} \w{3} \d{4}$/)).toBeVisible();
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});
