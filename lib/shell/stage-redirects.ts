import type { Row } from "./screen-rows";

/**
 * The ten Studio stage pages the board replaced (owner decision, 5 Oct night: the canvas is the whole production).
 * They no longer exist as pages: every address that named one opens the board, on the region that took over its job.
 * Pure, with no imports of its own, so the server, the client, the shell's `goSuite` and the unit specs read one table.
 *
 * `from` is the app's spelling (the design file's `?suite=studio&page=env` is rewritten to it first, lib/shell/ia.ts ›
 * normalize); `to` is the board's address. Every other param (`project`, `asset`, `make`, `atomik`…) rides along, so a link
 * to a project keeps its project.
 */
export type StageId = "brief" | "beats" | "boards" | "environment" | "cast" | "astra" | "rig" | "takes" | "edit" | "deliver";

/**
 * `label` is the name the Studio overview's card carries (no retired names: the Rig is the board, Astra 3D is 3D blocking);
 * `place` is what the board calls where the stage went, which a toast's Open names ("Open Shots").
 */
export type StageRedirect = { id: StageId; label: string; place: string; from: string; to: string };

export const STAGE_REDIRECTS: readonly StageRedirect[] = [
  { id: "brief", label: "Brief", place: "Brief", from: "?suite=particl&page=brief", to: "?view=board&region=brief" },
  { id: "beats", label: "Beats", place: "Storyboard", from: "?suite=particl&page=brief&sp=beats", to: "?view=board&region=storyboard" },
  { id: "boards", label: "Storyboards", place: "Storyboard", from: "?suite=particl&page=boards", to: "?view=board&region=storyboard" },
  { id: "environment", label: "Environment", place: "Cast", from: "?suite=particl&page=boards&sp=environment", to: "?view=board&region=cast" },
  { id: "cast", label: "Cast & Elements", place: "Cast", from: "?suite=particl&page=cast", to: "?view=board&region=cast" },
  { id: "astra", label: "3D blocking", place: "Shots", from: "?suite=particl&page=astra", to: "?view=board&region=shots" },
  { id: "rig", label: "Board", place: "Board", from: "?suite=particl&page=rig", to: "?view=board" },
  { id: "takes", label: "Takes", place: "Shots", from: "?suite=particl&page=takes", to: "?view=board&region=shots" },
  { id: "edit", label: "Edit & Sound", place: "Cut", from: "?suite=particl&page=edit", to: "?view=board&region=cut" },
  { id: "deliver", label: "Deliver", place: "Deliver", from: "?suite=particl&page=deliver", to: "?view=board&region=deliver" },
];

/** Sub-views of two stages that have a board form of their own: the Rig's List view, and the Beats node graph (the board itself). */
const EXTRA: readonly Row[] = [
  { from: "?suite=particl&page=rig&rig=list", to: "?view=board&list=1" },
  { from: "?suite=particl&page=brief&sp=beats&beats=graph", to: "?view=board" },
];

/** A page id names its suite (lib/workspace/navigation.ts › fromSearch: the page is the more specific claim), so a link may leave `suite` out. */
const withoutSuite = (from: string) => from.replace("?suite=particl&", "?");

/**
 * The screen registry's rows for the old stage addresses (lib/board/routes.ts), applied for every workspace. Each is there twice, with
 * and without `suite=particl`: a copied take link (`?page=takes&sp=takes&ws=…&asset=…`) never named its suite. The longer one wins
 * where both match (lib/shell/screen-rows.ts), so `suite` leaves with the page.
 */
export const STAGE_ROWS: readonly Row[] = [...STAGE_REDIRECTS.map(({ from, to }) => ({ from, to })), ...EXTRA]
  .flatMap((row) => [row, { from: withoutSuite(row.from), to: row.to }]);

export function isStageId(value: unknown): value is StageId {
  return typeof value === "string" && STAGE_REDIRECTS.some((stage) => stage.id === value);
}

/** What the board calls the place a stage went to. */
export function stagePlace(id: StageId): string {
  return STAGE_REDIRECTS.find((stage) => stage.id === id)!.place;
}

/** The board address for a stage id: `?view=board`, with the region that took the stage's job. */
export function stageAddress(id: StageId): string {
  return STAGE_REDIRECTS.find((stage) => stage.id === id)!.to;
}
