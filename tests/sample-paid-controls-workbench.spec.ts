import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject } from "../lib/workbench/studio";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { PHONES, seedPhoneStates, signedInWarm, watchErrors } from "./helpers/r1-gaps";
import { isCompact } from "./helpers/shellMode";
import { adsUrl, desktop, mockReads, seedAds } from "./helpers/s11-board";
import { seedCut } from "./helpers/gaps-l3";
import { SAMPLE_LINE } from "../lib/demo/sample";

/**
 * The sample workspace offers no priced control (M1 of the review of fix/sample-paid-off): the server refuses every paid
 * door there, and the screens do not offer one to be refused. The same surface is read in three workspaces: another one
 * (the control is there, priced), the sample workspace, and one whose GET /api/demo/sample FAILS (it reads as the sample,
 * as the server treats a workspace it cannot check). The answer is mocked at the route, so nothing here is marked, and
 * nothing paid is sent: every paid route is forbidden. Quotes may still show as information; only controls are checked.
 */
type Mode = "other" | "sample" | "failed";
const MODES: Mode[] = ["other", "sample", "failed"];

/** Answers GET /api/demo/sample for the page; `state.mode` can change between loads. */
async function answerSample(page: Page, state: { mode: Mode }) {
  await page.route("**/api/demo/sample", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (state.mode === "failed") return route.fulfill({ status: 500, json: { error: "unavailable" } });
    return route.fulfill({ json: state.mode === "sample" ? { board: null, sampleWorkspace: true } : { board: null } });
  });
}
/** Every paid POST that leaves the page. */
function watchPaid(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "POST" || !/\/api\/(generate$|jobs\/[^/]+\/release|workbench\/team-canvas|atomik$|audio)/.test(new URL(r.url()).pathname)) return;
    /* A quote reads a price and charges nothing. */
    const body = (() => { try { return r.postDataJSON() as Record<string, unknown> | null; } catch { return null; } })();
    if (body?.quoteOnly !== true) sent.push(new URL(r.url()).pathname);
  });
  return sent;
}
/** `count` of a control: present (1) in another workspace, gone (0) in the sample and when the read failed. */
async function offered(locator: Locator, mode: Mode, present = 1) {
  await expect(locator).toHaveCount(mode === "other" ? present : 0);
}

/* ── ⌘K ───────────────────────────────────────────────────────────────────────────────────────────────────────────── */

async function palette(page: Page, state: { mode: Mode }) {
  const workspaceId = (await signInWithNewInterface(page.request, "Sample Palette")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = { ...newProject("Palette fixture"), brief: "A short film about a morning market opening." };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope: key, id }) => { try { localStorage.setItem(key, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await forbidPaidWork(page);
  await answerSample(page, state);
  return { project };
}

test("⌘K: a request to Atomik has no priced Ask in the sample (nor when the read fails), a question stays free, another workspace keeps both", async ({ page }) => {
  const state = { mode: "other" as Mode };
  const sent = watchPaid(page);
  const { project } = await palette(page, state);
  for (const mode of MODES) {
    state.mode = mode;
    await page.goto(`/suites?project=${project.id}&palette=1&q=${encodeURIComponent("plan a short film about the market at dawn")}`);
    const card = page.getByTestId("palette-atomik-card");
    await expect(card).toContainText("Ask Atomik: plan a short film about the market at dawn");
    await offered(card.getByTestId("palette-ask"), mode);
    if (mode === "other") {
      await expect(card.getByTestId("palette-ask")).toHaveText(/^Ask · up to \d+ cr$/, { timeout: 15_000 });
    } else {
      await expect(card.getByTestId("palette-thinking-line")).toHaveText(SAMPLE_LINE);
      await expect(card).not.toContainText(/\d\s*cr\b/);
      /* Enter in the search box does not hand a request on either: nothing is asked, nothing is priced. */
      await page.getByRole("textbox", { name: "Search" }).press("Enter");
    }
    /* A question about Particl is free in every workspace: it is still offered. */
    await page.getByRole("textbox", { name: "Search" }).fill("how do I add a reference to a shot?");
    await expect(card.getByTestId("palette-ask")).toHaveText("Ask · free");
  }
  expect(sent).toEqual([]);
});

/** The approvals queue, answered by a fixture (stream 8's route): a held take and an admin's, as the page reads them. */
const QUEUE = {
  inCredits: true,
  items: [
    { id: "held:gen_fx_a", source: "held", title: "Keyframe retake", at: Date.now() - 3_000_000, price: { kind: "exact", credits: 3 }, where: "Make", project: { productionId: "prod_fx", draftId: null, name: "Project one" },
      needsAdmin: false, canApprove: true, why: null, shortBy: null, step: null, sample: false, note: "It starts when credits arrive; nothing is spent until then",
      approve: { kind: "release", genId: "gen_fx_a", credits: 3 }, decline: { kind: "discard", genId: "gen_fx_a" }, open: { kind: "take", genId: "gen_fx_a", draftId: null } },
    { id: "thread:ach_fx", source: "thread", title: "Plan three takes", at: Date.now() - 2_000_000, price: { kind: "up-to", credits: 2 }, where: "Atomik", project: { productionId: "prod_fx", draftId: null, name: "Project one" },
      needsAdmin: false, canApprove: true, why: null, shortBy: null, step: { n: 1, of: 3 }, sample: false, note: "Step 1 of 3 · Keyframes",
      approve: { kind: "thread", chatId: "ach_fx", stepId: "astp_fx", productionId: "prod_fx" }, decline: { kind: "thread-stop", stepId: "astp_fx" }, open: { kind: "thread", chatId: "ach_fx", productionId: "prod_fx" } },
  ],
  decided: [],
};

test("⌘K: Approve everything under N cr lists and approves nothing in the sample", async ({ page }) => {
  const state = { mode: "other" as Mode };
  const sent = watchPaid(page);
  const { project } = await palette(page, state);
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: QUEUE }));
  for (const mode of MODES) {
    state.mode = mode;
    await page.goto(`/suites?project=${project.id}&palette=1&q=${encodeURIComponent("approve everything under 10 cr")}`);
    const card = page.getByTestId("palette-approve-card");
    await expect(card).toBeVisible();
    await offered(card.getByTestId("palette-approve-confirm"), mode);
    if (mode === "other") await expect(card.getByTestId("palette-approve-confirm")).toHaveAttribute("data-spend", "priced");
    else {
      await expect(card).toContainText(SAMPLE_LINE);
      await expect(card.getByTestId("palette-approve-row")).toHaveCount(0);
    }
  }
  expect(sent).toEqual([]);
});

