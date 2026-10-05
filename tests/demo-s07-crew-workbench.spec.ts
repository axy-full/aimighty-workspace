import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { seedBoard, desktop } from "./helpers/s03-board";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTextIn } from "./helpers/s07Floors";

/*
 * Stream 7 · Crew review in the docked panel (README § 3.1 m; an old Crew link, ?view=crew&cp=room, lands on it).
 * Real local ENGINE_MOCK=1 server: the room is today's crew (the mock answers, nothing real is asked). "Ask the crew ·
 * up to N cr" is the round's own quote and its approval; what comes back are the room's solutions, to dismiss, add to
 * the brief (free) or open in Make (which shows its own price). Nothing is made here. Neutral names only. Desktop only.
 */
const SHOTS = process.env.S07_SHOTS || "/private/tmp/claude-s07-shots";
const shot = async (page: Page, name: string, info: { project: { name: string } }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace(/^workbench-/, "")}.png` });
};

test("Crew review: an old Crew link lands on it; the crew is asked at its quote, and a note goes to the brief or to Make", async ({ page }, info) => {
  test.skip(!desktop(page), "the board canvas is desktop only (phones open the project's Record, stream 10)");
  const { project } = await seedBoard(page);
  await forbidPaidWork(page);
  const posted: { url: string; body: Record<string, unknown> | null }[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname.startsWith("/api/crew")) posted.push({ url: new URL(r.url()).pathname, body: (r.postDataJSON() as Record<string, unknown> | null) ?? null }); });
  await page.goto(`/suites?project=${project.id}&view=crew&cp=room`);
  await expect(page).toHaveURL(/view=board/);
  const dock = page.getByTestId("board-agent-dock");
  await expect(async () => {
    if ((await dock.getAttribute("data-open")) !== "true") await dock.getByTestId("agent-rail").click({ timeout: 3000 });
    await expect(dock).toHaveAttribute("data-open", "true", { timeout: 3000 });
    await expect(page.getByTestId("crew-review").getByTestId("crew-member").first()).toBeVisible({ timeout: 8000 });
  }).toPass({ timeout: 90_000 });
  const crew = page.getByTestId("crew-review");
  await expect(crew.getByTestId("crew-member").first()).toHaveAttribute("aria-pressed", "true");
  /* The button wears the round's own price and nothing is asked until it is pressed. */
  const ask = crew.getByTestId("crew-ask");
  await expect(ask).toHaveText(/^Ask the crew · up to [\d.,]+ cr$/, { timeout: 30_000 });
  expect(posted.filter((p) => /rounds/.test(p.url))).toEqual([]);
  expect(await smallTextIn(page, ".ag"), "text under 12 px").toEqual([]);
  await shot(page, "crew-ask", info);
  const label = (await ask.innerText()).match(/up to ([\d.,]+) cr/)![1];

  await ask.click();
  /* The press is the approval of exactly that figure, for one round. */
  await expect.poll(() => posted.find((p) => /\/rounds$/.test(p.url))?.body?.maxCredits ?? null, { timeout: 30_000 }).toBe(Number(label.replace(/,/g, "")));
  expect(posted.find((p) => /\/rounds$/.test(p.url))?.body?.round).toBe(1);
  const note = crew.getByTestId("crew-note").first();
  await expect(note).toBeVisible({ timeout: 90_000 });
  expect(await smallTextIn(page, ".ag"), "text under 12 px").toEqual([]);
  await shot(page, "crew-notes", info);

  /* A note to the brief: free. Another to Make: Make opens with the words filled, and nothing is made. */
  await note.getByTestId("crew-brief").click();
  await expect(crew.getByTestId("crew-note")).not.toHaveCount(0);
  await crew.getByTestId("crew-note").first().getByTestId("crew-make").click();
  await expect(page.getByTestId("gen-prompt")).not.toHaveValue("");
});
