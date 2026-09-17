import { expect, type Page } from "@playwright/test";
import { STAGES } from "../../lib/workbench/studio";
import { PAGES } from "../../lib/suites";

/** Phone Home uses workspace destinations; project workflow starts in a project. */
export async function openWorkbenchProject(page: Page) {
  if (page.viewportSize()!.width >= 760) return;
  // The Atomik control remains disabled until client hydration. Do not infer
  // mobile Home from the server-rendered desktop fallback.
  await expect(
    page
      .getByRole("button", {
        name: "Toggle Atomik creative engine",
        exact: true,
      })
      .filter({ visible: true }),
  ).toBeEnabled();
  await expect(
    page
      .getByRole("navigation", { name: "Particl pages", exact: true })
      .getByRole("link", { name: "Rig", exact: true }),
  ).toBeEnabled();
  if (await page.locator(".studio-redesign.is-home").isVisible()) {
    const project = page.locator(".home-current");
    const sample = page.getByRole("button", {
      name: "Explore sample",
      exact: true,
    });
    await expect(project.or(sample).first()).toBeVisible();
    if (await project.isVisible()) {
      await expect(project).toBeEnabled();
      await project.click();
    } else {
      await expect(sample).toBeEnabled();
      await sample.click();
    }
  }
}

export async function goWorkbenchStage(page: Page, idOrLabel: string) {
  const stage = STAGES.find(
    (value) =>
      value.id === idOrLabel ||
      value.label === idOrLabel ||
      PAGES.particl.some(
        (page) => page.id === value.id && page.label === idOrLabel,
      ),
  );
  if (!stage) throw new Error(`Unknown workbench stage: ${idOrLabel}`);
  if (page.viewportSize()!.width < 760) await openWorkbenchProject(page);
  const label = PAGES.particl.find((value) => value.id === stage.id)!.label;
  const link = page
    .getByRole("navigation", { name: "Particl pages", exact: true })
    .getByRole("link", { name: label, exact: true });
  await expect(link).toBeEnabled();
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
}

export async function openWorkbenchInspector(
  page: Page,
  tab: "shot" | "color" | "versions" | "sound",
) {
  const mobile = page.viewportSize()!.width < 760;
  if (!mobile && tab === "sound") return;
  const names = mobile
    ? { shot: "Shot", color: "Color", versions: "Versions", sound: "Sound" }
    : {
        shot: "Shot details",
        color: "Sequence color",
        versions: "Edit versions",
        sound: "Sound",
      };
  await page
    .getByRole("group", { name: "Inspector view" })
    .getByRole("button", { name: names[tab], exact: true })
    .click();
}

export async function openWorkbenchBins(page: Page) {
  if (page.viewportSize()!.width < 760) {
    await page
      .getByRole("button", { name: "Open asset bins", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Asset bins", exact: true }),
    ).toBeVisible();
  }
}

export async function closeWorkbenchBins(page: Page) {
  if (page.viewportSize()!.width < 760) {
    const sheet = page.getByRole("dialog", { name: "Asset bins", exact: true });
    await sheet
      .getByRole("button", { name: "Close Asset bins", exact: true })
      .last()
      .click();
    await expect(sheet).not.toBeVisible();
  }
}
