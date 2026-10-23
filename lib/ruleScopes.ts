/**
 * Where a prompt rule applies, and how a person reads it: the part of the platform layer (lib/platformLayer.ts, which re-exports it)
 * a browser needs. Kept on its own so a page that draws the rules does not bundle the platform layer, which carries the verified text
 * catalogue and the text jobs' models (a model behind Atomik's thinking is never sent to a person, Amendment (iii) §E).
 */

/** Where a rule applies: a kind, or one engine family's dialect. */
export type RuleScope = "all" | "video" | "image" | "seedance-2" | "kling-3" | "nano-banana";
export const RULE_SCOPES: RuleScope[] = ["all", "video", "image", "seedance-2", "kling-3", "nano-banana"];
export const RULE_SCOPE_LABELS: Record<RuleScope, string> = {
  all: "video + stills", video: "video", image: "stills", "seedance-2": "Seedance only", "kling-3": "Kling only", "nano-banana": "Nano Banana only",
};
export type RuleApply = "writer" | "prompt";
