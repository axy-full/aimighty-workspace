import { test, expect, type Page } from "@playwright/test";
import { openBoard } from "./helpers/boardV12";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * The Social · narrated board's Voice stage in the new interface (redesign P6-b; components/v12/board/social; docs/redesign/
 * inventory.md § 10.2): a Narrator card (a voice from this workspace's sound setup, the lines, "Make the narration · up to N cr")
 * and, where the workspace can make music, a Music bed card. Both open Make's audio mode with the words filled in. The price is the
 * server's live quote of the take as written. Nothing spends: the sound setup and its quote are answered here by fixtures, and
 * Make is only opened. The other Social stages keep today's cards.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const SETUP = {
  configured: true, vendors: { elevenlabs: true, xai: false },
  speechModels: [{ id: "speech-model-a", label: "Speech A" }], defaultSpeechModel: "speech-model-a",
  voices: [{ id: "voice-a", name: "Voice A" }, { id: "voice-b", name: "Voice B" }], voicesError: null,
};
const LINES = "A line about the harbour at first light.";

function narrated(extra: Partial<Project> = {}): Project {
  return { ...newProject("Spoken piece"), boardKind: "social", boardFlavor: "narrated", ...extra } as Project;
}

/** The sound setup and its quote, as fixtures: every quote-only request is kept, and anything else that could spend is counted. */
async function mocks(page: Page, setup: unknown = SETUP) {
  const quotes: Record<string, unknown>[] = [];
  const paid: string[] = [];
  await page.route((url) => url.pathname === "/api/audio", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: setup });
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.quoteOnly === true) {
      quotes.push(body);
      const credits = body.task === "music" ? 12 : Math.max(1, Math.ceil(String(body.text ?? "").length / 10));
      return route.fulfill({ json: { unit: "cr", price: credits, estimatedCredits: credits } });
    }
    paid.push("POST /api/audio");
    return route.fulfill({ status: 500, json: { error: "A test never spends." } });
  });
  page.on("request", (r) => { const path = new URL(r.url()).pathname; if (r.method() !== "GET" && /^\/api\/(generate$|soul|rig\/runs)/.test(path)) paid.push(`${r.method()} ${path}`); });
  return { quotes, paid };
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Voice: pick a voice, write the lines, the button shows the server's live price, and it opens Make's audio mode with the words in; nothing spends", async ({ page }) => {
    const { errors } = await openBoard(page, "/suites?view=board&stage=voice", { project: narrated() });
    const seen = await mocks(page);
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("SOCIAL · NARRATED", { timeout: 60_000 });
    await expect(page.getByTestId("v12-voice-stage")).toBeVisible();
    await expect(page.getByTestId("v12-narrator")).toContainText("Voice A", { timeout: 30_000 });
    await expect(page.getByTestId("v12-voice-pick").locator("option")).toHaveText(["Voice A", "Voice B"]);
    /* With nothing written there is nothing to price: no figure, and the button says what to do first. */
    const make = page.getByTestId("v12-voice-make");
    await expect(make).toHaveText("Write the lines first");
    await expect(make).toBeDisabled();
    expect(seen.quotes).toEqual([]);
    /* The lines are priced as written, in the picked voice, quote-only. */
    await page.getByTestId("v12-voice-lines").fill(LINES);
    await expect(make).toHaveText(/^Make the narration · up to \d+ cr$/, { timeout: 30_000 });
    await expect(make).toBeEnabled();
    await expect(make).toHaveAttribute("data-spend", "priced");
    expect(seen.quotes.at(-1)).toMatchObject({ task: "speech", text: LINES, voiceId: "voice-a", modelId: "speech-model-a", quoteOnly: true });
    const one = await make.innerText();
    /* Another voice asks the server again; the figure on the button is always its answer. */
    await page.getByTestId("v12-voice-pick").selectOption("voice-b");
    await expect.poll(() => seen.quotes.at(-1)?.voiceId, { timeout: 30_000 }).toBe("voice-b");
    await expect(make).toHaveText(/^Make the narration · up to \d+ cr$/);
    expect(await make.innerText()).toBe(one);
    /* More words cost more: the price follows the text. */
    await page.getByTestId("v12-voice-lines").fill(`${LINES} ${LINES} ${LINES}`);
    await expect.poll(async () => Number((await make.innerText()).replace(/[^\d]/g, "")), { timeout: 30_000 }).toBeGreaterThan(Number(one.replace(/[^\d]/g, "")));
    expect(await noSideways(page)).toBe(true);
    /* Press: Make opens in its audio mode with the lines and the voice. It runs nothing. */
    await make.click();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("v12-make")).toContainText("Narration · Voice B");
    await expect(page.getByRole("radio", { name: "Audio" })).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Describe it" })).toHaveValue(new RegExp(LINES));
    expect(seen.paid, "opening Make runs nothing").toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Make lands on the narration's own model even when the person's last audio model was another, and quotes what the button showed", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=voice", { project: narrated() });
    const seen = await mocks(page);
    /* The person's last audio model becomes the music engine: a bed was opened in Make just before. */
    await expect(page.getByTestId("v12-bed")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("v12-bed-text").fill("Slow strings, warm room.");
    await expect(page.getByTestId("v12-bed-make")).toHaveText(/up to \d+ cr/, { timeout: 30_000 });
    await page.getByTestId("v12-bed-make").click();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("v12-make-chip-model")).toContainText(/music/i, { timeout: 30_000 });
    /* Back on the board, the narration: Make must land on the speech model, not stay on the music one. */
    await page.getByRole("navigation", { name: "Tabs" }).getByText("Spoken piece").first().click();
    await page.getByTestId("v12-stage-rail").getByText("Voice", { exact: true }).click();
    await expect(page.getByTestId("v12-voice-lines")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("v12-voice-lines").fill(LINES);
    const make = page.getByTestId("v12-voice-make");
    await expect(make).toHaveText(/^Make the narration · up to \d+ cr$/, { timeout: 30_000 });
    const stageBody = seen.quotes.filter((q) => q.task === "speech").at(-1)!;
    expect(stageBody).toMatchObject({ text: LINES, voiceId: "voice-a", modelId: "speech-model-a" });
    const before = seen.quotes.length;
    await make.click();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("v12-make-chip-model")).toContainText(/speech model a/i, { timeout: 30_000 });
    await expect(page.getByTestId("v12-make-chip-model")).not.toContainText(/music/i);
    /* Make's own quote-only request for what it now holds is the stage's request. */
    await expect.poll(() => seen.quotes.slice(before).some((q) => JSON.stringify(q) === JSON.stringify(stageBody)), { timeout: 30_000 }).toBe(true);
    expect(seen.paid).toEqual([]);
  });

  test("Music bed shows only where music can be made, with its own live price, and opens Make's audio mode", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=voice", { project: narrated() });
    const seen = await mocks(page);
    await expect(page.getByTestId("v12-bed")).toBeVisible({ timeout: 60_000 });
    const make = page.getByTestId("v12-bed-make");
    await expect(make).toHaveText("Describe the bed first");
    await expect(make).toBeDisabled();
    await page.getByTestId("v12-bed-text").fill("Slow strings, warm room.");
    await expect(make).toHaveText(/^Make a bed · up to \d+ cr$/, { timeout: 30_000 });
    expect(seen.quotes.at(-1)).toMatchObject({ task: "music", instrumental: true, quoteOnly: true });
    await make.click();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("v12-make")).toContainText("Music bed");
    await expect(page.getByRole("textbox", { name: "Describe it" })).toHaveValue("Slow strings, warm room.");
    expect(seen.paid).toEqual([]);
  });

  test("a workspace that cannot make music has no Music bed card; one with no sound connected says so and offers nothing", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=voice", { project: narrated() });
    await mocks(page, { ...SETUP, vendors: { elevenlabs: false, xai: true } });
    await expect(page.getByTestId("v12-voice-stage")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-voice-lines")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("v12-bed")).toHaveCount(0);
    await page.reload();
    await page.unroute((url) => url.pathname === "/api/audio").catch(() => {});
    await mocks(page, { configured: false, speechModels: [], defaultSpeechModel: "", voices: [], voicesError: null });
    await expect(page.getByTestId("v12-voice-off")).toContainText("Sound is not connected for this workspace.", { timeout: 60_000 });
    for (const id of ["v12-voice-lines", "v12-voice-make", "v12-bed"]) await expect(page.getByTestId(id)).toHaveCount(0);
  });

  test("a sound setup that cannot be read says so", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=voice", { project: narrated() });
    await page.route((url) => url.pathname === "/api/audio", (route) => route.fulfill({ status: 502, json: { error: "The sound engine did not answer." } }));
    await page.reload();
    await expect(page.getByTestId("v12-voice-failed")).toContainText("did not answer", { timeout: 60_000 });
    await expect(page.getByTestId("v12-voice-make")).toHaveCount(0);
  });

  test("Ask Atomik on each card fills the words in Atomik's field, and sends nothing", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=voice", { project: narrated() });
    const seen = await mocks(page);
    const field = page.locator("textarea:visible").last();
    await expect(page.getByTestId("v12-voice-ask")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("v12-voice-ask").click();
    await expect(field).toHaveValue(/Write the narration lines/, { timeout: 15_000 });
    await page.getByTestId("v12-bed-ask").click();
    await expect(field).toHaveValue(/Describe a music bed/, { timeout: 15_000 });
    expect(seen.paid).toEqual([]);
  });

  test("the other Social stages, and a clips board's stages, keep today's cards: no stage page", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=scenes", { project: narrated() });
    await expect(page.locator(".react-flow__pane")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-page")).toHaveCount(0);
    await expect(page.getByTestId("v12-voice-stage")).toHaveCount(0);
  });

  test("switch off: today's Social board, with no Voice page", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=voice", { on: false, project: narrated() });
    await expect(page.locator(".react-flow__pane")).toBeVisible({ timeout: 60_000 });
    for (const id of ["v12-voice-stage", "v12-stage-page"]) await expect(page.getByTestId(id)).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("the phone app keeps today's board: no Voice page", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=voice", { project: narrated() });
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-voice-stage")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });
});