/* ── The control room and Home ────────────────────────────────────────────────────────────────────────────────────── */

test("Approvals: no Approve, no Continue, no Approve in one go in the sample; another workspace keeps them", async ({ page }, info) => {
  test.skip(isCompact(info), "desktop widths: the phone's own rows are the next test");
  const state = { mode: "other" as Mode };
  const sent = watchPaid(page);
  await signInWithNewInterface(page.request);
  await forbidPaidWork(page);
  await answerSample(page, state);
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: QUEUE }));
  for (const mode of MODES) {
    state.mode = mode;
    await page.goto("/suites?suite=atomik&page=approvals");
    await expect(page.getByTestId("approvals")).toBeVisible();
    await expect(page.getByTestId("approval-row")).toHaveCount(2);
    await offered(page.getByTestId("approve-in-one-go"), mode);
    await offered(page.getByTestId("batch-confirm"), mode);
    await offered(page.getByTestId("approval-approve"), mode, 2);
    await offered(page.getByTestId("approval-approve").filter({ hasText: /\d\s*cr/ }), mode, 2);
    /* The plan step's Continue is not reachable either (its button is the row's Approve, which is gone). */
    await expect(page.getByTestId("approval-continue")).toHaveCount(0);
    if (mode !== "other") await expect(page.getByTestId("approval-row").first()).toContainText(SAMPLE_LINE);
  }
  expect(sent).toEqual([]);
});

test("Home: Waiting for you offers no Approve in the sample (desktop strip and phone rows)", async ({ page }, info) => {
  const state = { mode: "other" as Mode };
  const sent = watchPaid(page);
  await signInWithNewInterface(page.request);
  await forbidPaidWork(page);
  await answerSample(page, state);
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: QUEUE }));
  const phone = isCompact(info);
  for (const mode of MODES) {
    state.mode = mode;
    await page.goto("/suites?view=home");
    if (phone) {
      await expect(page.getByTestId("phone-home")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("phone-approval-row")).toHaveCount(2);
      /* The plan's step keeps its Open (it opens the plan; it spends nothing). */
      await offered(page.getByTestId("phone-row-approve"), mode);
      await offered(page.locator('[data-testid="phone-approval-row"] button[data-spend], [data-testid="phone-approval-row"] .ph-btn--price'), mode);
    } else {
      await expect(page.getByTestId("home-waiting-row").first()).toBeVisible({ timeout: 60_000 });
      await offered(page.getByTestId("home-waiting-approve"), mode, 1);
    }
  }
  expect(sent).toEqual([]);
});

