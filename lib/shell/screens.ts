/* LOCAL STUB (stream 9, never committed): stream 1 owns lib/shell/screens.ts. Types from S/demo/s01-plan.md § 3. */
export type ScreenId = "home" | "board" | "board-ads" | "board-social" | "make" | "atomik" | "control-room" | "settings" | "phone";
export type Row = { from: string; to: string };
export type ScreenModule = {
  id: ScreenId;
  landed: boolean;
  params: readonly string[];
  rows: readonly Row[];
  fallback: readonly Row[];
  normalize?: (q: URLSearchParams) => boolean;
};
