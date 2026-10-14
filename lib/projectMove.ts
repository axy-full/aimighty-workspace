import type { InStatement, ResultSet } from "@libsql/client";
import { isDraftProject, ownsDraftProject } from "./draftProject";
import { assertUploadsOpenable, currentViewer, type Viewer } from "./uploadAccess";
import { MediaSourceError, referencedMedia } from "./mediaBindings";

/**
 * Moving a record between projects changes who may open the uploads it names, without adding a reference (lib/uploadAccess.ts: a record in a draft's own
 * project `prj_wb_…` shares nothing, anywhere else it does). So a move is asked like an addition, and a draft's records have a private origin:
 *
 *  - a record in a draft's own project is moved out of it only by that draft's owner;
 *  - a record that lands outside a draft's project (including "no project") names only uploads the person moving it can open.
 *
 * Refused as the record being unknown is, so nothing says it exists. Background work and Atomik runs (no signed-in person) are not asked.
 */
type Exec = { execute(statement: InStatement): Promise<ResultSet> };
export class MoveRefused extends MediaSourceError {}

export async function assertMoveAllowed(ex: Exec, move: { from: string | null; to: string | null; named: readonly unknown[] }, viewer: Viewer | null = currentViewer()): Promise<void> {
  if (!viewer || move.from === move.to) return;
  if (isDraftProject(move.from) && !(await ownsDraftProject(viewer.id, move.from!, ex))) throw new MoveRefused("Not found");
  if (isDraftProject(move.to)) return;
  const uploads = new Set<string>();
  for (const value of move.named) for (const id of referencedMedia(value).uploads) uploads.add(id);
  try { await assertUploadsOpenable(ex, uploads, viewer); }
  catch { throw new MoveRefused("Not found"); }
}

/** The JSON a take or shot holds that can name uploads. */
export const parseJson = (text: unknown): unknown => { try { return JSON.parse(String(text ?? "null")); } catch { return null; } };
