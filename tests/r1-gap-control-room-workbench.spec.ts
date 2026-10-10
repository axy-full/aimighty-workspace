import { test, expect } from "@playwright/test";
import { PHONES, SIZES, floors, noBannedNames, shoot, signedInWarm, watchErrors } from "./helpers/r1-gaps";

/**
 * Release 1 gap 1: the control room shows only its own four tabs (design/particl-graphite, Atomik frames g–j):
 * Approvals, Activity, Skills, Memory. The old Atomik strip (Agent, Budget, Models, Tools too) is gone.
 */

const TABS = [
  { label: "Approvals", address: "suite=atomik&page=approvals", title: "Approvals" },
  { label: "Activity", address: "suite=atomik&page=runs", title: "Activity" },
  { label: "Skills", address: "suite=atomik&page=agent&sp=saved-skills", title: "Skills" },
  { label: "Memory", address: "suite=atomik&page=agent&sp=memory", title: "Memory" },
] as const;

test("the control room's strip is its four tabs, in the frame's order, with no numbers and none of the old pages", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = watchErrors(page);
  await signedInWarm(page);
  const phone = PHONES.includes(info.project.name);
  for (const tab of TABS) {
    await page.goto(`/suites?${tab.address}`);
    /* A phone mounts its own screens (Phone frames; DECISIONS 11): the control room's Approvals is Home there, and no page strip is drawn,
       so the old Atomik strip cannot be on it. */
    if (phone) {
      await expect(page.getByTestId("phone-app")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Pages" })).toHaveCount(0);
      await noBannedNames(page);
      await floors(page, ".ph-app", true);
      if (tab.label === "Approvals") await shoot(page, info.project.name, "control-approvals");
      continue;
    }
    await expect(page.getByTestId("control-room")).toBeVisible();
    await expect(page.getByTestId("page-title")).toHaveText(tab.title);
    const strip = page.getByRole("navigation", { name: "Pages" });
    await expect(strip.getByRole("button")).toHaveText(["Approvals", "Activity", "Skills", "Memory"]);
    await expect(strip.getByRole("button", { name: tab.label })).toHaveAttribute("aria-current", "page");
    await expect(strip.locator(".gx-tab-n")).toHaveCount(0);
    for (const gone of ["Agent", "Budget", "Models", "Tools"]) await expect(strip.getByRole("button", { name: new RegExp(gone) })).toHaveCount(0);
    await noBannedNames(page);
    await floors(page, ".gx-strip, .cr", phone);
    await shoot(page, info.project.name, `control-${tab.label.toLowerCase()}`);
  }
  expect(errors).toEqual([]);
});

test("each tab opens its page, and the retired pages' addresses go where the design put them", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(PHONES.includes(info.project.name), "a phone has no page strip");
  await signedInWarm(page);
  await page.goto("/suites?suite=atomik&page=approvals");
  const strip = page.getByRole("navigation", { name: "Pages" });
  for (const tab of ["Activity", "Skills", "Memory", "Approvals"]) {
    await strip.getByRole("button", { name: tab }).click();
    await expect(page.getByTestId("page-title")).toHaveText(tab);
    await expect(strip.getByRole("button", { name: tab })).toHaveAttribute("aria-current", "page");
  }
  /* Budget and Models are Settings sections; the Agent page is Atomik's panel. */
  await page.goto("/suites?suite=atomik&page=budget");
  await expect(page).toHaveURL(/view=workspace.*tab=rules/);
  await page.goto("/suites?suite=atomik&page=models");
  await expect(page).toHaveURL(/view=workspace.*tab=advanced/);
  await page.goto("/suites?suite=atomik&page=agent");
  await expect(page).toHaveURL(/atomik=1/);
});
