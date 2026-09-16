import { expect, type Page } from "@playwright/test";
import { STAGES } from "../../lib/workbench/studio";

/** Phone Home uses workspace destinations; project workflow starts in a project. */
export async function openWorkbenchProject(page: Page) {
  if (page.viewportSize()!.width >= 760) return;
  // This header is rendered only after the mobile media query has hydrated.
  // The server's disabled five-tab fallback must not be used to infer Home.
  await expect(page.locator(".phone-project-header")).toBeVisible();
  if (await page.locator(".studio-redesign.is-home").isVisible()) {
    const project = page.locator(".home-current");
    const sample = page.getByRole("button", { name: "Explore sample", exact: true });
    await expect(project.or(sample).first()).toBeVisible();
    if (await project.isVisible()) await project.click();
    else await sample.click();
  }
}

export async function goWorkbenchStage(page: Page, idOrLabel: string) {
  const stage = STAGES.find(value => value.id === idOrLabel || value.label === idOrLabel);
  if (!stage) throw new Error(`Unknown workbench stage: ${idOrLabel}`);
  if (page.viewportSize()!.width < 760) {
    await openWorkbenchProject(page);
    await page.getByRole("navigation", { name: "Mobile studio navigation" })
      .getByRole("button", { name: "Workflow", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Project workflow" });
    await expect(sheet).toBeVisible();
    await sheet.locator(".mobile-workflow-list button").filter({ hasText: stage.label }).click();
    await expect(sheet).not.toBeVisible();
  } else {
    await page.locator(".workflow-stages").getByRole("tab").nth(STAGES.indexOf(stage)).click();
  }
}

export async function openWorkbenchInspector(page: Page, tab: "shot" | "color" | "versions" | "sound") {
  const mobile = page.viewportSize()!.width < 760;
  if (!mobile && tab === "sound") return;
  const names = mobile
    ? { shot: "Shot", color: "Color", versions: "Versions", sound: "Sound" }
    : { shot: "Shot details", color: "Sequence color", versions: "Edit versions", sound: "Sound" };
  await page.getByRole("group", { name: "Inspector view" })
    .getByRole("button", { name: names[tab], exact: true }).click();
}

export async function openWorkbenchBins(page: Page) {
  if (page.viewportSize()!.width < 760) {
    await page.getByRole("button", { name: "Open asset bins", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Asset bins", exact: true })).toBeVisible();
  }
}

export async function closeWorkbenchBins(page: Page) {
  if (page.viewportSize()!.width < 760) {
    const sheet = page.getByRole("dialog", { name: "Asset bins", exact: true });
    await sheet.getByRole("button", { name: "Close Asset bins", exact: true }).last().click();
    await expect(sheet).not.toBeVisible();
  }
}
