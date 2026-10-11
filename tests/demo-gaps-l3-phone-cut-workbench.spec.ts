import { test, expect } from "@playwright/test";
import { floors, noBannedNames } from "./helpers/r1-gaps";
import { json, seedCut, shoot, watchErrors } from "./helpers/gaps-l3";

/*
 * Gap screens, lane 3 · the phone's Cut (Gaps A frames, `screen=cut`): watch the cut and approve it, and nothing more. It is a phone
 * screen, so it runs at all five sizes (at the wide ones inside the phone's 390 px frame, `device=phone`). Approving is the takes in
 * the cut that wait for a person, each the review trail's free approval; nothing is spent and nothing else can be done here.
 */
async function open(page: import("@playwright/test").Page, pending = false) {
  const seeded = await seedCut(page, "Phone Cut Tester", { pending });
  const errors = watchErrors(page);
  const patches: { id: string; state: string }[] = [];
  await page.route(/\/api\/jobs\/tk-s2$/, (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { reviewState?: string };
    patches.push({ id: "tk-s2", state: body.reviewState ?? "" });
    const g = seeded.generations.find((x) => x.id === "tk-s2");
    if (g) Object.assign(g, { reviewState: body.reviewState ?? "", approvedBy: body.reviewState === "approved" ? "Tester" : null });
    return json(route, { ok: true, review: { reviewState: body.reviewState ?? "" } });
  });
  await page.goto(`/suites?project=${seeded.project.id}&device=phone&screen=cut`);
  await expect(page.getByTestId("phone-cut")).toBeVisible({ timeout: 60_000 });
  return { ...seeded, errors, patches };
}

test("the cut on the phone: its picture plays, the clips are listed with the one that waits, and nothing is editable", async ({ page }, info) => {
  const { paid, errors } = await open(page);
  const cut = page.getByTestId("phone-cut");
  await expect(cut.getByTestId("phone-cut-clip")).toHaveCount(2);
  await expect(cut.getByTestId("phone-cut-waiting")).toHaveText("Shot 3 waits");
  await expect(cut.getByTestId("phone-cut-line")).toHaveText("2 approved takes · 0:10");
  await expect(cut.getByTestId("phone-cut-loudness")).toContainText("Loudness · Broadcast");
  await expect(cut.getByTestId("phone-cut-loudness")).toContainText("Not checked");
  await expect(cut.getByTestId("phone-cut-music")).toContainText("none");
  await expect(cut.getByTestId("phone-cut-time")).toHaveText("0:00 / 0:10");
  await cut.getByTestId("phone-cut-play").click();
  await expect(cut.getByTestId("phone-cut-play")).toHaveAttribute("aria-pressed", "true");
  await expect(cut.getByTestId("phone-cut-time")).not.toHaveText(/^0:00 \//, { timeout: 10_000 });
  await cut.getByTestId("phone-cut-play").click();
  /* Watch and approve only: no trims, no sound, no export, no captions. */
  await expect(cut).not.toContainText(/caption|trim|export|render/i);
  await expect(cut.getByTestId("phone-cut-approve")).toBeDisabled();
  await expect(cut.getByTestId("phone-cut-approve")).toHaveText("The cut is approved");
  await noBannedNames(page, '[data-testid="phone-cut"]');
  await floors(page, '[data-testid="phone-cut"]', true);
  await shoot(page, info.project.name, "phone-cut");
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("Approve the cut approves the takes in it that wait for a person, free, with Undo", async ({ page }, info) => {
  const { paid, patches } = await open(page, true);
  const cut = page.getByTestId("phone-cut");
  await expect(cut.getByTestId("phone-cut-line")).toHaveText("1 approved take · 0:10");
  await expect(cut.getByTestId("phone-cut-approve")).toHaveText("Approve the cut");
  await expect(cut.getByTestId("phone-cut-approve-line")).toContainText("1 take in the cut waits for you. Approving is free.");
  await floors(page, '[data-testid="phone-cut"]', true);
  await shoot(page, info.project.name, "phone-cut-approve");
  await cut.getByTestId("phone-cut-approve").click();
  await expect.poll(() => patches).toEqual([{ id: "tk-s2", state: "approved" }]);
  await expect(cut.getByTestId("phone-cut-approve")).toHaveText("The cut is approved");
  expect(paid).toEqual([]);
});