/* ── A held take ──────────────────────────────────────────────────────────────────────────────────────────────────── */

test("A held take: no Release in the sample (the States screen, at every size); another workspace keeps it", async ({ page }, info) => {
  test.setTimeout(240_000);
  const state = { mode: "other" as Mode };
  const sent = watchPaid(page);
  const errors = watchErrors(page);
  await signedInWarm(page);
  const seeded = await seedPhoneStates(page, { kinds: ["held"], heldNeeds: 15 });
  await answerSample(page, state);
  const framed = PHONES.includes(info.project.name) ? "" : "&device=phone";
  for (const mode of MODES) {
    state.mode = mode;
    await page.goto(`/suites?project=${seeded.project.id}&screen=states${framed}`);
    const card = page.getByTestId("phone-state-card").filter({ hasText: "Held" });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await offered(card.getByTestId("take-release"), mode);
    if (mode === "other") await expect(card.getByTestId("take-release")).toContainText("15");
  }
  expect(sent).toEqual([]);
  expect(errors).toEqual([]);
});

/* ── The boards and the Make panel ────────────────────────────────────────────────────────────────────────────────── */

test("The Ads board: no Make the image ad in the sample; another workspace keeps it", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  test.setTimeout(180_000);
  const state = { mode: "other" as Mode };
  const sent = watchPaid(page);
  await mockReads(page);
  const { project } = await seedAds(page);
  await answerSample(page, state);
  for (const mode of MODES) {
    state.mode = mode;
    await page.goto(adsUrl(project.id, "&frame=1"));
    await expect(page.getByTestId("ads-product")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("board-rail").locator('[data-region="ads"]').click();
    const ad = page.getByTestId("ads-image-ad");
    await expect(ad).toBeVisible();
    await offered(ad.getByTestId("ads-image-ad-make"), mode);
    if (mode !== "other") await expect(ad.getByTestId("ads-image-ad-engine")).not.toContainText(/\d\s*cr\b/);
    await expect(page.getByTestId("board-sample").first()).toHaveCount(mode === "other" ? 0 : 1);
  }
  expect(sent).toEqual([]);
});

test("Edit & Sound: no New voice line, music or sound effect in the sample (the free tools stay); another workspace keeps them", async ({ page }) => {
  test.skip(!desktop(page), "the board is the desktop's");
  test.setTimeout(180_000);
  const state = { mode: "other" as Mode };
  const sent = watchPaid(page);
  const seeded = await seedCut(page, "Edit Sample");
  await answerSample(page, state);
  for (const mode of MODES) {
    state.mode = mode;
    await page.goto(`/suites?project=${seeded.project.id}&view=board`);
    await expect(page.getByTestId("cut-card")).toBeVisible();
    await page.locator('[data-region="cut"]').click();
    await page.waitForTimeout(700);
    await page.getByTestId("cut-open-edit").click();
    const es = page.getByTestId("es");
    await expect(es).toBeVisible();
    for (const id of ["es-new-voice", "es-new-music", "es-new-effect"]) await offered(es.getByTestId(id), mode);
    await expect(es.getByTestId("es-compose")).toHaveCount(0);
    /* What is free stays: the browser export, and the sound lanes' toggle. */
    await expect(es.getByTestId("es-export")).toHaveText("Export the cut · free");
    await expect(es.getByTestId("es-clip-audio")).toBeVisible();
  }
  expect(sent).toEqual([]);
});

test("Make › Motion transfer and Object swap: no run button and no estimate in the sample; another workspace keeps it", async ({ page }, info) => {
  test.skip(isCompact(info), "the phone app draws its own simple Make, which has no motion or swap tool");
  const state = { mode: "other" as Mode };
  const sent = watchPaid(page);
  await signInWithNewInterface(page.request);
  await forbidPaidWork(page);
  await answerSample(page, state);
  for (const tool of ["motion", "swap"] as const) {
    for (const mode of MODES) {
      state.mode = mode;
      await page.goto(`/suites?make=${tool}`);
      await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", tool, { timeout: 60_000 });
      await offered(page.getByTestId("viral-generate"), mode);
      if (mode !== "other") {
        await expect(page.getByTestId("viral-reason")).toHaveText(SAMPLE_LINE);
        await expect(page.getByTestId("make-engine-price")).toHaveCount(0);
      }
    }
  }
  expect(sent).toEqual([]);
});

/** The page is the sample's when the line says so; kept so a rename of the line is caught in one place. */
test("the sample's line is the existing one", () => {
  expect(SAMPLE_LINE).toBe("Sample production · nothing here spends credits");
});

