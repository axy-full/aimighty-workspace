import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, PHONE } from "./helpers/workspaceFixtures";
import { newProject } from "../lib/workbench/studio";

/*
 * Release 1 CI, C2 · Atomik's "I can open the Library for you" offer. The answer to "How do I add a reference to a shot?"
 * promises the Library; Home and the control room have none, and the board's Library is its rail drawer, so the offer
 * must put that drawer on screen (opening the project's board first where there is none). Nothing is made or sent:
 * the how-to answer is free and forbidPaidWork fails any paid request. A phone's sheet maps the same offer to Make's
 * reference picker (components/graphite/phone/AtomikSheet.tsx › runOffer), measured by demo-s10-phone-make-workbench.
 */

async function setUp(page: Page) {
  const workspaceId = (await signInLocally(page.request, "Offer Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = { ...newProject("Offer fixture"), brief: "A short film about a morning market opening." };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await forbidPaidWork(page);
  const paid: string[] = [];
  page.on("request", (r) => { const path = new URL(r.url()).pathname; if (r.method() === "POST" && /^\/api\/atomik\/[^/]+$/.test(path) && new URL(r.url()).pathname.split("/")[3] !== "memory") { const body = r.postDataJSON() as { quoteOnly?: boolean } | null; if (body?.quoteOnly !== true) paid.push(path); } });
  return { project, paid };
}

const OFFER_TEXT = "Drag anything from the Library onto the shot, or press + in Make’s references tray. I can open the Library for you.";

for (const [where, path] of [["Home", (id: string) => `/suites?project=${id}&view=home&atomik=how`], ["the board", (id: string) => `/suites?project=${id}&view=board&atomik=how`], ["the control room", (id: string) => `/suites?project=${id}&suite=atomik&page=approvals&atomik=how`]] as const) {
  test(`${where}: the Library offer puts the board's Library on screen`, async ({ page }, info) => {
    test.skip(PHONE.includes(info.project.name), "a phone's sheet maps this offer to Make's reference picker (demo-s10-phone-make-workbench)");
    const { project, paid } = await setUp(page);
    await page.goto(path(project.id));
    const panel = page.getByTestId("atomik-panel-global");
    const lines = panel.getByTestId("atomik-line");
    await expect(lines.nth(1)).toContainText(OFFER_TEXT);
    await expect(page.getByTestId("board-library")).toHaveCount(0);
    await panel.getByTestId("atomik-offer").click();
    await expect(page.getByTestId("board-library")).toBeVisible();
    await expect(page).toHaveURL(/view=board/);
    /* Atomik stays where it was: the answer is still there beside the board. */
    await expect(panel).toBeVisible();
    expect(paid, "no paid Atomik request").toEqual([]);
  });
}
