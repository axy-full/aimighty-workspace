import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";

/** Pause this tab immediately before acquiring its claim lock; other tabs keep their real lock implementation. */
async function holdNextClaim(page: Page) {
  await page.evaluate(() => {
    const original = navigator.locks.request.bind(navigator.locks);
    let held = false;
    Object.defineProperty(navigator.locks, "request", {
      configurable: true,
      value: (...args: unknown[]) => {
        if (held) return Reflect.apply(original, navigator.locks, args);
        held = true;
        return new Promise((resolve, reject) => {
          Object.defineProperty(window, "releaseRecoveryClaim", {
            configurable: true,
            value: () =>
              Promise.resolve(
                Reflect.apply(original, navigator.locks, args),
              ).then(resolve, reject),
          });
        });
      },
    });
  });
}

for (const surface of ["batch", "audio", "writing"] as const) {
  test(`${surface} stale recovery cannot create a new paid request after another tab completes`, async ({
    page,
    context,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "customer-1440x900",
      "One desktop check per shared recovery protocol.",
    );
    await signInLocally(page.request);
    const submissions: string[] = [];
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (value: unknown, status = 200, complete = false) =>
        route.fulfill({
          status,
          contentType: "application/json",
          headers: complete ? { "Idempotency-Status": "complete" } : {},
          body: JSON.stringify(value),
        });
      if (path === "/api/audio" && request.method() === "GET")
        return json({
          configured: true,
          speechModels: [
            {
              id: "mock-speech",
              label: "Mock speech",
              creditsPerChar: 0.1,
              note: "Test",
            },
          ],
          defaultSpeechModel: "mock-speech",
          voices: [
            {
              id: "mock-voice",
              name: "Avery",
              labels: {},
              category: "premade",
              description: "",
              previewUrl: null,
            },
          ],
          terms: { sfxCredits: 200, musicCreditsPerMinute: 900 },
          account: null,
        });
      if (path === "/api/audio" && request.postDataJSON()?.quoteOnly)
        return json({ estimatedCredits: 14, price: 14, unit: "cr" });
      if (path === "/api/atomik/ideas/draft" && request.postDataJSON()?.quoteOnly === true) {
        expect(request.headers()["idempotency-key"]).toBeUndefined();
        return json({ model: "anthropic/claude-sonnet-4.6", effort: "auto", estimateCredits: 2 });
      }
      if (
        ["/api/generate", "/api/audio", "/api/atomik/ideas/draft"].includes(
          path,
        ) &&
        request.method() === "POST"
      ) {
        submissions.push(request.headers()["idempotency-key"]);
        if (submissions.length === 1)
          return json(
            { error: "Submission needs recovery." },
            surface === "batch" ? 402 : 503,
            surface === "batch",
          );
        return json(
          surface === "writing"
            ? { logline: "Recovered once.", tone: [], model: "mock-writer" }
            : { id: "mock-paid-job", status: "running" },
          200,
          true,
        );
      }
      if (request.method() !== "GET")
        throw new Error(`Unexpected mutation: ${path}`);
      if (path === "/api/atomik/ideas") return json({ ideas: [] });
      if (path === "/api/atomik")
        return json({
          chats: [],
          engines: [],
          models: { featured: [], rest: [] },
        });
      if (path === "/api/jobs") return json({ generations: [] });
      if (path === "/api/productions") return json({ productions: [] });
      if (path === "/api/projects") return json({ projects: [] });
      return route.fallback();
    });
    const path =
      surface === "writing"
        ? "/atomik/ideas"
        : surface === "audio"
          ? "/make/audio"
          : "/make/images";
    await page.goto(path);
    if (surface === "writing") {
      await page.getByRole("button", { name: "New idea", exact: true }).click();
      await page
        .locator(".ak-idea.is-new textarea")
        .fill("A private original brief.");
      await page
        .getByRole("button", { name: /WRITE IT · 2 CR RESERVED/ })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "OK", exact: true })
        .click();
    } else {
      await page
        .getByRole("textbox", { name: "Prompt", exact: true })
        .fill("A private original generation prompt.");
      await page
        .locator("[data-render]")
        .filter({ visible: true })
        .last()
        .click();
    }
    const recoveryName =
      surface === "writing"
        ? "Recover writing request"
        : surface === "audio"
          ? /Recover submitted audio/
          : /Retry remaining takes/;
    await expect(
      page.getByRole("button", { name: recoveryName }),
    ).toBeVisible();
    const other = await context.newPage();
    await other.goto(path);
    await expect(
      other.getByRole("button", { name: recoveryName }),
    ).toBeVisible();
    await holdNextClaim(page);
    await page.getByRole("button", { name: recoveryName }).click();
    await expect
      .poll(() =>
        page.evaluate(() => typeof Reflect.get(window, "releaseRecoveryClaim")),
      )
      .toBe("function");
    await other.getByRole("button", { name: recoveryName }).click();
    if (surface === "writing")
      await expect(other.locator(".ak-idea.is-new textarea")).toHaveValue(
        "Recovered once.",
      );
    else
      await expect(
        other.getByRole("textbox", { name: "Prompt", exact: true }),
      ).toHaveValue("");
    expect(submissions).toHaveLength(2);
    await page.evaluate(() => Reflect.get(window, "releaseRecoveryClaim")());
    await expect(
      page.getByText(/already (?:been )?recovered/).first(),
    ).toBeVisible();
    expect(submissions).toHaveLength(2);
    if (surface === "batch") expect(submissions[1]).not.toBe(submissions[0]);
    else expect(submissions[1]).toBe(submissions[0]);
    await other.close();
  });
}
