import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";

async function fixture(page: Page, rememberedOnly: boolean) {
  await signInLocally(page.request);
  const me = await page.request
    .get("/api/me")
    .then((response) => response.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const draft = {
    ...newProject("Campaign project"),
    id: "marketing-draft",
    productionProjectId: "different-production-id",
    shotMappings: {},
  };
  let paidRequests = 0;
  await page.addInitScript(
    ({ scope, rememberedOnly }) => {
      localStorage.setItem(
        scope,
        rememberedOnly ? "marketing-draft" : "older-draft",
      );
      localStorage.setItem(
        "particl-active-other-workspace-other-user",
        "unrelated-draft",
      );
    },
    { scope, rememberedOnly },
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (
      request.method() === "POST" &&
      /\/(generate|audio|atomik|soul\/identities)(\/|$)/.test(path)
    ) {
      paidRequests++;
      return route.fulfill({
        status: 409,
        json: { error: "This navigation fixture cannot submit paid work." },
      });
    }
    if (path === "/api/me") return json(me);
    if (path === "/api/workbench/projects")
      return json({
        project: draft,
        revision: 1,
        projects: [{ id: draft.id, name: draft.name }],
        productions: [],
      });
    if (path === "/api/projects")
      return json({
        projects: [{ id: draft.productionProjectId, name: draft.name }],
      });
    if (path === "/api/workbench/library")
      return json({
        uploads: [],
        generations: [],
        nextCursor: null,
        nextPageCursor: null,
      });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (path === "/api/atomik/chats") return json({ chats: [] });
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/engines" || path === "/api/workbench/engines")
      return json({ models: [], vendors: [] });
    if (path === "/api/quotes") return json({ quotes: [] });
    return json({});
  });
  await page.goto(
    rememberedOnly ? "/library?all=1" : `/library?project=${draft.id}`,
  );
  const toggle = page.getByRole("button", {
    name: "Toggle Atomik creative engine",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  return {
    draft,
    get paidRequests() {
      return paidRequests;
    },
  };
}

for (const rememberedOnly of [false, true]) {
  test(`global Atomik opens Moleculr with ${rememberedOnly ? "the account-scoped remembered draft" : "the URL draft before remembered or production IDs"}`, async ({
    page,
  }, info) => {
    test.skip(
      !["workbench-360x640", "workbench-1440x900"].includes(info.project.name),
      "phone sheet and desktop rail navigation",
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = await fixture(page, rememberedOnly);
    const entry = page
      .getByRole("link", { name: "Open Moleculr", exact: true })
      .filter({ visible: true });
    const href = `/workbench?project=${state.draft.id}&suite=moleculr&page=marketing#brand`;
    await expect(entry).toHaveAttribute("href", href);
    await expect(entry).toBeVisible();
    if (rememberedOnly) {
      await page
        .getByRole("button", { name: /^Expand/ })
        .filter({ visible: true })
        .click();
      await expect(entry).toHaveAttribute("href", href);
      await expect(entry).toBeVisible();
    }
    // A modified click must stay native; observe it after React, then suppress
    // the actual new-tab action so this check remains in the isolated fixture.
    expect(
      await entry.evaluate((link) => {
        let prevented: boolean | undefined;
        document.addEventListener(
          "click",
          (event) => {
            prevented = event.defaultPrevented;
            event.preventDefault();
          },
          { once: true },
        );
        link.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
          }),
        );
        return prevented;
      }),
    ).toBe(false);
    await page.evaluate(() => {
      const block = (event: Event) => {
        (
          event as CustomEvent<{ checks: Promise<boolean>[] }>
        ).detail.checks.push(Promise.resolve(false));
        window.removeEventListener("particl:before-page-leave", block);
      };
      window.addEventListener("particl:before-page-leave", block);
    });
    await entry.click();
    await expect(page).toHaveURL(/\/library/);
    await expect(entry).toBeVisible();
    await entry.focus();
    await entry.press("Enter");
    await expect(page).toHaveURL(href);
    await expect(page.locator('[data-suite="moleculr"]')).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Moleculr Business Suite pages", exact: true })
        .getByRole("link", { name: "Marketing Studio", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.locator("section.moleculr-section#brand > h2 > button")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".project-bar")).toContainText(state.draft.name);
    expect(state.paidRequests).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("marketing-entry.png") });
  });
}
