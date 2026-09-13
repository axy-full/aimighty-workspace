import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import type { GenerationBatch } from "../lib/useGenerationBatch";

test("an interrupted batch replays only the pending variant after reload and finishes the original ordered requests", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "customer-1440x900",
    "The shared batch protocol needs one focused desktop regression.",
  );
  const account = await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const submissions: {
    key?: string;
    body: string;
    workspace?: string;
    actor?: string;
  }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/api/generate" && request.method() === "POST") {
      const headers = request.headers();
      submissions.push({
        key: headers["idempotency-key"],
        body: request.postData()!,
        workspace: headers["x-workspace-id"],
        actor: headers["x-actor-email"],
      });
      const body = request.postDataJSON();
      if (submissions.length === 2)
        return json(
          {
            error:
              "The second take’s submission response was lost. Recover the batch.",
          },
          503,
        );
      if (body.variation === 3)
        return json(
          {
            id: "mock-image-3",
            status: "failed",
            error: "The third take failed after a provider attempt.",
          },
          502,
        );
      if (submissions.length === 5)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          headers: { "Idempotency-Status": "complete" },
          body: JSON.stringify({
            error: "The fourth take could not be confirmed.",
          }),
        });
      return json({ id: `mock-image-${body.variation}`, status: "running" });
    }
    if (request.method() !== "GET")
      throw new Error(`Unexpected mutation: ${path}`);
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/productions") return json({ productions: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/me") return json(me);
    return route.fallback();
  });
  await page.goto("/make/images");
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await prompt.fill(
    "A brass key in a pool of warm light. Four isolated test variations.",
  );
  await page.getByRole("button", { name: /×1/ }).click();
  await page.getByRole("menuitem", { name: "×4", exact: true }).click();
  const render = page.locator("[data-render]").filter({ visible: true }).last();
  await expect(render).toBeEnabled();
  await render.click();
  await expect(render).toContainText("Recover batch");
  await expect(
    page.getByRole("status").filter({ hasText: "1 of 4 takes submitted" }),
  ).toBeVisible();
  await expect(prompt).toBeDisabled();
  expect(submissions).toHaveLength(2);
  const stored = await page.evaluate(() =>
    Object.entries(localStorage).find(([key]) =>
      key.startsWith("particl:generation-batch:"),
    ),
  );
  expect(stored).toBeTruthy();
  const [storageKey, raw] = stored!;
  const batch = JSON.parse(raw) as GenerationBatch;
  expect(storageKey).toContain(account.workspace.id);
  expect(storageKey).toContain(me.email);
  expect(batch.cursor).toBe(1);
  expect(batch.variants).toHaveLength(4);
  expect(batch.variants[0].resultId).toBe("mock-image-1");
  expect(new Set(batch.variants.map((variant) => variant.key)).size).toBe(4);
  expect(
    batch.variants.map((variant) => JSON.parse(variant.body).variation),
  ).toEqual([1, 2, 3, 4]);
  expect(
    batch.variants.every((variant) =>
      Number.isInteger(JSON.parse(variant.body).maxCredits),
    ),
  ).toBeTruthy();
  await page.reload();
  await expect(prompt).toHaveValue(batch.display.prompt);
  await expect(prompt).toBeDisabled();
  await expect(render).toContainText("Recover batch");
  await expect(page.getByRole("button", { name: /×4/ })).toBeDisabled();
  await render.click();
  await expect(
    page.getByRole("status").filter({ hasText: "3 of 4 takes submitted" }),
  ).toBeVisible();
  await expect(render).toContainText("Recover batch");
  const progressed = (await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    storageKey,
  )) as GenerationBatch;
  expect(progressed.cursor).toBe(3);
  expect(progressed.variants[2].resultId).toBe("mock-image-3");
  expect(progressed.refusal).toBeUndefined();
  expect(progressed.variants[3].key).toBe(batch.variants[3].key);
  await page.reload();
  await expect(render).toContainText("Recover batch");
  await render.click();
  await expect(prompt).toBeEnabled();
  await expect(prompt).toHaveValue("");
  expect(submissions).toHaveLength(6);
  expect(submissions.map((item) => JSON.parse(item.body).variation)).toEqual([
    1, 2, 2, 3, 4, 4,
  ]);
  expect(submissions[2]).toEqual(submissions[1]);
  expect(submissions[5]).toEqual(submissions[4]);
  for (const index of [0, 1, 3, 4]) {
    const request = submissions[index];
    const variant = batch.variants[JSON.parse(request.body).variation - 1];
    expect(request.key).toBe(variant.key);
    expect(request.body).toBe(variant.body);
    expect(request.workspace).toBe(account.workspace.id);
    expect(request.actor).toBe(me.email);
  }
  expect(
    await page.evaluate((key) => localStorage.getItem(key), storageKey),
  ).toBeNull();
  await page.screenshot({ path: testInfo.outputPath("batch-recovered.png") });
  expect(errors).toEqual([]);
});
