import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";

test("audio uses the server quote and recovers one exact request across reload without sharing drafts", async ({
  page,
}, testInfo) => {
  const first = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const submissions: {
    key: string | undefined;
    body: Record<string, unknown>;
  }[] = [];
  let held = false,
    holdQuote = false,
    releaseQuote = () => {};
  const barrier = new Promise<void>((resolve) => {
    releaseQuote = resolve;
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/audio") {
      if (request.method() === "GET")
        return json({
          configured: true,
          speechModels: [
            {
              id: "mock-speech",
              label: "Mock speech",
              creditsPerChar: 0.1,
              note: "Local test",
            },
          ],
          defaultSpeechModel: "mock-speech",
          voices: [
            {
              id: "mock-voice",
              name: "Avery",
              category: "premade",
              labels: { language: "English" },
              previewUrl: null,
              description: "Mock voice",
            },
          ],
          voicesError: null,
          account: null,
          terms: { sfxCredits: 200, musicCreditsPerMinute: 900 },
        });
      const body = request.postDataJSON();
      if (body.quoteOnly) {
        if (body.text.includes("Unavailable"))
          return json(
            { error: "Audio quotes are temporarily unavailable." },
            503,
          );
        if (holdQuote) {
          held = true;
          await barrier;
        }
        return json({
          estimatedCredits: body.text.includes("Revised") ? 21 : 14,
          price: body.text.includes("Revised") ? 21 : 14,
          unit: "cr",
        });
      }
      submissions.push({ key: request.headers()["idempotency-key"], body });
      return submissions.length === 1
        ? json({ error: "Submission response is uncertain. Recover it." }, 503)
        : json({ id: "mock-audio-generation", status: "running" });
    }
    if (request.method() !== "GET")
      throw new Error(`Unexpected paid/mutating browser request: ${path}`);
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/productions") return json({ productions: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/me") return json(me);
    return route.fallback();
  });
  await page.goto("/make/audio");
  await page.evaluate(() =>
    localStorage.setItem(
      "aw_draft:make:audio",
      "A different account’s legacy prompt",
    ),
  );
  await page.reload();
  const mobile = page.viewportSize()!.width < 768;
  const open = async () => {
    if (mobile)
      await page
        .getByRole("button", { name: "Open the composer", exact: true })
        .click();
  };
  await open();
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(prompt).toHaveValue("");
  await prompt.fill("An isolated audio test line.");
  const render = page.locator("[data-render]").filter({ visible: true }).last();
  await expect(render).toContainText("14 cr");
  await expect(render).toBeEnabled();
  holdQuote = true;
  await prompt.fill("Revised audio test line.");
  await expect(render).toBeDisabled();
  await expect.poll(() => held).toBeTruthy();
  releaseQuote();
  await expect(render).toContainText("21 cr");
  await expect(render).toBeEnabled();
  await render.click();
  await expect(render).toContainText("Recover submitted audio");
  await expect(prompt).toBeDisabled();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].body.maxCredits).toBe(21);
  await page.screenshot({ path: testInfo.outputPath("audio-pending.png") });
  await page.reload();
  await open();
  await expect(prompt).toHaveValue("Revised audio test line.");
  await expect(prompt).toBeDisabled();
  const recover = page
    .locator("[data-render]")
    .filter({ visible: true })
    .last();
  await expect(recover).toContainText("Recover submitted audio");
  await expect(recover).toContainText("21 cr");
  await recover.click();
  await expect(prompt).toBeEnabled();
  await expect(prompt).toHaveValue("");
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0].key).toBeTruthy();
  await prompt.fill("Private draft for the first production house.");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) =>
            key.startsWith("aw_draft:make:") &&
            value === "Private draft for the first production house.",
        ),
      ),
    )
    .toBeTruthy();
  const savedKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter(
      (key) =>
        key.startsWith("aw_draft:make:") && key !== "aw_draft:make:audio",
    ),
  );
  expect(
    savedKeys.some(
      (key) => key.includes(first.workspace.id) && key.includes(me.email),
    ),
  ).toBeTruthy();
  await signInLocally(page.request);
  await page.goto("/make/audio");
  await open();
  await expect(prompt).toHaveValue("");
  await prompt.fill("Unavailable quote line.");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Audio quotes are temporarily unavailable." }),
  ).toBeVisible();
  await expect(
    page.locator("[data-render]").filter({ visible: true }).last(),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
