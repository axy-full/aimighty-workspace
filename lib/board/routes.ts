import type { ScreenModule } from "@/lib/shell/screens";
import { STAGE_ROWS } from "@/lib/shell/stage-redirects";

/**
 * The board (stream 3): `?view=board`, with `kind`, `region`, `list`, `drawer`, `review`, `start` (a hint from Home) and the design's
 * `frame` letters. Seeded by the shell (stream 1); stream 3 owns this file from here and flipped `landed` in the PR that
 * lands BoardView. Ads and Social boards are the same entry with `kind` (lib/shell/ads-social.ts).
 */
export const BOARD_SCREEN: ScreenModule = {
  id: "board",
  landed: true,
  params: ["kind", "frame", "list", "region", "drawer", "review", "start"],
  /* Old → new. Each old Studio stage is a region of the board (README § 1.2); the Rig is the board itself. The table is
     lib/shell/stage-redirects.ts: the pages are gone, so this is for every workspace and has no way back. */
  rows: [
    ...STAGE_ROWS,
    /* Crew: the room is the board's Crew review (frame m), its sessions the Project record (frame n). */
    { from: "?view=crew&cp=room", to: "?view=board&frame=m" },
    { from: "?view=crew&cp=members", to: "?view=board&frame=m" },
    { from: "?view=crew&cp=sessions", to: "?view=board&frame=n" },
  ],
  /* The old pages are deleted, so nothing falls back to one. */
  fallback: [],
};
