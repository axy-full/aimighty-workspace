import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { isCompact } from "./helpers/shellMode";
import { MAKE_SHOWS_CINEMA } from "../lib/shell/make-price";

/**
 * Release 1's Make offers Cinema Studio 4.0 only once its 3N hold is in (lib/shell/make-price.ts › MAKE_SHOWS_CINEMA):
 * while the flag is off, the engine list on a desktop and the phone's engine sheet do not list it, though the server's
 * engine list does. Against a local ENGINE_MOCK server; nothing is sent.
 */
const CINEMA = "higgsfield-cinema-studio-4.0";

test("Make lists Cinema Studio 4.0 only when the flag offers it, on a desktop and on a phone", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  test.setTimeout(180_000);
  await signInLocally(page.request);
  await forbidPaidWork(page);
  /* The server offers it: hiding it is Make's own choice. */
  const listed = await (await page.request.get("/api/workbench/engines")).json() as { models: { id: string }[] };
  expect(listed.models.map((m) => m.id)).toContain(CINEMA);
  if (isCompact(info)) {
    await page.goto("/suites?screen=make");
    await expect(page.getByTestId("phone-make-prompt")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("phone-make-change").click();
    const rows = page.getByTestId("phone-make-engine-row");
    await expect(rows.first()).toBeVisible({ timeout: 60_000 });
    await expect(rows.filter({ hasText: "Cinema Studio 4.0" })).toHaveCount(MAKE_SHOWS_CINEMA ? 1 : 0);
    return;
  }
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("gen-model").click();
  const rows = page.getByTestId("make-engine-row");
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`[data-testid="make-engine-row"][data-engine="${CINEMA}"]`)).toHaveCount(MAKE_SHOWS_CINEMA ? 1 : 0);
  if (!MAKE_SHOWS_CINEMA) await expect(page.getByTestId("make-engines")).not.toContainText("Cinema Studio");
});
