import { test, expect, type Page } from "@playwright/test";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openBoard } from "../helpers/boardV12";
import { newProject, type Project } from "../../lib/workbench/studio";

/*
 * The Social · narrated Voice stage (redesign P6-b) beside prototype 12's URL `project=social&stage=Voice`. The sound setup and its
 * quote are answered by fixtures and Make is never opened; nothing is generated or spent.
 */
test.afterAll(closePrototypeServer);

const SETUP = {
  configured: true, vendors: { elevenlabs: true, xai: false },
  speechModels: [{ id: "speech-model-a", label: "Speech A" }], defaultSpeechModel: "speech-model-a",
  voices: [{ id: "voice-a", name: "Voice A" }, { id: "voice-b", name: "Voice B" }], voicesError: null,
};
const narrated = (): Project => ({ ...newProject("Spoken piece"), boardKind: "social", boardFlavor: "narrated" } as Project);
async function mocks(page: Page) {
  await page.route((url) => url.pathname === "/api/audio", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: SETUP });
    const body = request.postDataJSON() as Record<string, unknown>;
    const credits = body.task === "music" ? 12 : Math.max(1, Math.ceil(String(body.text ?? "").length / 10));
    return route.fulfill({ json: { unit: "cr", price: credits, estimatedCredits: credits } });
  });
}

test("social · Voice, the narrator with its lines priced, and the music bed", async ({ page }) => {
  test.setTimeout(240_000);
  await openBoard(page, "/suites?view=board&stage=voice", { project: narrated() });
  await mocks(page);
  await expect(page.getByTestId("v12-stage-kind")).toHaveText("SOCIAL · NARRATED", { timeout: 60_000 });
  await expect(page.getByTestId("v12-narrator")).toContainText("Voice A", { timeout: 30_000 });
  await page.getByTestId("v12-voice-lines").fill("A line about the harbour at first light. Then the first boat goes out.");
  await page.getByTestId("v12-bed-text").fill("Slow strings, a warm room.");
  await expect(page.getByTestId("v12-voice-make")).toHaveText(/up to \d+ cr/, { timeout: 30_000 });
  await expect(page.getByTestId("v12-bed-make")).toHaveText(/up to \d+ cr/, { timeout: 30_000 });
  await page.mouse.move(700, 120);
  await page.waitForTimeout(1200);
  await captureBeside(page, "social-voice", "?view=board&project=social&stage=Voice");
});
