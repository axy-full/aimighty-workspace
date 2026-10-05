import type { ScreenModule } from "@/lib/shell/screens";

/**
 * The board (stream 3): `?view=board`, with `kind`, `region`, `list`, `drawer`, `review`, `start` (a hint from Home) and the design's
 * `frame` letters. Seeded by the shell (stream 1); stream 3 owns this file from here and flipped `landed` in the PR that
 * lands BoardView. Ads and Social boards are the same entry with `kind` (lib/shell/ads-social.ts).
 */
export const BOARD_SCREEN: ScreenModule = {
  id: "board",
  landed: true,
  always: true,
  params: ["kind", "frame", "list", "region", "drawer", "review", "start"],
  /* Old → new. Each old Studio stage is a region of the board (README § 1.2); the Rig is the board itself. */
  rows: [
    { from: "?suite=particl&page=rig", to: "?view=board" },
    { from: "?suite=particl&page=rig&rig=list", to: "?view=board&list=1" },
    { from: "?suite=particl&page=brief&sp=beats&beats=graph", to: "?view=board" },
    { from: "?suite=particl&page=brief", to: "?view=board&region=brief" },
    { from: "?suite=particl&page=brief&sp=beats", to: "?view=board&region=storyboard" },
    { from: "?suite=particl&page=boards", to: "?view=board&region=storyboard" },
    { from: "?suite=particl&page=boards&sp=environment", to: "?view=board&region=cast" },
    { from: "?suite=particl&page=cast", to: "?view=board&region=cast" },
    { from: "?suite=particl&page=takes", to: "?view=board&region=shots" },
    { from: "?suite=particl&page=astra", to: "?view=board&region=shots" },
    { from: "?suite=particl&page=edit", to: "?view=board&region=cut" },
    { from: "?suite=particl&page=deliver", to: "?view=board&region=deliver" },
    /* Crew: the room is the board's Crew review (frame m), its sessions the Project record (frame n). */
    { from: "?view=crew&cp=room", to: "?view=board&frame=m" },
    { from: "?view=crew&cp=members", to: "?view=board&frame=m" },
    { from: "?view=crew&cp=sessions", to: "?view=board&frame=n" },
  ],
  /* New → today's page: the region's old stage, or the Rig for the board itself. */
  fallback: [
    { from: "?view=board", to: "?suite=particl&page=rig" },
    { from: "?view=board&list=1", to: "?suite=particl&page=rig&rig=list" },
    { from: "?view=board&region=brief", to: "?suite=particl&page=brief" },
    { from: "?view=board&region=storyboard", to: "?suite=particl&page=boards" },
    { from: "?view=board&region=cast", to: "?suite=particl&page=cast" },
    { from: "?view=board&region=shots", to: "?suite=particl&page=takes" },
    { from: "?view=board&region=cut", to: "?suite=particl&page=edit" },
    { from: "?view=board&region=deliver", to: "?suite=particl&page=deliver" },
    { from: "?view=board&frame=m", to: "?view=crew&cp=room" },
    { from: "?view=board&frame=n", to: "?view=crew&cp=sessions" },
  ],
};
