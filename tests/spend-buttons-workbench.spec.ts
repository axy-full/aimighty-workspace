import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { CREDIT_FIGURE } from "../lib/spend";
import { SPEND_LABEL } from "./helpers/paidRoutes";
import { past } from "./helpers/ratchet";
import { appendFileSync } from "node:fs";

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
 * Paid work is mocked and never submitted (forbidPaidWork). The probe list is data: when a screen moves (the board, the Make
 * panel), edit its path here.
 *
 * RATCHET-AWARE. Nothing carries `data-spend` yet, so each probe has what D0 has not fixed yet: `allowedUnmarked` (spend-verb buttons
 * still without the marker) may never be exceeded, and `minSpend` (the markers the page must have) is enforced from `until`. Before
 * that date a probe passes with the gap as an annotation; after it, the probe fails until the page is clean. (1) has no allowance:
 * a marked control with no credit figure fails at once. SPEND_PROBE_REPORT=<file> appends what each probe found, for setting the
 * allowances. The strict probes are the D0 surfaces (Make); `strict: false` ones are old screens the board PR deletes.
 */

type Probe = {
  name: string; path: string;
  /** Markers the page must carry once `until` has passed. */
  minSpend: number;
  /** A D0 surface (Make and its quick tools): the owner's strict list. Otherwise an old screen the board PR deletes. */
  strict: boolean;
  /** Spend-verb buttons without the marker that D0 has not fixed yet; may never be exceeded. */
  allowedUnmarked: number;
  until: string;
  by: string;
};
/* allowedUnmarked was measured at 1440x900 on 6 Oct 2026: the Gen page's "Generate", the quick tools' "Transfer motion" (the swap probe shows the same button) and Image ads' "Generate image". */
const D0 = { until: "2026-10-08", by: "D0 #512/#514 (Make: every paid button shows its price)" };
const BOARD = { until: "2026-10-08", by: "the board PR deletes this screen" };
const PROBES: Probe[] = [
  { name: "Make panel", path: "/suites?make=1", minSpend: 1, strict: true, allowedUnmarked: 0, ...D0 },
  { name: "Gen (Make once #512 lands)", path: "/suites?view=gen", minSpend: 1, strict: true, allowedUnmarked: 1, ...D0 },
  { name: "Studio · Brief", path: "/suites?suite=studio&sp=brief", minSpend: 0, strict: false, allowedUnmarked: 0, ...BOARD },
  { name: "Studio · Boards", path: "/suites?suite=studio&sp=boards", minSpend: 0, strict: false, allowedUnmarked: 0, ...BOARD },
  { name: "Studio · Cast", path: "/suites?suite=studio&sp=cast", minSpend: 0, strict: false, allowedUnmarked: 0, ...BOARD },
  { name: "Studio · Takes", path: "/suites?suite=studio&sp=takes", minSpend: 0, strict: false, allowedUnmarked: 0, ...BOARD },
  { name: "Studio · Edit & Sound", path: "/suites?suite=studio&sp=edit", minSpend: 0, strict: false, allowedUnmarked: 0, ...BOARD },
  { name: "Viral · Motion Transfer", path: "/suites?suite=viral&sp=motion", minSpend: 0, strict: true, allowedUnmarked: 1, ...D0 },
  { name: "Viral · Object Swap", path: "/suites?suite=viral&sp=swap", minSpend: 0, strict: true, allowedUnmarked: 1, ...D0 },
  { name: "Business · Image ads", path: "/suites?suite=business&sp=dtc", minSpend: 0, strict: false, allowedUnmarked: 1, ...BOARD },
  { name: "Atomik · Agent", path: "/suites?suite=atomik&sp=agent", minSpend: 0, strict: false, allowedUnmarked: 0, ...BOARD },
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
    const name = (el: Element) => `${el.getAttribute("data-testid") ?? ""} "${(el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)}" <${el.tagName.toLowerCase()}${el.getAttribute("role") ? ` role=${el.getAttribute("role")}` : ""} in ${el.closest("header,nav,[role=tablist],aside")?.tagName.toLowerCase() ?? "page"}.${el.closest("header,nav,[role=tablist],aside")?.className ?? ""}>`.trim();
    const marked = Array.from(document.querySelectorAll("[data-spend]")).filter(visible);
    const noPrice = marked.filter((el) => {
      const text = `${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
      if (figureRe.test(text)) return false;
      const disabled = (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true";
      return !(el.getAttribute("data-spend") === "unpriced" && disabled) && el.getAttribute("aria-busy") !== "true";
    }).map(name);
    const unmarked = Array.from(document.querySelectorAll("button, [role=button]")).filter(visible).filter((el) => {
      if (el.closest("[data-spend]")) return false;
      /* A tab switches what is shown ("Make" | "Recent"); it never starts anything. */
      if (el.getAttribute("role") === "tab") return false;
      /* Neither does a destination in a navigation bar (the phone's Home · Record · Make · Atomik): it goes somewhere. */
      if (el.closest("nav")) return false;
      const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
      return verbRe.test(label);
    }).map(name);
    return { marked: marked.length, noPrice, unmarked };
  }, { figure: { source: CREDIT_FIGURE.source, flags: CREDIT_FIGURE.flags }, verb: { source: SPEND_LABEL.source, flags: SPEND_LABEL.flags } });
}

for (const probe of PROBES) {
  test(`${probe.strict ? "STRICT" : "RATCHET"} · ${probe.name}: every button that spends shows a price in credits`, async ({ page }) => {
    await open(page, probe.path);
    const found = await read(page);
    if (process.env.SPEND_PROBE_REPORT) appendFileSync(process.env.SPEND_PROBE_REPORT, JSON.stringify({ probe: probe.name, path: probe.path, ...found }) + "\n");
    /* A marked control with no credit figure is never allowed. */
    expect(found.noPrice, "controls marked data-spend with no credit figure (and not disabled-unpriced)").toEqual([]);
    const due = past(probe.until);
    const detail = `${probe.by}, until ${probe.until}`;
    expect(found.unmarked.length, `buttons labelled like a paid action that carry no data-spend (allowed ${probe.allowedUnmarked} until ${probe.until}: ${detail}):\n${found.unmarked.join("\n")}`).toBeLessThanOrEqual(due ? 0 : probe.allowedUnmarked);
    if (due) expect(found.marked, `a page with a paid control carries at least ${probe.minSpend} data-spend control(s)`).toBeGreaterThanOrEqual(probe.minSpend);
    else test.info().annotations.push({ type: "to-do", description: `${found.unmarked.length} unmarked, ${found.marked} marked (needs ${probe.minSpend}); ${detail}` });
  });
}
