import { expect, type Page } from "@playwright/test";

/**
 * Shared by the app-pages audit specs (tests/app-pages-*-workbench.spec.ts).
 * Nothing they run submits paid work: projects, shots and boards are free
 * rows, and every paid route is refused by forbidPaid.
 */
export const DESKTOP = "workbench-1440x900";

export async function forbidPaid(page: Page) {
  await page.route(/\/api\/(generate|atomik\/(ideas|shots)\/draft|atomik\/treatment\/scene)(\?.*)?$/, (route) => {
    if (route.request().method() === "POST") throw new Error("This spec must not submit paid work.");
    return route.fallback();
  });
}

export async function projectWithShots(page: Page) {
  const made = await page.request.post("/api/projects", { data: { name: "Audit film" } });
  expect(made.ok(), await made.text()).toBe(true);
  const project = (await made.json()) as { id: string };
  for (const planned of [5, 8]) {
    const shot = await page.request.post("/api/shots", { data: { projectId: project.id, scene: "1", title: `Shot ${planned}`, description: "A courier runs through rain", planned, engine: "seedance" } });
    expect(shot.ok(), await shot.text()).toBe(true);
  }
  const listed = (await (await page.request.get("/api/projects")).json()) as { projects: { id: string; productionId: string | null }[] };
  return listed.projects.find((p) => p.id === project.id)!;
}

export async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}
