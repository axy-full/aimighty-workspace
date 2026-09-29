import { getBoard, markBoardImported, type Board } from "@/lib/boards";
import { db } from "@/lib/db";
import { effectiveModels } from "@/lib/defaultModels";
import { getElements, type ElementFull } from "@/lib/elements";
import { attributesOf, isVisual } from "@/lib/rig";
import { applyCanvasOps } from "./canvas-ops";
import type { RoomClient } from "./canvas-push";
import { readTeamCanvas, requireProduction, teamCanvasReady, TeamCanvasError } from "./team-canvas";
import { emptyTeamCanvas } from "./team-canvas-model";
import type { Asset } from "./studio";
import {
  importSummary, mediaCandidates, planBoardImport, readBoardGraph,
  type BoardGraph, type ImportContext, type ImportElement, type ImportLimits, type ImportSummary, type MediaRef,
} from "./board-import-model";

/*
 * Opening an old Rig board in the new Rig: one bounded batch per call (the plan
 * is lib/workbench/board-import-model.ts). The board, the elements its asset
 * cards cite and the stored media they could show are read here; the batch is
 * applied through applyCanvasOps, the one way the server changes a team canvas,
 * so it is logged (`import`), pushed to the live room, and every open window
 * sees the cards arrive. The board row records when its cards last came across
 * and where (imported_at, imported_to); nothing else on the board is written.
 * Free: nothing is quoted, reserved or charged, and no provider is called.
 */

export type BoardImportAnswer = ImportSummary & {
  /** What this call brought across. */
  brought: { cards: number; wires: number };
  /** "sent": the live room has it; "waiting": it goes out again until it lands; "off": no live room (windows check every few seconds). */
  live: "sent" | "waiting" | "off";
  credits: 0;
};

const assetKind = (value: unknown): Asset["kind"] => (value === "video" || value === "audio" || value === "document" ? value : "image");

/** An element's picture: the current, ready version of its first visual attribute that has one (a face, a plate, a turntable, a look). */
export function elementPicture(element: Pick<ElementFull, "kind" | "attributes">): MediaRef | null {
  const order = [...attributesOf(element.kind), ...element.attributes.map((attribute) => attribute.kind)];
  for (const kind of new Set(order)) {
    if (!isVisual(kind)) continue;
    for (const attribute of element.attributes.filter((a) => a.kind === kind && a.currentId)) {
      const version = attribute.versions.find((v) => v.id === attribute.currentId && v.status === "ready");
      if (version?.uploadId) return { source: "upload", id: version.uploadId };
      if (version?.genId) return { source: "generation", id: version.genId };
    }
  }
  return null;
}

/** Which of these uploads and generations exist and may be shown: every one a card shows is checked again when a draft saves. */
async function storedMedia(wanted: { uploads: string[]; generations: string[] }): Promise<Map<string, Asset["kind"]>> {
  const media = new Map<string, Asset["kind"]>();
  const read = async (ids: string[], sql: (holes: string) => string, source: MediaRef["source"]) => {
    for (let start = 0; start < ids.length; start += 400) {
      const batch = ids.slice(start, start + 400);
      const rows = (await db().execute({ sql: sql(batch.map(() => "?").join(",")), args: batch })).rows;
      for (const row of rows) media.set(`${source}:${String(row.id)}`, assetKind(row.kind));
    }
  };
  await read(wanted.uploads, (holes) => `SELECT id, kind FROM uploads WHERE id IN (${holes})`, "upload");
  await read(wanted.generations, (holes) => `SELECT id, kind FROM generations WHERE id IN (${holes}) AND deleted = 0 AND status = 'succeeded'`, "generation");
  return media;
}

async function importContext(board: Board, graph: BoardGraph): Promise<ImportContext> {
  const cited = graph.nodes.flatMap((node) => (node.kind === "asset" && typeof node.ref?.elementId === "string" ? [node.ref.elementId] : []));
  const elements = new Map<string, ImportElement>();
  for (const element of await getElements(cited))
    elements.set(element.id, { kind: element.kind, name: element.name, description: element.description, picture: elementPicture(element) });
  const media = await storedMedia(mediaCandidates(graph, elements));
  const models = await effectiveModels().catch(() => null);
  return { boardId: board.id, boardName: board.name, elements, media, ...(models ? { models: { image: models.image, video: models.video } } : {}) };
}

/**
 * Brings the next batch of an old board's cards and inputs across onto its
 * production's team canvas, and says where the import stands. Idempotent and
 * resumable: call it again until `done`; a call with nothing left to bring
 * changes nothing. `author` is the person asking (their user id).
 */
export async function importBoardBatch(productionId: string, boardId: string, author: string, options: { room?: RoomClient | null; limits?: ImportLimits } = {}): Promise<BoardImportAnswer> {
  await requireProduction(productionId);
  const board = await getBoard(boardId);
  if (!board) throw new TeamCanvasError("That board is not in this workspace.", 404);
  if (board.projectId !== productionId) throw new TeamCanvasError("That board belongs to another production. Open that production’s Rig to bring it across.", 409);
  await teamCanvasReady();
  const graph = readBoardGraph(board);
  const before = (await readTeamCanvas(productionId))?.canvas ?? emptyTeamCanvas();
  const batch = planBoardImport(before, graph, await importContext(board, graph), author, options.limits);
  let live: BoardImportAnswer["live"] = "off", changed = 0;
  if (batch.opId) {
    const result = await applyCanvasOps(productionId, { opId: batch.opId, ops: batch.ops, author, what: "import" }, { room: options.room });
    live = result.live;
    changed = result.changed;
  }
  const after = (await readTeamCanvas(productionId))?.canvas ?? before;
  const was = importSummary(before, graph, board), now = importSummary(after, graph, board);
  /* The record on the board: when its cards last came across, and where. Its own nodes, wires and revision are never written. */
  if (changed || (now.done && (board.importedTo !== productionId || board.importedAt == null))) await markBoardImported(board.id, productionId);
  return { ...now, brought: { cards: Math.max(0, now.cards.here - was.cards.here), wires: Math.max(0, now.wires.here - was.wires.here) }, live, credits: 0 };
}
