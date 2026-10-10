import { getWorkspace } from "@/lib/platform";
import { runInTenant } from "@/lib/tenant";
import { readDraft, workbenchReady } from "@/lib/workbench/records";
import { readSampleBoard } from "@/lib/demo/board.server";
import { readSampleMark } from "@/lib/demo/mark.server";
import { readSite } from "@/lib/site/settings.server";
import { guestBoard } from "./board";
import { SAMPLE_TITLE, cleanSampleTitle, type GuestSample } from "./sample";

/**
 * What a signed-out visitor may read: the sample production, from the ONE workspace the platform owner named in
 * /admin (lib/site/settings.ts › guestWorkspace, the public "Particl sample" workspace, never the house), and only while
 * Guest Home is on. The workspace comes only from the site row, never from the request, so no visitor can point it
 * elsewhere; the read runs inside that workspace's tenant scope and nowhere else.
 *
 * It reads through stream 12's own reader (lib/demo/board.server.ts › readSampleBoard: the production's plan at the
 * credits the ledger recorded, the owner's cast wording, the cut) plus the finished draft's brief and frame, and
 * shapes them for the page (lib/guest/board.ts). No person, no balance, no vendor figure, no id and no media is returned.
 * The media of the sample's takes and stills follows stream 12's media route (decision 38); until then the board shows
 * its shots, plan, cast and cut as words.
 *
 * Null when there is nothing to show (Guest Home off, no workspace named, the workspace gone, no sample marked, or
 * anything unreadable): the page then shows the frames' layout with "A 15-second film".
 */
export async function guestSample(): Promise<GuestSample | null> {
  const site = await readSite();
  if (!site.guestHome || !site.guestWorkspace) return null;
  try {
    const ws = await getWorkspace(site.guestWorkspace);
    if (!ws || ws.deletedAt != null) return null;
    return await runInTenant(ws, async () => {
      const mark = await readSampleMark();
      if (!mark) return null;
      await workbenchReady();
      const [board, draft] = await Promise.all([readSampleBoard(), readDraft(mark.draftOwner, mark.draftId)]);
      /* A mark whose finished draft is not in this workspace (or not any more) is no sample. */
      if (!board || !draft) return null;
      const project = draft.project;
      return {
        title: cleanSampleTitle(mark.name) ?? SAMPLE_TITLE,
        board: guestBoard({ brief: project.brief, aspect: project.aspect, fps: project.fps, board }),
      };
    });
  } catch {
    return null;
  }
}
