import { expect, type Page } from "@playwright/test";
import { signInToRedesign } from "./newInterface";
import { signInLocally } from "./workbenchLocal";
import { forbidPaidWork, mockMedia } from "./workspaceFixtures";
import { seedBoard } from "./gaps-l2";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { BeatSheet } from "../../lib/production/beats";
import type { Boards } from "../../lib/production/boards";

/**
 * A Film board for the new interface's board specs (components/v12/board/, item P2-a), saved through the real projects
 * route: a brief and a look, two characters, a place and a prop, eight storyboard shots (five drawn, one drawing), and
 * four shots on the canvas. Neutral names only (CLAUDE.md rule 3). Stored media answer with the repo's sample stills.
 */
const node = (id: string, type: CanvasNode["type"], title: string, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title, type, x: 0, y: 0, width: 254, linked: [], ...extra });

const SHOTS = [
  ["Wide", "The harbour at first light, boats still tied up."],
  ["Medium", "She walks the quay with a coffee."],
  ["Close-up", "Hands untie a rope."],
  ["Wide", "The boat pulls away from the quay."],
  ["Insert", "A gull lands on the railing."],
  ["Medium", "She checks the horizon."],
  ["Close-up", "The engine catches."],
  ["Extreme wide", "The boat small on open water."],
] as const;

function beats(): BeatSheet {
  return {
    scriptSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", updatedAt: new Date().toISOString(),
    scenes: [{
      id: "scene-a", heading: "EXT. HARBOUR - DAWN", summary: "", beats: [], characters: [], locations: [], props: [],
      shots: SHOTS.map(([framing, description], i) => ({ id: `shot-${i + 1}`, description, framing, movement: "Held · 35mm", lighting: "", sound: "", duration: 3 })),
    }],
  };
}

function boards(): Boards {
  const frames: Boards["frames"] = {};
  for (let i = 1; i <= 8; i++) {
    if (i <= 5) frames[`shot-${i}`] = { prompt: SHOTS[i - 1][1], takes: [{ genId: `gframe${i}`, style: "live", at: new Date().toISOString() }] };
    else if (i === 6) frames[`shot-${i}`] = { prompt: SHOTS[i - 1][1], takes: [], pending: [{ jobId: "job-frame6", style: "live", at: new Date().toISOString() }] };
  }
  return { style: "live", model: "gemini-3.1-flash-image", frames };
}

export function filmBoard(): Project {
  return {
    ...newProject("Harbour film"),
    brief: "A short film about a harbour waking up.",
    production: { beats: beats(), boards: boards() },
    nodes: [
      node("node-brief01", "brief", "The brief", { text: "A harbour wakes up; one boat leaves." }),
      node("node-look0001", "moodboard", "Morning light", { text: "Low sun, cool water." }),
      node("node-cast0001", "character", "Skipper", { refKind: "cast" }),
      node("node-cast0002", "character", "Deckhand", { refKind: "cast" }),
      node("node-place001", "element", "The quay", { refKind: "environment" }),
      node("node-prop0001", "element", "Brass bell", { refKind: "element" }),
      node("node-shot0001", "scene", "Opening wide", { text: SHOTS[0][1] }),
      node("node-shot0002", "scene", "The walk", { text: SHOTS[1][1] }),
      node("node-shot0003", "scene", "The rope", { text: SHOTS[2][1] }),
      node("node-shot0004", "scene", "Leaving", { text: SHOTS[3][1] }),
    ],
  };
}

/** Signs in (switch on unless `on: false`), saves the board, and opens `path` (default: the board). */
export async function openBoard(page: Page, path = "/suites?view=board", opts: { on?: boolean; project?: Project } = {}) {
  const signed = opts.on === false ? await signInLocally(page.request, "Board Tester") : await signInToRedesign(page.request, "Board Tester");
  if (opts.on !== false) await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { newInterface?: boolean } }).workspace?.newInterface ?? false, { timeout: 30_000 }).toBe(true);
  /* The drawn frames' takes are rows in the workspace's own local database (nothing is generated): gaps-l2's seedBoard. */
  const film = opts.project ?? filmBoard();
  const { project, scope } = await seedBoard(page, signed.workspace.id, (base) => ({ ...base, name: film.name, brief: film.brief, production: film.production, nodes: film.nodes, ...(film.boardKind ? { boardKind: film.boardKind } : {}), ...(film.boardFlavor ? { boardFlavor: film.boardFlavor } : {}), ...(film.boardStages ? { boardStages: film.boardStages } : {}) }),
    { generations: [1, 2, 3, 4, 5].map((i) => `gframe${i}`) });
  await forbidPaidWork(page);
  await mockMedia(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return { project, errors, scope };
}
