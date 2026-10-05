import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { CREDIT_FIGURE } from "../lib/spend";
import { SPEND_LABEL } from "./helpers/paidRoutes";

/**
 * Every button that spends shows a price in credits, on the rendered page (owner's D0 review, item 13; how it works and
 * how a new paid button opts in: docs/ui-checks.md). The static half is tests/unit/spend-buttons.spec.ts.
 *
 * On every probed page, at every size the workbench config runs:
 *  1. each `[data-spend]` control shows a credit figure ("43 cr", "up to 69 cr", "about 40 cr, at most 120 cr", "free")
 *     in its text or accessible name, or is disabled with data-spend="unpriced" (no price yet) or aria-busy (in flight);
 *  2. no visible button whose label is a spend verb (Make, Render, Recreate, Again…) lacks `data-spend`;
 *  3. a page that is known to carry a paid control has at least `minSpend` of them, so the marker cannot vanish quietly.
 *
 * Paid work is mocked and never submitted (forbidPaidWork). THIS SPEC IS EXPECTED TO FAIL until the D0 fixes land:
 * nothing carries `data-spend` yet, so (3) and (2) name what is missing. The probe list is data: when a screen moves
 * (the board, the Make panel), edit its path here.
 */

type Probe = { name: string; path: string; minSpend: number };
const PROBES: Probe[] = [
  { name: "Gen (Make once #512 lands)", path: "/suites?view=gen", minSpend: 1 },
  { name: "Studio · Brief", path: "/suites?suite=studio&sp=brief", minSpend: 0 },
  { name: "Studio · Boards", path: "/suites?suite=studio&sp=boards", minSpend: 0 },
  { name: "Studio · Cast", path: "/suites?suite=studio&sp=cast", minSpend: 0 },
  { name: "Studio · Takes", path: "/suites?suite=studio&sp=takes", minSpend: 0 },
  { name: "Studio · Edit & Sound", path: "/suites?suite=studio&sp=edit", minSpend: 0 },
  { name: "Viral · Motion Transfer", path: "/suites?suite=viral&sp=motion", minSpend: 0 },
  { name: "Viral · Object Swap", path: "/suites?suite=viral&sp=swap", minSpend: 0 },
  { name: "Business · Image ads", path: "/suites?suite=business&sp=dtc", minSpend: 0 },
  { name: "Atomik · Agent", path: "/suites?suite=atomik&sp=agent", minSpend: 0 },
];

const fixture = (): Project => ({
  ...newProject("Harbour at dusk"), id: "ws-spend", productionProjectId: "prod-ws", shotMappings: {},
  brief: "A fox crosses a frozen harbour at dusk and meets the keeper of the light", nodes: [], shots: [],
} as Project);

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await page.route("**/api/workbench/atomik**", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { configured: false, models: [], jobs: [] } })
    : route.fulfill({ json: { estimateCredits: 12, estimateUsd: 1.2, quoteOnly: true } }));
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })], generations: [generation({ id: "gen_take_1", title: "Take 1", prompt: "Take 1" })] });
  await page.route("**/api/workbench/engines**", (route) => route.fulfill({ json: { credits: 180, models: [] } }));
  await page.route("**/api/crew/members?*", (route) => route.fulfill({ json: { members: [] } }));
  await page.goto(path);
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

type Found = { marked: number; noPrice: string[]; unmarked: string[] };

/** Reads the page: the marked controls and what they show, and the unmarked buttons that read like paid ones. */
function read(page: Page): Promise<Found> {
  return page.evaluate(({ figure, verb }) => {
    const figureRe = new RegExp(figure.source, figure.flags);
    const verbRe = new RegExp(verb.source, verb.flags);
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
    const name = (el: Element) => `${el.getAttribute("data-testid") ?? ""} "${(el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)}"`.trim();
    const marked = Array.from(document.querySelectorAll("[data-spend]")).filter(visible);
    const noPrice = marked.filter((el) => {
      const text = `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
      if (figureRe.test(text)) return false;
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true";
      return !(el.getAttribute("data-spend") === "unpriced" && disabled) && el.getAttribute("aria-busy") !== "true";
    }).map(name);
    const unmarked = Array.from(document.querySelectorAll("button, [role=button]")).filter(visible).filter((el) => {
      if (el.closest("[data-spend]")) return false;
      const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
      return verbRe.test(label);
    }).map(name);
    return { marked: marked.length, noPrice, unmarked };
  }, { figure: { source: CREDIT_FIGURE.source, flags: CREDIT_FIGURE.flags }, verb: { source: SPEND_LABEL.source, flags: SPEND_LABEL.flags } });
}

for (const probe of PROBES) {
  test(`TO-DO (fails until the D0 fixes land) · ${probe.name}: every button that spends shows a price in credits`, async ({ page }) => {
    await open(page, probe.path);
    const found = await read(page);
    expect(found.noPrice, "controls marked data-spend with no credit figure (and not disabled-unpriced)").toEqual([]);
    expect(found.unmarked, "buttons labelled like a paid action that carry no data-spend").toEqual([]);
    expect(found.marked, `a page with a paid control carries at least ${probe.minSpend} data-spend control(s)`).toBeGreaterThanOrEqual(probe.minSpend);
  });
}
