import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInWithNewInterface } from "./helpers/newInterface";
import { smallTargets } from "./phoneFloors";

/**
 * Control room › Skills (Atomik frame i) with the new interface on: saved
 * runs, searched by name or /command; a skill's parameters, its steps with
 * their estimates as "up to N cr" from the free preview; Edit opening the
 * editor; versions. Running needs a project and spends nothing by itself.
 * The skills routes are answered by fixtures here; nothing is planned or run.
 */

const PAGE = "/suites?suite=atomik&page=saved-skills";
const SHOTS = "/private/tmp/claude-s08-shots";
const SHOT_SIZES = ["workbench-1440x900", "workbench-390x844"];

async function floors(page: Page, phone: boolean) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector(".cr");
    if (!root) return ["no .cr"];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement, text = (node.textContent ?? "").trim();
      if (!text || !el || !el.getClientRects().length) continue;
      if (Number.parseFloat(getComputedStyle(el).fontSize) < 12) out.push(text.slice(0, 30));
    }
    return out;
  });
  expect(small, "text under 12 px").toEqual([]);
  if (phone) expect(await smallTargets(page, ".cr"), "targets under 44×44").toEqual([]);
}

const now = Date.now();
const skill = (id: string, slug: string, name: string, version: number, steps: number) => ({
  id, slug, name, description: `${name}, saved from a done run.`, scope: "workspace", status: "active", version,
  byYou: true, byName: null, editedByYou: true, editedByName: null, archivedByYou: false, archivedByName: null, archivedAt: null,
  createdAt: now - 86_400_000, updatedAt: now - 3_600_000, canChangeScope: true,
  template: {
    parameters: id === "sk_hero" ? [{ key: "shots", label: "Shots", default: "SH02 · SH03" }, { key: "note", label: "Note for the hero take", default: "Warmer light" }] : [],
    steps: Array.from({ length: steps }, (_, i) => ({ kind: "video", title: `Step ${i + 1}`, prompt: "p", model: "dreamina-seedance-2-0-260128", params: { seconds: 5, resolution: "1080p", ratio: "16:9" } })),
  },
});
const SKILLS = [skill("sk_hero", "hero-takes", "Hero takes", 2, 3), skill("sk_cov", "coverage-check", "Coverage check", 1, 1)];

async function fixtures(page: Page, previews: unknown[]) {
  await page.route(/\/api\/atomik\/skills(\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: url.searchParams.get("runs") === "1" ? { runs: [] } : { skills: SKILLS } });
  });
  await page.route(/\/api\/atomik\/skills\/sk_[a-z]+(\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const s = SKILLS.find((k) => k.id === id)!;
    return route.fulfill({ json: { skill: s, versions: [{ version: s.version, name: s.name, slug: s.slug, description: s.description, scope: s.scope, note: null, byYou: true, byName: null, createdAt: now }, ...(s.version > 1 ? [{ version: 1, name: s.name, slug: s.slug, description: "", scope: s.scope, note: "First cut", byYou: true, byName: null, createdAt: now - 86_400_000 }] : [])], engines: [] } });
  });
  await page.route(/\/api\/atomik\/skills\/sk_[a-z]+\/run$/, (route) => {
    const body = route.request().postDataJSON();
    previews.push(body);
    if (body.dryRun !== true) return route.fulfill({ status: 500, json: { error: "not in this spec" } });
    return route.fulfill({ json: { preview: { problems: [], values: body.values, steps: [
      { index: 0, kind: "image", title: "Keyframes", prompt: "p", model: "m1", label: "Nano Banana Pro", params: { resolution: "1K" }, estCredits: 9, estUsd: null, swapped: false },
      { index: 1, kind: "video", title: "Hero take", prompt: "p", model: "m2", label: "Seedance 2.5", params: { seconds: 5, resolution: "1080p" }, estCredits: 43, estUsd: null, swapped: false },
      { index: 2, kind: "video", title: "Draft takes", prompt: "p", model: "m3", label: "Kling 3.0 Standard", params: { seconds: 5 }, estCredits: null, estUsd: null, swapped: false },
    ] } } });
  });
}

test("skills: search, a skill's steps priced from the free preview, Edit and versions; running waits for a project", async ({ page }, info) => {
  test.setTimeout(180_000);
  await signInWithNewInterface(page.request);
  const previews: { dryRun?: boolean; values?: Record<string, string> }[] = [];
  await fixtures(page, previews);
  await page.goto(PAGE);
  await expect(page.getByTestId("page-title")).toHaveText("Skills");
  const rows = page.getByTestId("skill-row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("skill-slug")).toHaveText("/hero-takes");
  const steps = page.getByTestId("skill-step");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText("up to 9 cr");
  await expect(steps.nth(1)).toContainText("up to 43 cr");
  await expect(steps.nth(2)).toContainText("priced at its Continue");
  await expect(page.getByTestId("skill-foot")).toContainText("Steps together: up to 52 cr, and 1 priced at its Continue");
  await expect(page.getByTestId("skill-foot")).not.toContainText(/about|\$/);
  /* Every preview was a dry run with the skill's own words; no fresh preview ever ran a skill. */
  expect(previews.length).toBeGreaterThan(0);
  expect(previews.every((p) => p.dryRun === true)).toBe(true);
  /* No project open: Run waits, and says why. */
  await expect(page.getByTestId("skill-run")).toBeDisabled();
  await expect(page.getByTestId("skill-no-project")).toBeVisible();
  await expect(page.getByTestId("skill-versions")).toContainText("v2 · current");
  await expect(page.getByTestId("skill-versions")).toContainText("First cut");
  await floors(page, info.project.use.isMobile === true);
  if (SHOT_SIZES.includes(info.project.name)) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/skills-${info.project.name.replace("workbench-", "")}.png`, fullPage: true });
  }

  /* New words reprice through the same free preview. */
  await page.getByTestId("skill-param-note").fill("Golden hour on the hero take");
  await expect.poll(() => previews.some((p) => p.values?.note === "Golden hour on the hero take")).toBe(true);

  /* Search by /command. */
  await page.getByTestId("skills-search").fill("/coverage");
  await expect(rows).toHaveCount(1);
  await page.getByTestId("skills-search").fill("nothing like it");
  await expect(page.getByTestId("skills-empty")).toHaveText("No skill matches “nothing like it”.");
  await page.getByTestId("skills-search").fill("");

  /* Edit opens the editor in place. */
  await page.getByTestId("skill-edit").click();
  await expect(page.getByTestId("skill-editing")).toBeVisible();
});
