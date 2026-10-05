import { expect, type Page } from "@playwright/test";
import { signInLocally } from "./workbenchLocal";
import { newProject, type CanvasNode } from "../../lib/workbench/studio";

/* Stream 3's browser specs share this: a signed-in local workspace and a production with today's canvas nodes. Neutral names only. */
export const SHOTS = process.env.S03_SHOTS || "/private/tmp/claude-s03-shots";

export const node = (id: string, type: CanvasNode["type"], title: string, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title, type, x: 0, y: 0, width: 254, linked: [], ...extra });

export async function seedBoard(page: Page, more: CanvasNode[] = []) {
  const workspaceId = (await signInLocally(page.request, "Board Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = {
    ...newProject("Board fixture"),
    brief: "A short film about a morning market opening.",
    nodes: [
      node("node-brief01", "brief", "The brief", { text: "A morning market opens; light comes up on the stalls." }),
      node("node-look0001", "moodboard", "Morning light", { text: "Low sun, warm stalls." }),
      node("node-cast0001", "character", "Lead", { refKind: "cast" }),
      node("node-place001", "element", "The market", { refKind: "environment" }),
      node("node-shot0001", "scene", "Opening wide", { text: "Wide on the empty market at first light.", linked: ["node-look0001"] }),
      node("node-shot0002", "scene", "The first stall", { text: "Hands lift the shutter of the first stall." }),
      node("node-grade001", "grade", "Colour", { linked: ["node-shot0001"] }),
      node("node-note0001", "note", "Note", { text: "Keep the camera low.", x: 96, y: 72 }),
      ...more,
    ],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId: productionId } = await saved.json() as { productionProjectId?: string };
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || path.startsWith("/api/generate/"))) paid.push(path);
  });
  return { project, paid, productionId: productionId ?? null, headers: { "X-Workbench-Scope": scope } };
}

export const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;

